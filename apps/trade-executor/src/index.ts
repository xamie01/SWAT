import { pathToFileURL } from 'node:url';
import { DelayedError, UnrecoverableError, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import {
  DEFAULT_RISK_CONFIG,
  fetchTokenPriceUsd,
  getJupiterSimulatedFill,
  initLogger,
  isChain,
  REDIS_CHANNELS
} from '@swat/shared';
import type { Chain, JupiterSimulatedFill } from '@swat/shared';
import {
  claimCircuitBreakerProbe,
  claimSourceSignalForCopyExecution,
  claimSignalForExecution,
  getRollingExposureUsd,
  getCopyExecutionByClientOrderIdentity,
  getCopyExecutionBySubmissionIdentity,
  getTokenDecimals,
  hasRecentBuy,
  insertTrade,
  insertTradeAndMarkSignalExecuted,
  insertTradeAndReleaseSignalClaim,
  pool,
  query,
  readCircuitBreakerState,
  recordCopyExecutionEvidence,
  recordCircuitBreakerFailure,
  recordCircuitBreakerSuccess,
  releaseSignalClaim,
  resolveChainMode,
  transitionCopyExecution,
  type CopyExecutionRecord
} from '@swat/db';
import {
  calculateBalanceAwareSize,
  capPositionToAvailableBalance,
  parseNonNegativeNumber,
  parsePositiveNumber,
  parseScore
} from './policy.js';
import { fetchSolanaBalanceSol } from './balances.js';
import {
  configureRobinhoodRuntime,
  createViemRobinhoodAdapter,
  getRobinhoodLiveReadiness,
  getRobinhoodSpendableEth,
  getRobinhoodQuote,
  parseRobinhoodExecutionConfig,
  reconcileRobinhoodPending,
  robinhoodPublicClient,
  triggerRobinhood,
  evmAccount,
  WETH_ROBINHOOD,
  type RobinhoodExecutionAdapter,
  type RobinhoodExecutionConfig,
  type RobinhoodPendingStore,
  type RobinhoodReconciliationOutcome
} from './robinhood.js';
import {
  configureRobinhoodOpsAlertEmitter,
  verifyRobinhoodEnvironment
} from './robinhood-startup.js';
import {
  createRedisRobinhoodPendingStore,
  createRobinhoodSafetyAssessment
} from './robinhood-runtime.js';
import {
  triggerPolymarket,
  pollPolymarketOrders,
  getPolymarketAskPrice,
  getPolymarketAvailableBalance,
  getPolymarketLiveReadiness
} from './polymarket.js';
import { polymarketSigner, resolvePolymarketIdentity } from './polymarket.js';
import { OrderSide } from '@polymarket/client';
import { verifyPolymarketEnvironment } from './polymarket-startup.js';
import { formatUnits, parseAbi } from 'viem';
import {
  configureTrojanRuntime,
  createTrojanRuntimeFromEnvironment,
  getTrojanLiveReadiness,
  setTrojanRuntimeUnavailable,
  triggerTrojan,
  type TrojanRuntime,
  type TrojanTerminalResolution
} from './trojan-runtime.js';
import type { TrojanReconciliationResult } from './trojan.js';
import {
  decimalQuantityToBaseUnits,
  executionModesForChainMode,
  resolvePaperCopyTargetAccount,
  sourceSellFractionToBps
} from './canonical-copy.js';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
let redis: Redis | null = null;

function getRedis(): Redis {
  if (!redis) redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
  return redis;
}

const SOL_MINT = 'So11111111111111111111111111111111111111112';

const TROJAN_WALLET_ADDRESS = process.env.TROJAN_WALLET_ADDRESS;
const JUPITER_API_KEY = process.env.JUPITER_API_KEY || undefined;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

const BASE_POSITION_SOL = parseFloat(process.env.BASE_POSITION_SOL ?? '0.5');
const MAX_POSITION_SOL = parseFloat(process.env.MAX_POSITION_SOL ?? '5');

const AUTO_EXECUTE = process.env.AUTO_EXECUTE === 'true';
const AUTO_EXECUTE_MIN_SCORE = parseScore(
  process.env.AUTO_EXECUTE_MIN_SCORE ?? 85,
  'AUTO_EXECUTE_MIN_SCORE'
);
const REBUY_COOLDOWN_MINUTES = parseNonNegativeNumber(
  process.env.REBUY_COOLDOWN_MINUTES,
  60,
  'REBUY_COOLDOWN_MINUTES'
);
const HELIUS_RPC_TIMEOUT_MS = parsePositiveNumber(
  process.env.HELIUS_RPC_TIMEOUT_MS,
  15_000,
  'HELIUS_RPC_TIMEOUT_MS'
);
const SOLANA_GAS_RESERVE_SOL = parseNonNegativeNumber(
  process.env.SOLANA_GAS_RESERVE_SOL,
  0.01,
  'SOLANA_GAS_RESERVE_SOL'
);

const USE_DYNAMIC_BALANCE_SIZING = process.env.USE_DYNAMIC_BALANCE_SIZING === 'true';

// Safety validations
if (!Number.isFinite(BASE_POSITION_SOL) || BASE_POSITION_SOL <= 0) {
  throw new Error(`[trade-executor] invalid BASE_POSITION_SOL: ${process.env.BASE_POSITION_SOL}`);
}
if (!Number.isFinite(MAX_POSITION_SOL) || MAX_POSITION_SOL <= 0) {
  throw new Error(`[trade-executor] invalid MAX_POSITION_SOL: ${process.env.MAX_POSITION_SOL}`);
}
const CIRCUIT_BREAKER_RESET_MS = 5 * 60 * 1000; // 5 minutes

// ─── Price helpers ─────────────────────────────────────────────────────────────

async function getCachedSolPrice(): Promise<number | null> {
  const client = getRedis();
  const cached = await client.get('sol:price');
  if (cached) {
    const p = parseFloat(cached);
    if (Number.isFinite(p)) return p;
  }
  const price = await fetchTokenPriceUsd(SOL_MINT);
  if (price === null || !Number.isFinite(price)) return null;
  await client.setex('sol:price', 30, price.toString());
  return price;
}

async function getCachedEthPrice(): Promise<number | null> {
  const client = getRedis();
  const cached = await client.get('eth:price');
  if (cached) {
    const p = parseFloat(cached);
    if (Number.isFinite(p)) return p;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd',
      { signal: controller.signal }
    );
    if (!response.ok) return null;
    const data = await response.json() as { ethereum?: { usd?: number } };
    const price = data.ethereum?.usd;
    if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) return null;
    await client.setex('eth:price', 30, price.toString());
    return price;
  } catch (error) {
    console.error('[trade-executor] ETH price lookup failed', error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Trade persistence ─────────────────────────────────────────────────────────

export async function persistTrade(opts: {
  signalId: string;
  sourceTradeId?: string | null;
  copyExecutionId?: string | null;
  tokenMint: string;
  size: number; // Sized in SOL (Solana), USDC (Polygon), or ETH (Robinhood Chain)
  chain: Chain;
  executionMode: 'paper' | 'live' | 'shadow';
  direction?: 'buy' | 'sell';
  executor: string;
  signature?: string | null;
  jupiterFill?: JupiterSimulatedFill | null;
  slippageBps?: number | null;
  status?: string;
  errorMessage?: string | null;
  amountUsd?: number | null;
  requestedAmountUsd?: number | null;
  tokenAmount?: number | null;
  priceUsd?: number | null;
  feeUsd?: number | null;
  venueOrderId?: string | null;
  venueStatus?: string | null;
  venueTradeIds?: string[];
  settlementTransactionHashes?: string[];
  shadowOf?: string | null;
  submittedAt?: Date | null;
  confirmedAt?: Date | null;
}) {
  const status = opts.status ?? 'filled';
  const hasConfirmedFill = status === 'filled' || status === 'partial';
  const tokenPrice = hasConfirmedFill
    ? opts.priceUsd ?? await fetchTokenPriceUsd(opts.tokenMint)
    : null;
  let amountUsd = hasConfirmedFill ? opts.amountUsd ?? null : null;

  if (hasConfirmedFill && amountUsd === null && opts.chain === 'solana') {
    const solPrice = await getCachedSolPrice();
    amountUsd = solPrice !== null ? opts.size * solPrice : 0;
  } else if (hasConfirmedFill && amountUsd === null && opts.chain === 'polygon') {
    amountUsd = opts.size;
  } else if (hasConfirmedFill && amountUsd === null && opts.chain === 'robinhood-chain') {
    const ethPrice = await getCachedEthPrice();
    amountUsd = ethPrice !== null ? opts.size * ethPrice : 0;
  }

  const jup = opts.jupiterFill;
  const tokenAmount = opts.tokenAmount ?? (hasConfirmedFill
    ? (jup
        ? jup.tokenAmount
        : (amountUsd !== null && amountUsd > 0 && tokenPrice && tokenPrice > 0
            ? amountUsd / tokenPrice
            : null))
    : null);

  const tradeInput = {
    signalId: opts.signalId,
    sourceTradeId: opts.sourceTradeId ?? null,
    copyExecutionId: opts.copyExecutionId ?? null,
    tokenMint: opts.tokenMint,
    chain: opts.chain,
    direction: opts.direction ?? 'buy',
    amountSol: opts.size,
    amountUsd,
    targetAmountUsd: opts.requestedAmountUsd ?? (hasConfirmedFill ? amountUsd : null),
    tokenAmount,
    priceUsd: tokenPrice,
    feeUsd: hasConfirmedFill ? opts.feeUsd ?? null : null,
    slippageBps: jup ? 150 : (opts.slippageBps ?? null),
    signature: opts.signature ?? null,
    executionMode: opts.executionMode,
    executor: opts.executor,
    status,
    errorMessage: opts.errorMessage ?? null,
    priceImpactPct: jup?.priceImpactPct ?? null,
    routeInfo: jup?.routePlan ?? null,
    quoteSlot: jup?.contextSlot ?? null,
    minTokenAmount: jup?.minTokenAmount ?? null,
    venueOrderId: opts.venueOrderId ?? null,
    venueStatus: opts.venueStatus ?? null,
    venueTradeIds: opts.venueTradeIds ?? [],
    settlementTransactionHashes: opts.settlementTransactionHashes ?? [],
    shadowOf: opts.shadowOf ?? null,
    submittedAt: opts.submittedAt ?? null,
    confirmedAt: opts.confirmedAt ?? null
  };

  const releaseStatuses = new Set(['skipped', 'failed', 'rejected', 'cancelled']);
  const trade = opts.executionMode === 'shadow'
    ? await insertTrade(tradeInput)
    : hasConfirmedFill
      ? await insertTradeAndMarkSignalExecuted(tradeInput)
      : releaseStatuses.has(status)
        ? await insertTradeAndReleaseSignalClaim(tradeInput)
        : await insertTrade(tradeInput);
  return trade?.id ?? null;
}

export function clampExecutionModeForStartup(
  chain: Chain,
  effectiveMode: 'off' | 'paper' | 'live' | 'live+shadow',
  reason?: string
): { effectiveMode: 'off' | 'paper' | 'live' | 'live+shadow'; reason?: string } {
  if (
    chain === 'polygon' &&
    (effectiveMode === 'live' || effectiveMode === 'live+shadow') &&
    !getPolymarketLiveReadiness().ready
  ) {
    return {
      effectiveMode: 'paper',
      reason: `Polygon startup attestation failed: ${getPolymarketLiveReadiness().reason}`
    };
  }
  if (
    chain === 'robinhood-chain' &&
    (effectiveMode === 'live' || effectiveMode === 'live+shadow') &&
    !getRobinhoodLiveReadiness().ready
  ) {
    return {
      effectiveMode: 'paper',
      reason: `Robinhood startup attestation failed: ${getRobinhoodLiveReadiness().reason}`
    };
  }
  if (
    chain === 'solana' &&
    (effectiveMode === 'live' || effectiveMode === 'live+shadow') &&
    !getTrojanLiveReadiness().ready
  ) {
    return {
      effectiveMode: 'paper',
      reason: `Solana runtime readiness failed: ${getTrojanLiveReadiness().reason}`
    };
  }
  return { effectiveMode, reason };
}

// ─── Position Sizing ─────────────────────────────────────────────────────────

type ClusterTier = 'elite' | 'pro' | 'promising' | 'speculative';

const TIER_MULTIPLIER: Record<ClusterTier, number> = {
  elite:       1.0,
  pro:         0.75,
  promising:   0.5,
  speculative: 0.25
};

function getSizingConfig(
  chain: Chain,
  sizingMode: 'paper' | 'live'
): { base: number; maximum: number; riskPct: number; precision: number } {
  const paperRiskPct = process.env.PAPER_MAX_POSITION_PCT;
  const usePaperRisk = sizingMode === 'paper' && paperRiskPct !== undefined;

  if (chain === 'solana') {
    return {
      base: BASE_POSITION_SOL,
      maximum: MAX_POSITION_SOL,
      riskPct: parseNonNegativeNumber(
        usePaperRisk ? paperRiskPct : undefined,
        5,
        'PAPER_MAX_POSITION_PCT'
      ),
      precision: 4
    };
  }
  if (chain === 'polygon') {
    return {
      base: parsePositiveNumber(process.env.BASE_POSITION_USDC, 100, 'BASE_POSITION_USDC'),
      maximum: parsePositiveNumber(process.env.MAX_POSITION_USDC, 500, 'MAX_POSITION_USDC'),
      riskPct: parseNonNegativeNumber(
        usePaperRisk ? paperRiskPct : process.env.USDC_BALANCE_RISK_PCT,
        2,
        usePaperRisk ? 'PAPER_MAX_POSITION_PCT' : 'USDC_BALANCE_RISK_PCT'
      ),
      precision: 2
    };
  }
  return {
    base: parsePositiveNumber(process.env.BASE_POSITION_ETH, 0.05, 'BASE_POSITION_ETH'),
    maximum: parsePositiveNumber(process.env.MAX_POSITION_ETH, 0.5, 'MAX_POSITION_ETH'),
    riskPct: parseNonNegativeNumber(
      usePaperRisk ? paperRiskPct : process.env.ETH_BALANCE_RISK_PCT,
      2,
      usePaperRisk ? 'PAPER_MAX_POSITION_PCT' : 'ETH_BALANCE_RISK_PCT'
    ),
    precision: 6
  };
}

async function getAvailablePositionBalance(opts: {
  chain: Chain;
  sizingMode: 'paper' | 'live';
  direction: 'buy' | 'sell';
  tokenMint: string;
}): Promise<number> {
  if (opts.sizingMode === 'paper') {
    const bankrollUsd = parsePositiveNumber(
      process.env.PAPER_BANKROLL_USD,
      10_000,
      'PAPER_BANKROLL_USD'
    );
    if (opts.chain === 'polygon') return bankrollUsd;
    if (opts.chain === 'solana') {
      const solPrice = await fetchTokenPriceUsd(SOL_MINT) ?? 150;
      return bankrollUsd / solPrice;
    }
    const ethPrice = await fetchTokenPriceUsd(WETH_ROBINHOOD) ?? 3_000;
    return bankrollUsd / ethPrice;
  }

  if (opts.chain === 'solana') {
    if (!TROJAN_WALLET_ADDRESS) {
      throw new UnrecoverableError(
        'TROJAN_WALLET_ADDRESS is required to verify Solana live balance'
      );
    }
    const balance = await fetchSolanaBalanceSol({
      walletAddress: TROJAN_WALLET_ADDRESS,
      heliusApiKey: HELIUS_API_KEY ?? '',
      timeoutMs: HELIUS_RPC_TIMEOUT_MS
    });
    return Math.max(0, balance - SOLANA_GAS_RESERVE_SOL);
  }

  if (opts.chain === 'polygon') {
    const balance = await getPolymarketAvailableBalance(opts.tokenMint, opts.direction);
    if (opts.direction === 'buy') return balance;
    const bidPrice = await getPolymarketAskPrice(opts.tokenMint, OrderSide.SELL);
    return balance * bidPrice;
  }

  return getRobinhoodSpendableEth();
}

async function getBalanceAwarePositionSize(
  score: number,
  chain: Chain,
  clusterTier: ClusterTier,
  sizingMode: 'paper' | 'live',
  direction: 'buy' | 'sell',
  tokenMint: string
): Promise<number> {
  const tierMult = TIER_MULTIPLIER[clusterTier] ?? 0.5;
  const scoreMult = score >= 90 ? 1.0 : score >= 80 ? 0.75 : 0.5;
  const config = getSizingConfig(chain, sizingMode);
  const balance = await getAvailablePositionBalance({
    chain,
    sizingMode,
    direction,
    tokenMint
  });
  return calculateBalanceAwareSize({
    balance,
    base: config.base,
    maximum: config.maximum,
    riskPct: config.riskPct,
    tierMultiplier: tierMult,
    scoreMultiplier: scoreMult,
    precision: config.precision,
    dynamic: USE_DYNAMIC_BALANCE_SIZING
  });
}

type RobinhoodRuntime = {
  adapter: RobinhoodExecutionAdapter;
  config: RobinhoodExecutionConfig;
  pendingStore: RobinhoodPendingStore;
  safetyAssessment: ReturnType<typeof createRobinhoodSafetyAssessment>;
};

const ownerAbi = parseAbi(['function owner() view returns (address)']);

export function createRobinhoodRuntime(redisClient: Redis): RobinhoodRuntime {
  const config = parseRobinhoodExecutionConfig();
  const adapter = createViemRobinhoodAdapter();
  const pendingStore = createRedisRobinhoodPendingStore(redisClient);
  const safetyAssessment = createRobinhoodSafetyAssessment({
    quote: adapter.quote,
    minimumLiquidityUsd: DEFAULT_RISK_CONFIG.minLiquidityUsd,
    readOwner: async (token) => robinhoodPublicClient.readContract({
      address: token,
      abi: ownerAbi,
      functionName: 'owner'
    })
  });
  configureRobinhoodRuntime({ pendingStore, safetyAssessment });
  return { adapter, config, pendingStore, safetyAssessment };
}

function configureRobinhoodOpsAlerts(redisClient: Redis): void {
  configureRobinhoodOpsAlertEmitter(async (alert) => {
    await redisClient.publish(REDIS_CHANNELS.alertQueue, JSON.stringify({
      type: alert.type,
      title: 'Robinhood live execution is not ready',
      message: alert.reason,
      severity: alert.severity,
      chain: alert.chain,
      requestedMode: alert.requestedMode,
      checkedAt: alert.checkedAt
    }));
  });
}

async function transitionPendingTrade(input: {
  executor: 'trojan' | 'robinhood-univ3';
  signalId?: string;
  signature?: string;
  status: 'filled' | 'failed';
  errorMessage?: string;
  confirmedAt?: Date;
}): Promise<void> {
  if (!input.signalId && !input.signature) {
    throw new Error('A signal ID or transaction identity is required to reconcile a pending trade');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<{ signal_id: string | null }>(
      `UPDATE trades
          SET status = $3,
              error_message = $4,
              signature = COALESCE($5, signature),
              confirmed_at = CASE WHEN $3 = 'filled' THEN COALESCE($6, NOW()) ELSE confirmed_at END
        WHERE executor = $1
          AND status = 'pending_confirmation'
          AND (($2::uuid IS NOT NULL AND signal_id = $2::uuid)
            OR ($2::uuid IS NULL AND signature = $5))
      RETURNING signal_id`,
      [
        input.executor,
        input.signalId ?? null,
        input.status,
        input.errorMessage ?? null,
        input.signature ?? null,
        input.confirmedAt ?? null
      ]
    );
    const signalIds = [...new Set(result.rows.flatMap((row) => row.signal_id ? [row.signal_id] : []))];
    if (signalIds.length > 0) {
      if (input.status === 'filled') {
        await client.query(
          `UPDATE signals
              SET status = 'executed', executed_at = NOW()
            WHERE id = ANY($1::uuid[])`,
          [signalIds]
        );
      } else {
        await client.query(
          `UPDATE signals SET status = 'pending'
            WHERE id = ANY($1::uuid[]) AND status = 'executing'`,
          [signalIds]
        );
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function runRobinhoodReconciliation(runtime: RobinhoodRuntime): Promise<RobinhoodReconciliationOutcome[]> {
  const outcomes = await reconcileRobinhoodPending({
    adapter: runtime.adapter,
    pendingStore: runtime.pendingStore,
    config: runtime.config,
    safetyAssessment: runtime.safetyAssessment
  });
  for (const outcome of outcomes) {
    if (outcome.status === 'filled') {
      await transitionPendingTrade({
        executor: 'robinhood-univ3',
        signalId: outcome.clientOrderId,
        signature: outcome.transactionHash,
        status: 'filled',
        confirmedAt: new Date()
      });
    } else if (outcome.status === 'failed' && outcome.state !== 'rpc_failure') {
      await transitionPendingTrade({
        executor: 'robinhood-univ3',
        signalId: outcome.clientOrderId,
        signature: outcome.transactionHash,
        status: 'failed',
        errorMessage: outcome.reason
      });
    } else if (outcome.status === 'pending_confirmation') {
      await query(
        `UPDATE trades
            SET signature = $2,
                venue_status = $3
          WHERE executor = 'robinhood-univ3'
            AND signal_id = $1
            AND status = 'pending_confirmation'`,
        [outcome.clientOrderId, outcome.transactionHash, outcome.stage]
      );
    } else if (outcome.status === 'skipped' && outcome.clientOrderId) {
      await transitionPendingTrade({
        executor: 'robinhood-univ3',
        signalId: outcome.clientOrderId,
        status: 'failed',
        errorMessage: outcome.reason
      });
    } else if (outcome.status === 'approval_confirmed') {
      await query(
        `UPDATE trades SET venue_status = 'approval_confirmed'
          WHERE executor = 'robinhood-univ3'
            AND signal_id = $1
            AND status = 'pending_confirmation'`,
        [outcome.clientOrderId]
      );
    }
  }
  return outcomes;
}

type TrojanReconciliationOutcome = TrojanReconciliationResult | TrojanTerminalResolution;

export type ChainReconciliationTask = {
  chain: Chain;
  run: () => Promise<unknown>;
};

export async function runChainReconciliations(tasks: ChainReconciliationTask[]): Promise<void> {
  const results = await Promise.allSettled(tasks.map((task) => task.run()));
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      console.error(
        `[trade-executor] ${tasks[index].chain} reconciliation failed`,
        result.reason
      );
    }
  });
}

type ExecutorJobResult = {
  status: string;
  reason?: string;
  state?: string;
  signalId?: string;
  tokenMint?: string;
  size?: number;
  signature?: string | null;
  mode?: string;
  simulatedVia?: string;
};

type CircuitBreakerJob = {
  data: unknown;
  token?: string;
  moveToDelayed: (timestamp: number, token?: string) => Promise<unknown>;
};

const successfulBreakerOutcomes = new Set([
  'already-executed',
  'live-executed',
  'paper-filled',
  'submitted'
]);
const failedBreakerOutcomes = new Set(['failed', 'rejected']);

function chainFromJob(job: { data: unknown }): Chain {
  const payload = job.data as { tokenMint?: unknown } | null;
  const tokenMint = typeof payload?.tokenMint === 'string' ? payload.tokenMint : '';
  const separator = tokenMint.indexOf(':');
  const chain = separator >= 0 ? tokenMint.slice(0, separator) : 'solana';
  if (!isChain(chain)) {
    throw new UnrecoverableError(`Unsupported trade chain: ${chain}`);
  }
  return chain;
}

async function delayForCircuitBreaker(
  job: CircuitBreakerJob,
  chain: Chain,
  trippedAt: string
): Promise<never> {
  if (!job.token) {
    throw new Error(`Cannot delay ${chain} job without a BullMQ lock token`);
  }
  const tripTime = Date.parse(trippedAt);
  const remainingMs = Number.isFinite(tripTime)
    ? Math.max(1, CIRCUIT_BREAKER_RESET_MS - (Date.now() - tripTime))
    : CIRCUIT_BREAKER_RESET_MS;
  await job.moveToDelayed(Date.now() + remainingMs, job.token);
  throw new DelayedError();
}

export async function executeJobWithCircuitBreaker(
  job: CircuitBreakerJob,
  execute: (job: { data: unknown }) => Promise<ExecutorJobResult> = handleJob
): Promise<ExecutorJobResult> {
  const chain = chainFromJob(job);
  const state = await readCircuitBreakerState(chain);

  if (state.trippedAt !== null) {
    const probeClaimed = await claimCircuitBreakerProbe(chain, CIRCUIT_BREAKER_RESET_MS);
    if (!probeClaimed) {
      const current = await readCircuitBreakerState(chain);
      if (current.trippedAt !== null) {
        console.log(`[trade-executor] circuit breaker active for ${chain}; delaying job`);
        return delayForCircuitBreaker(job, chain, current.trippedAt);
      }
    } else {
      console.log(`[trade-executor] circuit breaker half-open probe claimed for ${chain}`);
    }
  }

  try {
    const result = await execute(job);
    if (successfulBreakerOutcomes.has(result.status)) {
      await recordCircuitBreakerSuccess(chain);
    } else if (failedBreakerOutcomes.has(result.status)) {
      const failed = await recordCircuitBreakerFailure(
        chain,
        DEFAULT_RISK_CONFIG.maxConsecutiveFailures
      );
      if (failed.trippedAt !== null) {
        console.error(
          `[trade-executor] circuit breaker tripped for ${chain} after ${failed.consecutiveFailures} consecutive failures`
        );
      }
    }
    return result;
  } catch (error) {
    if (error instanceof UnrecoverableError || error instanceof DelayedError) throw error;
    const failed = await recordCircuitBreakerFailure(
      chain,
      DEFAULT_RISK_CONFIG.maxConsecutiveFailures
    );
    if (failed.trippedAt !== null) {
      console.error(
        `[trade-executor] circuit breaker tripped for ${chain} after ${failed.consecutiveFailures} consecutive failures`
      );
    }
    throw error;
  }
}

const SOURCE_COPY_POSITION_EVIDENCE_MAX_AGE_MS = parsePositiveNumber(
  process.env.SOURCE_COPY_POSITION_EVIDENCE_MAX_AGE_MS,
  10 * 60_000,
  'SOURCE_COPY_POSITION_EVIDENCE_MAX_AGE_MS'
);

type CanonicalExecutionSet = Partial<Record<'paper' | 'live' | 'shadow', CopyExecutionRecord>>;

function resolveLiveCopyTargetAccount(chain: Chain): string {
  if (chain === 'solana') {
    if (!TROJAN_WALLET_ADDRESS) {
      throw new UnrecoverableError('TROJAN_WALLET_ADDRESS is required for canonical Solana execution');
    }
    return TROJAN_WALLET_ADDRESS;
  }
  if (chain === 'robinhood-chain') {
    if (!evmAccount) {
      throw new UnrecoverableError('EVM_PRIVATE_KEY is required for canonical Robinhood execution');
    }
    return evmAccount.address;
  }
  if (!polymarketSigner) {
    throw new UnrecoverableError('EVM_PRIVATE_KEY is required for canonical Polymarket execution');
  }
  return resolvePolymarketIdentity(polymarketSigner.address).funderAddress;
}

async function prepareCanonicalExecutions(input: {
  sourceTradeId: string;
  signalId: string;
  chain: Chain;
  direction: 'buy' | 'sell';
  mode: 'paper' | 'live' | 'live+shadow';
  buyQuoteQuantity: number;
}): Promise<{ executions: CanonicalExecutionSet; reason?: string; shadowReason?: string }> {
  const executions: CanonicalExecutionSet = {};
  let shadowReason: string | undefined;
  for (const executionMode of executionModesForChainMode(input.mode)) {
    const targetAccount = executionMode === 'live'
      ? resolveLiveCopyTargetAccount(input.chain)
      : resolvePaperCopyTargetAccount(input.chain);
    let result: Awaited<ReturnType<typeof claimSourceSignalForCopyExecution>>;
    try {
      result = await claimSourceSignalForCopyExecution({
        signalId: input.signalId,
        targetAccount,
        executionMode,
        requestedQuoteQuantity: input.direction === 'buy'
          ? input.buyQuoteQuantity.toString()
          : null,
        maxPositionEvidenceAgeMs: SOURCE_COPY_POSITION_EVIDENCE_MAX_AGE_MS
      });
    } catch (error) {
      if (executionMode !== 'shadow') throw error;
      shadowReason = error instanceof Error ? error.message : String(error);
      continue;
    }
    if (!result.execution) {
      const reason = result.reason ?? 'Canonical execution was not claimed';
      if (executionMode === 'shadow') {
        shadowReason = reason;
        continue;
      }
      return { executions, reason };
    }
    if (
      result.execution.sourceTradeId !== input.sourceTradeId
      || result.execution.direction !== input.direction
      || result.execution.chain !== input.chain
    ) {
      throw new UnrecoverableError('Canonical execution identity does not match the queued source event');
    }
    executions[executionMode] = result.execution;
  }
  return { executions, shadowReason };
}

function canonicalExecutionIsPending(execution: CopyExecutionRecord): boolean {
  return execution.state === 'submitted'
    || execution.state === 'partially_filled'
    || execution.state === 'reconciliation_required';
}

function canonicalExecutionIsTerminal(execution: CopyExecutionRecord): boolean {
  return execution.state === 'confirmed'
    || execution.state === 'failed'
    || execution.state === 'cancelled';
}

async function persistCanonicalSubmission(input: {
  execution: CopyExecutionRecord;
  executor: string;
  submissionType: 'transaction' | 'order';
  submissionId: string;
}): Promise<void> {
  await transitionCopyExecution({
    executionId: input.execution.id,
    nextState: 'simulated',
    simulationId: `${input.executor}:simulation:${input.execution.clientOrderId}`
  });
  await transitionCopyExecution({
    executionId: input.execution.id,
    nextState: 'submitted',
    submissionType: input.submissionType,
    submissionId: input.submissionId,
    nextReconciliationAt: new Date(Date.now() + 60_000)
  });
}

async function persistCanonicalFill(input: {
  execution: CopyExecutionRecord;
  evidenceType: 'chain_receipt' | 'venue_fill' | 'paper_simulation';
  evidenceId: string;
  baseQuantity: string;
  quoteQuantity?: string | null;
  priceUsd?: string | null;
  completesExecution?: boolean;
  occurredAt?: Date;
}): Promise<void> {
  await recordCopyExecutionEvidence({
    executionId: input.execution.id,
    evidenceType: input.evidenceType,
    evidenceId: input.evidenceId,
    baseQuantity: input.baseQuantity,
    quoteQuantity: input.quoteQuantity,
    priceUsd: input.priceUsd,
    confirmationState: 'confirmed',
    completesExecution: input.completesExecution ?? true,
    occurredAt: input.occurredAt ?? new Date()
  });
}

async function terminateCanonicalExecution(
  execution: CopyExecutionRecord | undefined,
  reason: string,
  state: 'failed' | 'cancelled' = 'failed'
): Promise<void> {
  if (!execution || canonicalExecutionIsTerminal(execution)) return;
  await transitionCopyExecution({
    executionId: execution.id,
    nextState: state,
    reason
  });
}

export async function runTrojanReconciliation(
  runtime: Pick<TrojanRuntime, 'reconcile'>
): Promise<TrojanReconciliationOutcome[]> {
  const outcomes = await runtime.reconcile() as TrojanReconciliationOutcome[];
  for (const outcome of outcomes) {
    if (outcome.status === 'filled') {
      await transitionPendingTrade({
        executor: 'trojan',
        signature: outcome.transactionIdentity,
        status: 'filled',
        confirmedAt: outcome.confirmedAt
      });
    } else if (outcome.status === 'failed' || outcome.status === 'inconsistent') {
      await transitionPendingTrade({
        executor: 'trojan',
        signature: outcome.transactionIdentity,
        status: 'failed',
        errorMessage: outcome.status === 'inconsistent' ? outcome.reason : 'transaction failed on-chain'
      });
    } else if (outcome.status === 'ambiguous') {
      await transitionPendingTrade({
        executor: 'trojan',
        signalId: outcome.clientOrderId,
        status: 'failed',
        errorMessage: outcome.reason
      });
    } else if (outcome.status === 'submission_unknown') {
      await query(
        `UPDATE trades SET venue_status = 'submission_unknown'
          WHERE executor = 'trojan'
            AND signal_id = $1
            AND status = 'pending_confirmation'`,
        [outcome.clientOrderId]
      );
    } else if (
      outcome.status === 'pending_confirmation'
      || outcome.status === 'pending_reconciliation'
    ) {
      await query(
        `UPDATE trades SET venue_status = $2
          WHERE executor = 'trojan'
            AND signature = $1
            AND status = 'pending_confirmation'`,
        [outcome.transactionIdentity, outcome.status]
      );
    }
  }
  return outcomes;
}

// ─── Worker Job Handler ────────────────────────────────────────────────────────

export async function handleJob(job: { data: unknown }) {
  const payload = job.data as {
    signalId: string;
    sourceTradeId?: string;
    score: number;
    tokenMint: string | null;
    clusterTier?: ClusterTier;
    manual?: boolean;
    direction?: 'buy' | 'sell';
  };

  if (!payload.signalId || typeof payload.signalId !== 'string') {
    throw new UnrecoverableError('Trade job is missing a signalId');
  }
  if (!payload.tokenMint || typeof payload.tokenMint !== 'string') {
    throw new UnrecoverableError(`Trade job ${payload.signalId} has no token mint`);
  }
  let score: number;
  try {
    score = parseScore(payload.score, `Trade job ${payload.signalId} score`);
  } catch (error) {
    throw new UnrecoverableError(error instanceof Error ? error.message : String(error));
  }

  // Extract chain from tokenMint prefix
  const separator = payload.tokenMint.indexOf(':');
  const chain = separator >= 0 ? payload.tokenMint.slice(0, separator) : 'solana';
  const cleanMint = separator >= 0 ? payload.tokenMint.slice(separator + 1) : payload.tokenMint;
  if (!isChain(chain)) {
    throw new UnrecoverableError(`Unsupported trade chain: ${chain}`);
  }
  if (!cleanMint) {
    throw new UnrecoverableError(`Trade job ${payload.signalId} has an empty token mint`);
  }

  // Resolve execution mode per chain
  const modeResolution = await resolveChainMode(chain);
  const startupResolution = clampExecutionModeForStartup(
    chain,
    modeResolution.effectiveMode,
    modeResolution.reason
  );
  const execMode = startupResolution.effectiveMode;
  const clampReason = startupResolution.reason;

  if (execMode === 'off') {
    console.log(`[trade-executor] SKIPPED: Execution is OFF for ${chain}`);
    return { status: 'skipped', reason: 'Execution disabled (off)' };
  }

  if (clampReason) {
    console.warn(`[trade-executor] WARNING: ${clampReason} | requested: ${chain} live`);
  }

  // Auto-execute gate
  if (!payload.manual && (!AUTO_EXECUTE || score < AUTO_EXECUTE_MIN_SCORE)) {
    console.log(`[trade-executor] SKIPPED: auto-execute=${AUTO_EXECUTE}, score=${score}, threshold=${AUTO_EXECUTE_MIN_SCORE} | token: ${payload.tokenMint}`);
    return {
      status: 'skipped',
      reason: `Auto-execute disabled or score ${score} < threshold ${AUTO_EXECUTE_MIN_SCORE}`
    };
  }

  const direction = payload.direction ?? 'buy';
  const sizingMode = execMode === 'paper' ? 'paper' : 'live';
  const liveTokenSell = direction === 'sell' && chain !== 'polygon' && sizingMode === 'live';
  const size = liveTokenSell
    ? 0
    : await getBalanceAwarePositionSize(
        score,
        chain,
        payload.clusterTier ?? 'promising',
        sizingMode,
        direction,
        cleanMint
      );

  if (!Number.isFinite(size) || (size <= 0 && !liveTokenSell)) {
    console.log(`[trade-executor] SKIPPED: position size = 0 | token: ${payload.tokenMint}`);
    return { status: 'skipped', reason: 'Position size calculated to 0' };
  }

  // Enforce 24-hour exposure cap per chain
  const dailyExposureUsd = direction === 'buy' ? await getRollingExposureUsd(chain) : 0;
  const dailyCapUsd = parseFloat(process.env.DAILY_EXPOSURE_CAP_USD ?? '50000');

  let thisTradeUsd = size;
  if (chain === 'solana') {
    const solPrice = await fetchTokenPriceUsd(SOL_MINT) ?? 150;
    thisTradeUsd = size * solPrice;
  } else if (chain === 'robinhood-chain') {
    const ethPrice = await fetchTokenPriceUsd(WETH_ROBINHOOD) ?? 3000;
    thisTradeUsd = size * ethPrice;
  }

  if (direction === 'buy' && dailyExposureUsd + thisTradeUsd > dailyCapUsd) {
    console.error(`[trade-executor] SKIPPED: Daily exposure cap exceeded for ${chain} (${dailyExposureUsd.toFixed(2)} + ${thisTradeUsd.toFixed(2)} > ${dailyCapUsd})`);

    const alertKey = `exposure_alert:${chain}`;
    const redisClient = getRedis();
    const alreadyAlerted = await redisClient.get(alertKey);
    if (!alreadyAlerted) {
      await redisClient.publish(REDIS_CHANNELS.alertQueue, JSON.stringify({
        type: 'SYSTEM_CAP_EXCEEDED',
        title: `24h Exposure Cap Exceeded: ${chain}`,
        message: `Chain ${chain} hit its rolling daily exposure cap of $${dailyCapUsd}. Current: $${dailyExposureUsd.toFixed(2)}. Trade of $${thisTradeUsd.toFixed(2)} blocked.`,
        severity: 'high'
      }));
      await redisClient.set(alertKey, '1', 'EX', 86400); // Only alert once per day
    }

    return { status: 'skipped', reason: `24h exposure cap exceeded on ${chain}` };
  }

  // Re-buy cooldown
  if (
    direction === 'buy' &&
    REBUY_COOLDOWN_MINUTES > 0 &&
    await hasRecentBuy(payload.tokenMint, REBUY_COOLDOWN_MINUTES)
  ) {
    console.log(`[trade-executor] SKIPPED: re-buy cooldown (${REBUY_COOLDOWN_MINUTES}min) active | token: ${payload.tokenMint}`);
    return { status: 'skipped', reason: `Re-buy cooldown active for ${payload.tokenMint}` };
  }

  // Claim the signal atomically
  let canonicalExecutions: CanonicalExecutionSet = {};
  let canonicalLiveAlreadyConfirmed = false;
  let canonicalLiveTradeId: string | null = null;
  let canonicalShadowReason: string | undefined;
  if (payload.sourceTradeId) {
    const prepared = await prepareCanonicalExecutions({
      sourceTradeId: payload.sourceTradeId,
      signalId: payload.signalId,
      chain,
      direction,
      mode: execMode,
      buyQuoteQuantity: size
    });
    canonicalExecutions = prepared.executions;
    canonicalShadowReason = prepared.shadowReason;
    if (prepared.reason) {
      return { status: 'skipped', reason: prepared.reason };
    }
    const primary = execMode === 'paper' ? canonicalExecutions.paper : canonicalExecutions.live;
    if (!primary) throw new UnrecoverableError('Canonical primary execution was not created');
    if (canonicalExecutionIsPending(primary)) {
      return { status: 'submitted', state: primary.state, signalId: payload.signalId };
    }
    if (primary.state === 'failed' || primary.state === 'cancelled') {
      return { status: primary.state, reason: 'Canonical execution is terminal' };
    }
    if (primary.state === 'confirmed') {
      if (execMode !== 'live+shadow') {
        return { status: 'already-executed', signalId: payload.signalId };
      }
      canonicalLiveAlreadyConfirmed = true;
      const linkedTrade = await query<{ id: string }>(
        `SELECT id FROM trades WHERE copy_execution_id = $1 LIMIT 1`,
        [primary.id]
      );
      canonicalLiveTradeId = linkedTrade[0]?.id ?? null;
    }
  } else {
    const claimed = await claimSignalForExecution(payload.signalId);
    if (!claimed) {
      console.log(`[trade-executor] SKIPPED: signal is not pending | signalId: ${payload.signalId}`);
      return { status: 'skipped', reason: 'Signal is not pending' };
    }
  }

  try {
    let paperResult: ExecutorJobResult | null = null;
    let liveResult: ExecutorJobResult | null = canonicalLiveAlreadyConfirmed
      ? { status: 'live-executed', signalId: payload.signalId }
      : null;
    let liveTradeId: string | null = canonicalLiveTradeId;

    // 1. LIVE EXECUTION PATH (Runs First in live+shadow)
    if ((execMode === 'live' || execMode === 'live+shadow') && !canonicalLiveAlreadyConfirmed) {
      if (chain === 'solana') {
        const canonicalExecution = canonicalExecutions.live;
        let submissionSize = 0;
        if (direction === 'buy') {
          const currentSpendableBalance = await getAvailablePositionBalance({
            chain,
            sizingMode: 'live',
            direction,
            tokenMint: cleanMint
          });
          submissionSize = capPositionToAvailableBalance({
            requested: size,
            available: currentSpendableBalance,
            maximum: MAX_POSITION_SOL,
            precision: 4
          });
          if (submissionSize <= 0) {
            throw new UnrecoverableError('Solana spendable balance is zero after the gas reserve');
          }
        }
        let sellProportionBps: number | undefined;
        let maximumTokenAmountBaseUnits: string | undefined;
        if (canonicalExecution?.direction === 'sell') {
          if (!canonicalExecution.sourceSellFraction || !canonicalExecution.requestedBaseQuantity) {
            throw new UnrecoverableError('Canonical Solana SELL is missing proportional position evidence');
          }
          const decimals = await getTokenDecimals(payload.tokenMint, 'solana');
          if (decimals === null) {
            await terminateCanonicalExecution(
              canonicalExecution,
              'Token decimals are unavailable for an exact proportional Solana SELL'
            );
            throw new UnrecoverableError('Token decimals are required for a canonical Solana SELL');
          }
          sellProportionBps = sourceSellFractionToBps(canonicalExecution.sourceSellFraction);
          maximumTokenAmountBaseUnits = decimalQuantityToBaseUnits(
            canonicalExecution.requestedBaseQuantity,
            decimals
          ).toString();
        }
        const submittedAt = new Date();
        const result = await triggerTrojan({
          signalId: canonicalExecution?.clientOrderId ?? payload.signalId,
          tokenMint: cleanMint,
          amountSol: submissionSize,
          direction,
          sellProportionBps: direction === 'sell' ? sellProportionBps ?? 10_000 : undefined,
          maximumTokenAmountBaseUnits,
          slippageBps: 1500
        });
        if (result.status === 'pending_confirmation' || result.status === 'submission_unknown') {
          const signature = result.status === 'pending_confirmation'
            ? result.transactionIdentity
            : null;
          if (canonicalExecution) {
            if (signature) {
              await persistCanonicalSubmission({
                execution: canonicalExecution,
                executor: 'trojan',
                submissionType: 'transaction',
                submissionId: signature
              });
            } else {
              await transitionCopyExecution({
                executionId: canonicalExecution.id,
                nextState: 'reconciliation_required',
                reason: result.status === 'submission_unknown'
                  ? result.reason
                  : 'Trojan submission identity is unavailable',
                nextReconciliationAt: new Date(Date.now() + 30_000)
              });
            }
          }
          liveTradeId = await persistTrade({
            signalId: payload.signalId,
            sourceTradeId: payload.sourceTradeId,
            copyExecutionId: canonicalExecution?.id,
            tokenMint: payload.tokenMint,
            size: submissionSize,
            chain,
            executionMode: 'live',
            direction,
            executor: 'trojan',
            signature,
            venueStatus: result.status,
            status: 'pending_confirmation',
            errorMessage: result.status === 'submission_unknown' ? result.reason : null,
            slippageBps: 1500,
            submittedAt
          });
          liveResult = {
            status: 'submitted',
            state: result.status,
            signalId: payload.signalId,
            tokenMint: payload.tokenMint,
            size: submissionSize,
            signature
          };
        } else if (result.status === 'rejected') {
          await terminateCanonicalExecution(
            canonicalExecution,
            `Trojan rejected the request with HTTP ${result.httpStatus}`,
            'cancelled'
          );
          liveTradeId = await persistTrade({
            signalId: payload.signalId,
            sourceTradeId: payload.sourceTradeId,
            copyExecutionId: canonicalExecution?.id,
            tokenMint: payload.tokenMint,
            size: submissionSize,
            chain,
            executionMode: 'live',
            direction,
            executor: 'trojan',
            status: 'rejected',
            errorMessage: `Trojan rejected the request with HTTP ${result.httpStatus}`,
            slippageBps: 1500,
            submittedAt
          });
          liveResult = { status: 'rejected', reason: `Trojan HTTP ${result.httpStatus}` };
        } else {
          const resolution = result.resolution;
          if (resolution.status === 'filled') {
            const decimals = await getTokenDecimals(payload.tokenMint, 'solana');
            const tokenBaseUnits = BigInt(resolution.tokenBaseUnitsDelta.replace('-', ''));
            const tokenQuantity = decimals === null ? null : formatUnits(tokenBaseUnits, decimals);
            const tokenAmount = tokenQuantity === null ? null : Number(tokenQuantity);
            const executedSize = Number(resolution.nativeLamportsDelta.replace('-', '')) / 1_000_000_000;
            const canonicalFillConfirmed = !canonicalExecution || tokenQuantity !== null;
            if (canonicalExecution) {
              if (!tokenQuantity) {
                await transitionCopyExecution({
                  executionId: canonicalExecution.id,
                  nextState: 'reconciliation_required',
                  reason: 'Confirmed Solana transaction lacks token decimal evidence',
                  nextReconciliationAt: new Date(Date.now() + 30_000)
                });
              } else {
                await persistCanonicalSubmission({
                  execution: canonicalExecution,
                  executor: 'trojan',
                  submissionType: 'transaction',
                  submissionId: resolution.transactionIdentity
                });
                await persistCanonicalFill({
                  execution: canonicalExecution,
                  evidenceType: 'chain_receipt',
                  evidenceId: resolution.transactionIdentity,
                  baseQuantity: tokenQuantity,
                  quoteQuantity: executedSize.toString(),
                  occurredAt: resolution.confirmedAt
                });
              }
            }
            liveTradeId = await persistTrade({
              signalId: payload.signalId,
              sourceTradeId: payload.sourceTradeId,
              copyExecutionId: canonicalExecution?.id,
              tokenMint: payload.tokenMint,
              size: executedSize,
              chain,
              executionMode: 'live',
              direction,
              executor: 'trojan',
              signature: resolution.transactionIdentity,
              tokenAmount,
              status: canonicalFillConfirmed ? 'filled' : 'pending_confirmation',
              venueStatus: canonicalFillConfirmed ? 'confirmed' : 'reconciliation_required',
              slippageBps: 1500,
              submittedAt,
              confirmedAt: resolution.confirmedAt
            });
            liveResult = {
              status: canonicalFillConfirmed ? 'live-executed' : 'submitted',
              signalId: payload.signalId,
              tokenMint: payload.tokenMint,
              size: executedSize,
              signature: resolution.transactionIdentity
            };
          } else {
            const errorMessage = resolution.status === 'rejected'
              ? `Trojan rejected the request with HTTP ${resolution.httpStatus}`
              : resolution.status === 'failed'
                ? 'Trojan transaction failed on-chain'
                : resolution.reason;
            await terminateCanonicalExecution(canonicalExecution, errorMessage);
            liveTradeId = await persistTrade({
              signalId: payload.signalId,
              sourceTradeId: payload.sourceTradeId,
              copyExecutionId: canonicalExecution?.id,
              tokenMint: payload.tokenMint,
              size: submissionSize,
              chain,
              executionMode: 'live',
              direction,
              executor: 'trojan',
              status: resolution.status === 'rejected' ? 'rejected' : 'failed',
              errorMessage,
              slippageBps: 1500,
              submittedAt
            });
            liveResult = { status: 'failed', reason: errorMessage };
          }
        }
      } else if (chain === 'robinhood-chain') {
        const canonicalExecution = canonicalExecutions.live;
        let canonicalSellBaseUnits: bigint | undefined;
        let canonicalSellBps: number | undefined;
        if (canonicalExecution?.direction === 'sell') {
          if (!canonicalExecution.requestedBaseQuantity || !canonicalExecution.sourceSellFraction) {
            throw new UnrecoverableError('Canonical Robinhood SELL is missing proportional position evidence');
          }
          const decimals = await getTokenDecimals(payload.tokenMint, 'robinhood-chain');
          if (decimals === null) {
            await terminateCanonicalExecution(
              canonicalExecution,
              'Token decimals are unavailable for an exact proportional Robinhood SELL'
            );
            throw new UnrecoverableError('Token decimals are required for a canonical Robinhood SELL');
          }
          canonicalSellBaseUnits = decimalQuantityToBaseUnits(
            canonicalExecution.requestedBaseQuantity,
            decimals
          );
          canonicalSellBps = sourceSellFractionToBps(canonicalExecution.sourceSellFraction);
        }
        const submittedAt = new Date();
        const result = await triggerRobinhood({
          signalId: canonicalExecution?.clientOrderId ?? payload.signalId,
          tokenMint: cleanMint,
          amountEth: size,
          direction,
          amountInBaseUnits: canonicalSellBaseUnits,
          proportionBps: direction === 'sell' ? canonicalSellBps ?? 10_000 : undefined,
          slippageBps: 300
        });
        if (result.status === 'filled') {
          const decimals = await getTokenDecimals(payload.tokenMint, 'robinhood-chain');
          const tokenBaseUnits = direction === 'buy' ? result.actualAmountOut : result.actualAmountIn;
          const tokenQuantity = decimals === null ? null : formatUnits(tokenBaseUnits, decimals);
          const tokenAmount = tokenQuantity === null ? null : Number(tokenQuantity);
          const canonicalFillConfirmed = !canonicalExecution || tokenQuantity !== null;
          if (canonicalExecution) {
            if (!tokenQuantity) {
              await transitionCopyExecution({
                executionId: canonicalExecution.id,
                nextState: 'reconciliation_required',
                reason: 'Confirmed Robinhood receipt lacks token decimal evidence',
                nextReconciliationAt: new Date(Date.now() + 30_000)
              });
            } else {
              await persistCanonicalSubmission({
                execution: canonicalExecution,
                executor: 'robinhood-univ3',
                submissionType: 'transaction',
                submissionId: result.transactionHash
              });
              await persistCanonicalFill({
                execution: canonicalExecution,
                evidenceType: 'chain_receipt',
                evidenceId: result.transactionHash,
                baseQuantity: tokenQuantity,
                quoteQuantity: result.amountEth.toString()
              });
            }
          }
          liveTradeId = await persistTrade({
            signalId: payload.signalId,
            sourceTradeId: payload.sourceTradeId,
            copyExecutionId: canonicalExecution?.id,
            tokenMint: payload.tokenMint,
            size: result.amountEth,
            chain,
            executionMode: 'live',
            direction,
            executor: 'robinhood-univ3',
            signature: result.signature,
            tokenAmount,
            status: canonicalFillConfirmed ? 'filled' : 'pending_confirmation',
            venueStatus: canonicalFillConfirmed ? 'confirmed' : 'reconciliation_required',
            slippageBps: 300,
            submittedAt,
            confirmedAt: new Date()
          });
          liveResult = {
            status: canonicalFillConfirmed ? 'live-executed' : 'submitted',
            signalId: payload.signalId,
            tokenMint: payload.tokenMint,
            size: result.amountEth,
            signature: result.signature
          };
        } else if (result.status === 'pending_confirmation') {
          if (canonicalExecution) {
            if (result.transactionHash) {
              await persistCanonicalSubmission({
                execution: canonicalExecution,
                executor: 'robinhood-univ3',
                submissionType: 'transaction',
                submissionId: result.transactionHash
              });
            } else {
              await transitionCopyExecution({
                executionId: canonicalExecution.id,
                nextState: 'reconciliation_required',
                reason: 'Robinhood submission identity is unknown',
                nextReconciliationAt: new Date(Date.now() + 30_000)
              });
            }
          }
          liveTradeId = await persistTrade({
            signalId: payload.signalId,
            sourceTradeId: payload.sourceTradeId,
            copyExecutionId: canonicalExecution?.id,
            tokenMint: payload.tokenMint,
            size,
            chain,
            executionMode: 'live',
            direction,
            executor: 'robinhood-univ3',
            signature: result.transactionHash,
            venueStatus: result.stage,
            status: 'pending_confirmation',
            slippageBps: 300,
            submittedAt
          });
          liveResult = {
            status: 'submitted',
            state: result.stage,
            signalId: payload.signalId,
            tokenMint: payload.tokenMint,
            size,
            signature: result.transactionHash
          };
        } else {
          if (canonicalExecution && 'transactionHash' in result && result.transactionHash) {
            await persistCanonicalSubmission({
              execution: canonicalExecution,
              executor: 'robinhood-univ3',
              submissionType: 'transaction',
              submissionId: result.transactionHash
            });
          }
          await terminateCanonicalExecution(
            canonicalExecution,
            result.reason,
            result.status === 'skipped' ? 'cancelled' : 'failed'
          );
          liveTradeId = await persistTrade({
            signalId: payload.signalId,
            sourceTradeId: payload.sourceTradeId,
            copyExecutionId: canonicalExecution?.id,
            tokenMint: payload.tokenMint,
            size,
            chain,
            executionMode: 'live',
            direction,
            executor: 'robinhood-univ3',
            signature: 'transactionHash' in result ? result.transactionHash ?? null : null,
            status: result.status,
            errorMessage: result.reason,
            slippageBps: 300,
            submittedAt
          });
          liveResult = { status: result.status, reason: result.reason };
        }
      } else if (chain === 'polygon') {
        const canonicalExecution = canonicalExecutions.live;
        try {
          if (canonicalExecution?.direction === 'sell' && !canonicalExecution.requestedBaseQuantity) {
            throw new UnrecoverableError('Canonical Polymarket SELL is missing proportional position evidence');
          }
          const submittedAt = new Date();
          const result = await triggerPolymarket({
            signalId: canonicalExecution?.clientOrderId ?? payload.signalId,
            tokenID: cleanMint,
            spendAmountUsd: size, // Polymarket size logic assumes USDC/USD sizing
            direction,
            sellShares: canonicalExecution?.direction === 'sell'
              ? Number(canonicalExecution.requestedBaseQuantity)
              : undefined
          });
          const orderId = result.orderId;
          const settlementHash = result.settlementTransactionHashes[0] ?? null;
          const executedSize = result.spendAmountUsd;

          console.log(`[trade-executor] LIVE: executed Polymarket order for ${payload.tokenMint} | Size: $${executedSize} | Latency: ${result.latencyMs}ms | OrderID: ${orderId}`);

          if (canonicalExecution) {
            await persistCanonicalSubmission({
              execution: canonicalExecution,
              executor: 'polymarket-clob',
              submissionType: 'order',
              submissionId: orderId
            });
            if (result.executionStatus === 'filled' || result.executionStatus === 'partial') {
              await persistCanonicalFill({
                execution: canonicalExecution,
                evidenceType: 'venue_fill',
                evidenceId: `order:${orderId}`,
                baseQuantity: result.shares.toString(),
                quoteQuantity: result.spendAmountUsd.toString(),
                priceUsd: result.averagePrice?.toString() ?? null,
                completesExecution: true
              });
            }
          }

          const executionStatus = result.executionStatus === 'filled'
            ? 'filled'
            : result.executionStatus === 'partial'
              ? 'partial'
              : 'pending_confirmation';
          const confirmedFill = executionStatus === 'filled' || executionStatus === 'partial';

          liveTradeId = await persistTrade({
            signalId: payload.signalId,
            sourceTradeId: payload.sourceTradeId,
            copyExecutionId: canonicalExecution?.id,
            tokenMint: payload.tokenMint,
            size: result.requestedSpendAmountUsd,
            requestedAmountUsd: result.requestedSpendAmountUsd,
            amountUsd: confirmedFill ? executedSize : null,
            tokenAmount: confirmedFill ? result.shares : null,
            priceUsd: confirmedFill ? result.averagePrice : null,
            feeUsd: confirmedFill ? result.feesUsd : null,
            chain,
            executionMode: 'live',
            direction,
            executor: 'polymarket-clob',
            signature: settlementHash,
            venueOrderId: orderId,
            venueStatus: result.status,
            venueTradeIds: result.tradeIds,
            settlementTransactionHashes: result.settlementTransactionHashes,
            status: executionStatus,
            slippageBps: result.slippageBps,
            submittedAt,
            confirmedAt: confirmedFill ? new Date() : undefined
          });

          liveResult = {
            status: confirmedFill ? 'live-executed' : 'submitted',
            signalId:  payload.signalId,
            tokenMint: payload.tokenMint,
            size: executedSize,
            signature: orderId
          };
        } catch (error: unknown) {
          if (
            error instanceof UnrecoverableError &&
            (error.message.includes('Polymarket Protection') || error.message.includes('No asks'))
          ) {
            console.warn(`[trade-executor] LIVE: Skipped Polymarket trade due to conditions: ${error.message}`);
            liveTradeId = await persistTrade({
              signalId: payload.signalId,
              sourceTradeId: payload.sourceTradeId,
              copyExecutionId: canonicalExecution?.id,
              tokenMint: payload.tokenMint,
              size,
              chain,
              executionMode: 'live',
              direction,
              executor: 'polymarket-clob',
              status: 'skipped',
              errorMessage: error.message
            });
            liveResult = {
              status: 'skipped',
              reason: 'Polymarket Rules Failed'
            };
            await terminateCanonicalExecution(canonicalExecution, error.message, 'cancelled');
          } else {
            throw error;
          }
        }
      } else {
        throw new UnrecoverableError(`Live execution for ${chain} is missing certified implementation`);
      }
    }


    // 2. PAPER / SHADOW EXECUTION PATH
    const liveWasConfirmed = liveResult?.status === 'live-executed';
    if (
      execMode === 'live+shadow'
      && payload.sourceTradeId
      && !canonicalExecutions.shadow
      && liveWasConfirmed
    ) {
      console.error(
        `[trade-executor] Shadow preparation skipped for source ${payload.sourceTradeId}: ` +
        `${canonicalShadowReason ?? 'canonical shadow execution is unavailable'}`
      );
      return liveResult ?? { status: 'live-executed', signalId: payload.signalId };
    }
    if (execMode === 'paper' || (execMode === 'live+shadow' && liveTradeId && liveWasConfirmed)) {
      const submittedAt = new Date();
      const paperExecution = execMode === 'live+shadow'
        ? canonicalExecutions.shadow
        : canonicalExecutions.paper;
      try {
      if (paperExecution?.state === 'confirmed') {
        paperResult = { status: 'already-executed', signalId: payload.signalId };
        return liveResult || paperResult || { status: 'already-executed' };
      }
      if (paperExecution && canonicalExecutionIsPending(paperExecution)) {
        return liveResult || { status: 'submitted', state: paperExecution.state };
      }
      let jupiterFill: JupiterSimulatedFill | null = null;

      let simulatedVia = 'spot-price';
      let simTokenAmount: number | null = null;
      let simBaseQuantity: string | null = paperExecution?.direction === 'sell'
        ? paperExecution.requestedBaseQuantity
        : null;
      let simAmountUsd: number | undefined;
      let simPriceUsd: number | null = null;
      let simExecutor = 'paper';

      if (chain === 'solana' && direction === 'buy') {
        const outputDecimals = await getTokenDecimals(payload.tokenMint, 'solana');
        if (outputDecimals === null) {
          console.warn(
            `[trade-executor] token decimals unavailable; skipping Jupiter quantity simulation for ${payload.tokenMint}`
          );
        } else {
          jupiterFill = await getJupiterSimulatedFill(
            {
              inputMint: SOL_MINT,
              outputMint: cleanMint,
              amountLamports: Math.round(size * 1e9),
              slippageBps: 150
            },
            outputDecimals,
            JUPITER_API_KEY
          );
          if (jupiterFill) {
            simulatedVia = 'jupiter';
            simExecutor = 'jupiter-sim';
            simTokenAmount = jupiterFill.tokenAmount;
            simBaseQuantity = jupiterFill.tokenAmount.toString();
            console.log(
              `[trade-executor] PAPER (jupiter-sim): ${payload.tokenMint} | ` +
              `${size} SOL → ${jupiterFill.tokenAmount.toFixed(4)} tokens | ` +
              `impact: ${jupiterFill.priceImpactPct}%`
            );
          }
        }
      } else if (chain === 'polygon') {
        const tradeSide = direction === 'buy' ? OrderSide.BUY : OrderSide.SELL;
        const targetPrice = await getPolymarketAskPrice(cleanMint, tradeSide);
        if (targetPrice > 0.95 || targetPrice < 0.05) {
          throw new Error(`Paper Simulation aborted: Price ${targetPrice} outside bounds`);
        }
        simulatedVia = 'polymarket-book';
        simExecutor = 'polymarket-sim';
        simTokenAmount = direction === 'sell'
          ? paperExecution
            ? Number(paperExecution.requestedBaseQuantity)
            : size / targetPrice
          : size / targetPrice;
        simBaseQuantity = simTokenAmount.toString();
        simPriceUsd = targetPrice;
        simAmountUsd = simTokenAmount * targetPrice;
        console.log(`[trade-executor] PAPER (polymarket-sim): ${payload.tokenMint} | Size: $${simAmountUsd} | Est Price: $${targetPrice}`);
      } else if (chain === 'robinhood-chain' && (direction === 'buy' || paperExecution)) {
        const tokenDecimals = await getTokenDecimals(payload.tokenMint, 'robinhood-chain');
        if (tokenDecimals === null) throw new Error('Robinhood token decimals are unavailable');
        const amountIn = direction === 'buy'
          ? BigInt(Math.floor(size * 1e18))
          : decimalQuantityToBaseUnits(paperExecution?.requestedBaseQuantity ?? '', tokenDecimals);
        const quoteWei = direction === 'buy'
          ? await getRobinhoodQuote(WETH_ROBINHOOD, cleanMint, amountIn, 3000)
          : await getRobinhoodQuote(cleanMint, WETH_ROBINHOOD, amountIn, 3000);
        simulatedVia = 'robinhood-quoter';
        simExecutor = 'robinhood-sim';
        if (direction === 'buy') {
          simBaseQuantity = formatUnits(quoteWei, tokenDecimals);
          simTokenAmount = Number(simBaseQuantity);
        } else {
          simBaseQuantity = paperExecution?.requestedBaseQuantity ?? null;
          simTokenAmount = simBaseQuantity ? Number(simBaseQuantity) : null;
        }
        console.log(`[trade-executor] PAPER (robinhood-sim): ${payload.tokenMint} | Size: ${size} ETH -> Out: ${quoteWei} units`);
      }

      if (simulatedVia === 'spot-price') {
        if (paperExecution) {
          simPriceUsd = await fetchTokenPriceUsd(payload.tokenMint);
          if (!simPriceUsd || simPriceUsd <= 0) {
            throw new Error('Spot-price simulation lacks a positive token price');
          }
          if (direction === 'buy') {
            if (chain === 'solana') {
              const nativePrice = await getCachedSolPrice();
              if (!nativePrice) throw new Error('Spot-price simulation lacks a SOL price');
              simAmountUsd = size * nativePrice;
            } else if (chain === 'robinhood-chain') {
              const nativePrice = await getCachedEthPrice();
              if (!nativePrice) throw new Error('Spot-price simulation lacks an ETH price');
              simAmountUsd = size * nativePrice;
            } else {
              simAmountUsd = size;
            }
            simBaseQuantity = (simAmountUsd / simPriceUsd).toString();
          } else {
            simBaseQuantity = paperExecution.requestedBaseQuantity;
            simAmountUsd = Number(simBaseQuantity) * simPriceUsd;
          }
          simTokenAmount = Number(simBaseQuantity);
        }
        console.log(
          `[trade-executor] PAPER (spot-price fallback): ${payload.tokenMint} | ${size} base units (score: ${payload.score})`
        );
      }

      const confirmedAt = new Date();

      if (paperExecution) {
        if (!simBaseQuantity || Number(simBaseQuantity) <= 0) {
          throw new Error('Paper simulation did not produce a positive token quantity');
        }
        await transitionCopyExecution({
          executionId: paperExecution.id,
          nextState: 'simulated',
          simulationId: `${simExecutor}:${paperExecution.clientOrderId}`
        });
        await persistCanonicalFill({
          execution: paperExecution,
          evidenceType: 'paper_simulation',
          evidenceId: `${simExecutor}:${paperExecution.clientOrderId}`,
          baseQuantity: simBaseQuantity,
          quoteQuantity: simAmountUsd?.toString() ?? null,
          priceUsd: simPriceUsd?.toString() ?? null,
          occurredAt: confirmedAt
        });
      }

      await persistTrade({
        signalId: payload.signalId,
        sourceTradeId: payload.sourceTradeId,
        copyExecutionId: paperExecution?.id,
        tokenMint: payload.tokenMint,
        size,
        amountUsd: simAmountUsd ?? (chain === 'polygon' ? size : undefined),
        chain,
        executionMode: execMode === 'live+shadow' ? 'shadow' : 'paper',
        direction,
        executor: simExecutor,
        jupiterFill,
        tokenAmount: simTokenAmount,
        shadowOf: execMode === 'live+shadow' ? liveTradeId : undefined,
        submittedAt,
        confirmedAt
      });

      paperResult = {
        status:    'paper-filled',
        signalId:  payload.signalId,
        tokenMint: payload.tokenMint,
        size,
        mode:      'paper',
        simulatedVia
      };
      } catch (paperError: unknown) {
        const message = paperError instanceof Error ? paperError.message : String(paperError);
        console.error(`[trade-executor] Shadow execution failed: ${message}`);
        await terminateCanonicalExecution(paperExecution, message);
        if (execMode === 'paper') {
          if (!payload.sourceTradeId) await releaseSignalClaim(payload.signalId);
          paperResult = { status: 'skipped', reason: `Paper simulation failed: ${message}` };
        }
      }
    }


    return liveResult || paperResult || { status: 'skipped', reason: 'Unknown execution mode' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await Promise.allSettled(
      Object.values(canonicalExecutions).map((execution) =>
        terminateCanonicalExecution(execution, message)
      )
    );
    if (!payload.sourceTradeId) await releaseSignalClaim(payload.signalId).catch(() => {});
    throw err;
  }
}

export async function main() {
  initLogger('trade-executor');
  console.log('[trade-executor] Starting executor worker...');
  const redisClient = getRedis();
  configureRobinhoodOpsAlerts(redisClient);

  let robinhoodRuntime: RobinhoodRuntime | null = null;
  let robinhoodRuntimeError: Error | null = null;
  try {
    robinhoodRuntime = createRobinhoodRuntime(redisClient);
  } catch (error) {
    robinhoodRuntimeError = error instanceof Error ? error : new Error(String(error));
  }
  await verifyRobinhoodEnvironment({
    runtimeCheck: () => {
      if (!robinhoodRuntime) {
        throw robinhoodRuntimeError ?? new Error('Robinhood live runtime is unavailable');
      }
    }
  });

  let trojanRuntime: TrojanRuntime | null = null;
  try {
    trojanRuntime = createTrojanRuntimeFromEnvironment(redisClient);
    configureTrojanRuntime(trojanRuntime);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    setTrojanRuntimeUnavailable(reason);
  }

  await verifyPolymarketEnvironment().catch(err => {
    console.error(`[trade-executor] Polymarket startup check failed: ${err.message}`);
  });

  let reconciliationRunning = false;
  const reconcilePending = async () => {
    if (reconciliationRunning) return;
    reconciliationRunning = true;
    try {
      const tasks: ChainReconciliationTask[] = [];
      if (robinhoodRuntime) {
        tasks.push({
          chain: 'robinhood-chain',
          run: () => runRobinhoodReconciliation(robinhoodRuntime)
        });
      }
      if (trojanRuntime) {
        tasks.push({ chain: 'solana', run: () => runTrojanReconciliation(trojanRuntime) });
      }
      await runChainReconciliations(tasks);
    } finally {
      reconciliationRunning = false;
    }
  };
  await reconcilePending().catch((error) => {
    console.error('[trade-executor] startup reconciliation failed', error);
  });
  const tradeWorker = new Worker(
    'swat-trades',
    (job) => executeJobWithCircuitBreaker(job),
  { connection: redisClient, concurrency: 3, autorun: true }
);

tradeWorker.on('failed', (_job, err) => {
  console.error('[trade-executor] job failed', err?.message);
});
tradeWorker.on('error', (err) => {
  console.error('[trade-executor] worker error', err);
});

setInterval(() => {
  reconcilePending().catch((error) => {
    console.error('[trade-executor] periodic reconciliation failed', error);
  });
}, 60_000);

setInterval(() => {
  pollPolymarketOrders().catch(() => {});
}, 60_000);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('[trade-executor] fatal startup failure', error);
    process.exitCode = 1;
  });
}
