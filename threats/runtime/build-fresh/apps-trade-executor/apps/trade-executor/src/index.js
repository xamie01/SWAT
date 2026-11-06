import { pathToFileURL } from 'node:url';
import { DelayedError, UnrecoverableError, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { DEFAULT_RISK_CONFIG, chainFromTokenMint, fetchTokenPriceUsd, getJupiterSimulatedFill, initLogger, isChain, REDIS_CHANNELS, resolveSlippageBps } from '@swat/shared';
import { claimCircuitBreakerProbe, claimCopyExecutionsForReconciliation, claimSourceSignalForCopyExecution, claimSignalForExecution, getRollingExposureUsd, getCanonicalSourceTradeById, getTokenDecimals, hasRecentBuy, insertTrade, insertTradeAndMarkSignalExecuted, insertTradeAndReleaseSignalClaim, loadCopyEligibilityFacts, query, recordCopyEligibilityRejection, resolveRiskPolicy, readCircuitBreakerState, recordCopyExecutionEvidence, recordCircuitBreakerFailure, recordCircuitBreakerSuccess, releaseSignalClaim, releaseCopyExecutionReconciliationClaim, resolveChainMode, transitionCopyExecution, accrueMasterCapacityFillNotional, getCopyExecutionById, claimPolymarketPositionExit, confirmPolymarketPositionExit, releasePolymarketPositionExit, releaseStalePolymarketPositionExits, valuateChainNativeQuoteLeg, deriveFillPriceUsd, nativeQuoteCurrencyForChain, withEvmNonceLock, withTransaction } from '@swat/db';
import { calculateBalanceAwareSize, capPositionToAvailableBalance, parseNonNegativeNumber, parsePositiveNumber, parseScore } from './policy.js';
import { fetchSolanaBalanceSol } from './balances.js';
import { configureRobinhoodRuntime, createViemRobinhoodAdapter, getRobinhoodLiveReadiness, getRobinhoodSpendableEth, getRobinhoodQuote, parseRobinhoodExecutionConfig, reconcileRobinhoodPending, robinhoodPublicClient, triggerRobinhood, evmAccount, NonceContentionError, WETH_ROBINHOOD } from './robinhood.js';
import { configureRobinhoodOpsAlertEmitter, verifyRobinhoodEnvironment } from './robinhood-startup.js';
import { createRedisRobinhoodPendingStore, createRobinhoodSafetyAssessment } from './robinhood-runtime.js';
import { triggerPolymarket, pollPolymarketOrders, reconcilePolymarketExecution, getPolymarketAskPrice, getPolymarketAvailableBalance, getPolymarketLiveReadiness, getPolymarketClientIfReady, simulatePolymarketBookFill, runPolymarketExitEscalationSweep } from './polymarket.js';
import { polymarketSigner, resolvePolymarketIdentity } from './polymarket.js';
import { OrderSide } from '@polymarket/client';
import { verifyPolymarketEnvironment } from './polymarket-startup.js';
import { formatUnits, parseAbi } from 'viem';
import { configureTrojanRuntime, createTrojanRuntimeFromEnvironment, getTrojanLiveReadiness, setTrojanRuntimeUnavailable, triggerTrojan } from './trojan-runtime.js';
import { createJupiterJitoRuntimeFromEnvironment, getConfiguredJupiterJitoRuntime, getJupiterJitoLiveReadiness, getJupiterJitoSigner } from './jupiter-jito-config.js';
import { dispatchSolanaTrade } from './solana-dispatch.js';
import { resolveSolanaExecutor, shouldUseJupiterJito } from './solana-executor-selection.js';
import { runPolymarketRedemptionSweep } from './polymarket-redemption.js';
import { decimalQuantityToBaseUnits, executionModesForChainMode, resolvePaperCopyTargetAccount, sourceSellFractionToBps } from './canonical-copy.js';
import { COPY_ELIGIBILITY_ACCOUNT, enforceCopyEligibility } from './copy-eligibility.js';
import { RECONCILIATION_ACCOUNT, runReconciliationCoordinator } from './reconciliation-coordinator.js';
import { createEvmReceiptReconciler, createPolymarketReconciler, createSolanaConfirmationReconciler } from './reconciliation-venues.js';
import { misroutedJobWarning, tradeWorkerSpecs } from './trade-workers.js';
import { createExecutionAuthorityRegistry } from './execution-authority.js';
import { createExecutionAuthorityAdapters } from './execution-authority-adapters.js';
import { riskPolicyAccountForUser } from './per-user-sizing.js';
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
/**
 * Whose risk policy sizing resolves.
 *
 * Deliberately a separate constant from `RECONCILIATION_ACCOUNT`, even though both
 * are `'operator'` today, because they diverge at Stage 4 and in opposite
 * directions. This one **becomes the user id** under fan-out — it is a tenancy
 * key, and per-user sizing is exactly the point. `RECONCILIATION_ACCOUNT` must
 * **stay** `'operator'`: it is an escalation label, and `copy_executions.target_account`
 * holds a wallet address, so filtering it by an account value claims zero rows.
 * Collapsing the two into one shared constant is how that distinction gets lost.
 */
const RISK_POLICY_ACCOUNT = 'operator';
let redis = null;
function getRedis() {
    if (!redis)
        redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
    return redis;
}
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const TROJAN_WALLET_ADDRESS = process.env.TROJAN_WALLET_ADDRESS;
const JUPITER_API_KEY = process.env.JUPITER_API_KEY || undefined;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const BASE_POSITION_SOL = parseFloat(process.env.BASE_POSITION_SOL ?? '0.5');
const MAX_POSITION_SOL = parseFloat(process.env.MAX_POSITION_SOL ?? '5');
const AUTO_EXECUTE = process.env.AUTO_EXECUTE === 'true';
const AUTO_EXECUTE_MIN_SCORE = parseScore(process.env.AUTO_EXECUTE_MIN_SCORE ?? 85, 'AUTO_EXECUTE_MIN_SCORE');
const REBUY_COOLDOWN_MINUTES = parseNonNegativeNumber(process.env.REBUY_COOLDOWN_MINUTES, 60, 'REBUY_COOLDOWN_MINUTES');
const HELIUS_RPC_TIMEOUT_MS = parsePositiveNumber(process.env.HELIUS_RPC_TIMEOUT_MS, 15_000, 'HELIUS_RPC_TIMEOUT_MS');
const SOLANA_GAS_RESERVE_SOL = parseNonNegativeNumber(process.env.SOLANA_GAS_RESERVE_SOL, 0.01, 'SOLANA_GAS_RESERVE_SOL');
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
async function getCachedSolPrice() {
    const client = getRedis();
    const cached = await client.get('sol:price');
    if (cached) {
        const p = parseFloat(cached);
        if (Number.isFinite(p))
            return p;
    }
    const price = await fetchTokenPriceUsd(SOL_MINT);
    if (price === null || !Number.isFinite(price))
        return null;
    await client.setex('sol:price', 30, price.toString());
    return price;
}
async function getCachedEthPrice() {
    const client = getRedis();
    const cached = await client.get('eth:price');
    if (cached) {
        const p = parseFloat(cached);
        if (Number.isFinite(p))
            return p;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
        const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd', { signal: controller.signal });
        if (!response.ok)
            return null;
        const data = await response.json();
        const price = data.ethereum?.usd;
        if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0)
            return null;
        await client.setex('eth:price', 30, price.toString());
        return price;
    }
    catch (error) {
        console.error('[trade-executor] ETH price lookup failed', error);
        return null;
    }
    finally {
        clearTimeout(timer);
    }
}
async function getCachedBnbPrice() {
    const client = getRedis();
    const cached = await client.get('bnb:price');
    if (cached) {
        const p = parseFloat(cached);
        if (Number.isFinite(p))
            return p;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
        const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=binancecoin&vs_currencies=usd', { signal: controller.signal });
        if (!response.ok)
            return null;
        const data = await response.json();
        const price = data.binancecoin?.usd;
        if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0)
            return null;
        await client.setex('bnb:price', 30, price.toString());
        return price;
    }
    catch (error) {
        console.error('[trade-executor] BNB price lookup failed', error);
        return null;
    }
    finally {
        clearTimeout(timer);
    }
}
/**
 * USD price of one unit of a chain's native quote currency.
 *
 * The `nativeQuoteCurrencyForChain` switch is what decides which feed to ask, so
 * adding a chain cannot silently skip its conversion: the currency map and the
 * price lookup are the same decision, made once (S4-M35).
 */
async function nativeUsdPriceForChain(chain) {
    switch (nativeQuoteCurrencyForChain(chain)) {
        case 'SOL':
            return getCachedSolPrice();
        case 'ETH':
            return getCachedEthPrice();
        case 'BNB':
            return getCachedBnbPrice();
        case 'USD':
            return 1;
        default:
            return null;
    }
}
// ─── Trade persistence ─────────────────────────────────────────────────────────
export async function persistTrade(opts) {
    const status = opts.status ?? 'filled';
    const hasConfirmedFill = status === 'filled' || status === 'partial';
    const tokenPrice = hasConfirmedFill
        ? opts.priceUsd ?? await fetchTokenPriceUsd(opts.tokenMint)
        : null;
    let amountUsd = hasConfirmedFill ? opts.amountUsd ?? null : null;
    if (hasConfirmedFill && amountUsd === null) {
        // One conversion rule (S4-M35). `valuateChainNativeQuoteLeg` owns both the
        // chain -> unit map (Solana x SOL price, robinhood x ETH price, polygon
        // already USD) and the multiplication, and the copy-evidence write path in
        // `packages/db` calls the same function, so the two cannot drift apart. This
        // block used to be that map, inlined.
        const valuation = valuateChainNativeQuoteLeg({
            chain: opts.chain,
            amount: opts.size,
            nativeUsdPrice: await nativeUsdPriceForChain(opts.chain)
        });
        // Behaviour deliberately unchanged here: an unavailable native price has always
        // written 0 into `trades.amount_usd`, and revisiting that is a separate call
        // from S4-M35, whose subject is `copy_execution_evidence`. The unknown is not
        // lost -- it is `valuation.code`, and the evidence path stores it as NULL.
        amountUsd = valuation.usdAmount === null ? 0 : Number(valuation.usdAmount);
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
export function clampExecutionModeForStartup(chain, effectiveMode, reason) {
    if (chain === 'polygon' &&
        (effectiveMode === 'live' || effectiveMode === 'live+shadow') &&
        !getPolymarketLiveReadiness().ready) {
        return {
            effectiveMode: 'paper',
            reason: `Polygon startup attestation failed: ${getPolymarketLiveReadiness().reason}`
        };
    }
    if (chain === 'robinhood-chain' &&
        (effectiveMode === 'live' || effectiveMode === 'live+shadow') &&
        !getRobinhoodLiveReadiness().ready) {
        return {
            effectiveMode: 'paper',
            reason: `Robinhood startup attestation failed: ${getRobinhoodLiveReadiness().reason}`
        };
    }
    if (chain === 'solana' &&
        (effectiveMode === 'live' || effectiveMode === 'live+shadow')) {
        // Solana may execute live through either path. Trojan is the legacy one and
        // retires once Jupiter+Jito is certified (S3-6); until then EITHER being
        // ready is sufficient, so enabling the new path does not require the old
        // one to still be configured, and vice versa.
        const jito = getJupiterJitoLiveReadiness();
        const trojan = getTrojanLiveReadiness();
        if (!jito.ready && !trojan.ready) {
            return {
                effectiveMode: 'paper',
                reason: `Solana runtime readiness failed: jupiter-jito=${jito.reason}; trojan=${trojan.reason}`
            };
        }
    }
    return { effectiveMode, reason };
}
const TIER_MULTIPLIER = {
    elite: 1.0,
    pro: 0.75,
    promising: 0.5,
    speculative: 0.25
};
function getSizingConfig(chain, sizingMode) {
    const paperRiskPct = process.env.PAPER_MAX_POSITION_PCT;
    const usePaperRisk = sizingMode === 'paper' && paperRiskPct !== undefined;
    if (chain === 'solana') {
        return {
            base: BASE_POSITION_SOL,
            maximum: MAX_POSITION_SOL,
            riskPct: parseNonNegativeNumber(usePaperRisk ? paperRiskPct : undefined, 5, 'PAPER_MAX_POSITION_PCT'),
            precision: 4
        };
    }
    if (chain === 'polygon') {
        return {
            base: parsePositiveNumber(process.env.BASE_POSITION_USDC, 100, 'BASE_POSITION_USDC'),
            maximum: parsePositiveNumber(process.env.MAX_POSITION_USDC, 500, 'MAX_POSITION_USDC'),
            riskPct: parseNonNegativeNumber(usePaperRisk ? paperRiskPct : process.env.USDC_BALANCE_RISK_PCT, 2, usePaperRisk ? 'PAPER_MAX_POSITION_PCT' : 'USDC_BALANCE_RISK_PCT'),
            precision: 2
        };
    }
    return {
        base: parsePositiveNumber(process.env.BASE_POSITION_ETH, 0.05, 'BASE_POSITION_ETH'),
        maximum: parsePositiveNumber(process.env.MAX_POSITION_ETH, 0.5, 'MAX_POSITION_ETH'),
        riskPct: parseNonNegativeNumber(usePaperRisk ? paperRiskPct : process.env.ETH_BALANCE_RISK_PCT, 2, usePaperRisk ? 'PAPER_MAX_POSITION_PCT' : 'ETH_BALANCE_RISK_PCT'),
        precision: 6
    };
}
/**
 * Spendable balance for sizing, or `null` when it cannot be established.
 *
 * `null` rather than `0` (S4-M41/S4-M48): a zero balance means "you have nothing
 * to trade with", while null means "we could not find out". Sizing must refuse on
 * the second, and a caller that coalesces them turns a price-feed outage into a
 * confident decision not to trade.
 */
async function getAvailablePositionBalance(opts) {
    if (opts.sizingMode === 'paper') {
        const bankrollUsd = parsePositiveNumber(process.env.PAPER_BANKROLL_USD, 10_000, 'PAPER_BANKROLL_USD');
        if (opts.chain === 'polygon')
            return bankrollUsd;
        // A fabricated rate silently mis-scales every size derived from it, and the
        // symptom is a position that looks deliberate. `?? 150` for SOL and `?? 3000`
        // for ETH were doing exactly that on any price-feed failure -- at a real SOL
        // price of 300 the fallback halves every paper size, which reads as a
        // conservative setting rather than a broken feed.
        //
        // Returning null propagates "unknown" to the caller, which refuses rather
        // than sizing. Same rule as S4-M41 and `resolveKnownBalanceUsd`: unknown is
        // never a number.
        const nativeMint = opts.chain === 'solana' ? SOL_MINT : WETH_ROBINHOOD;
        const nativePrice = await fetchTokenPriceUsd(nativeMint);
        if (nativePrice === null || !Number.isFinite(nativePrice) || nativePrice <= 0) {
            console.warn(`[trade-executor] no usable ${opts.chain} native price; paper bankroll is `
                + 'unassessable rather than sized against a fabricated rate');
            return null;
        }
        return bankrollUsd / nativePrice;
    }
    if (opts.chain === 'solana') {
        if (!TROJAN_WALLET_ADDRESS) {
            throw new UnrecoverableError('TROJAN_WALLET_ADDRESS is required to verify Solana live balance');
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
        if (opts.direction === 'buy')
            return balance;
        const bidPrice = await getPolymarketAskPrice(opts.tokenMint, OrderSide.SELL);
        return balance * bidPrice;
    }
    return getRobinhoodSpendableEth();
}
export async function getBalanceAwarePositionSize(score, chain, clusterTier, sizingMode, direction, tokenMint, 
/**
 * Whose money is being sized (`S4-15`/`S4-16`). `null` is the pre-tenancy
 * operator path, which ADR-0001 leaves at `user_id NULL` and never backfills.
 *
 * Optional so the six-argument callers keep compiling, and defaulted to `null`
 * rather than to some ambient current user: a sizing call that forgot to pass a
 * tenant must size the OPERATOR's account, which is loud and wrong, rather than
 * silently size one user off another's risk percentage.
 */
userId = null) {
    const tierMult = TIER_MULTIPLIER[clusterTier] ?? 0.5;
    const scoreMult = score >= 90 ? 1.0 : score >= 80 ? 0.75 : 0.5;
    const envConfig = getSizingConfig(chain, sizingMode);
    // The DB risk policy applies in EVERY mode, not just paper (`S4-P2`).
    //
    // This branch used to read `if (sizingMode === 'paper')`, so live sizing silently
    // ignored the policy and used the env value. With one operator whose env and DB
    // agree that is invisible; under fan-out the per-user risk percentage exists
    // *only* in the database, so live sizing would size every user off one env
    // constant — the opposite of "exposure proportional to what they agreed to".
    //
    // Resolution failure is fatal rather than a warn-and-default (`Principle 3`).
    // Defaulting substitutes a risk percentage the account never agreed to, which is
    // a wrong-sized real trade. Throwing costs one skipped signal.
    // The account is the tenancy seam. `riskPolicyAccountForUser` returns the user
    // id for a tenant and `RISK_POLICY_ACCOUNT` for the operator path, and it throws
    // on a blank string rather than quietly keying on the operator -- which is what
    // makes "I forgot to thread the id" a failure rather than a cross-tenant read.
    const policy = await resolveRiskPolicy(riskPolicyAccountForUser(userId), chain);
    const config = { ...envConfig, riskPct: policy.maxPositionPct };
    const balance = await getAvailablePositionBalance({
        chain,
        sizingMode,
        direction,
        tokenMint
    });
    // Unknown is not zero. Returning 0 here would read downstream as "sized to
    // nothing", indistinguishable from a deliberate skip; sizing must refuse
    // instead, so the caller sees a size of 0 only when the balance is genuinely 0.
    if (balance === null) {
        console.warn(`[trade-executor] spendable balance unassessable for ${chain}; refusing to size`);
        return 0;
    }
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
/**
 * Binds the chain to the Postgres advisory lock (`S4-M12`).
 *
 * The chain is bound here rather than inside `robinhood.ts` so that module stays
 * free of `@swat/db` and chain constants — and so the identical port serves
 * Polymarket's `polygon` signer later without a second implementation.
 */
const robinhoodNonceLock = (account, run) => withEvmNonceLock({ chain: 'robinhood-chain', account, run });
const ownerAbi = parseAbi(['function owner() view returns (address)']);
export function createRobinhoodRuntime(redisClient) {
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
        }),
        // `verifySource`, `readHolderConcentration`, and `probeFeeOnTransfer` are
        // deliberately left unset: Robinhood Chain has no reviewed explorer
        // source-verification or holder-distribution provider configured, and there
        // is no transfer-tax probe. Each check therefore reports `unknown` and
        // unreliable, which does not block an order. Wiring a provider here is all
        // that is needed to turn any of them into a hard gate — see G2-R5.
        maxTransferFeeBps: Number(process.env.ROBINHOOD_MAX_TRANSFER_FEE_BPS ?? '0')
    });
    configureRobinhoodRuntime({ pendingStore, safetyAssessment, nonceLock: robinhoodNonceLock });
    return { adapter, config, pendingStore, safetyAssessment, nonceLock: robinhoodNonceLock };
}
function configureRobinhoodOpsAlerts(redisClient) {
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
async function transitionPendingTrade(input) {
    if (!input.signalId && !input.signature) {
        throw new Error('A signal ID or transaction identity is required to reconcile a pending trade');
    }
    await withTransaction(async (client) => {
        const result = await client.query(`UPDATE trades
          SET status = $3,
              error_message = $4,
              signature = COALESCE($5, signature),
              confirmed_at = CASE WHEN $3 = 'filled' THEN COALESCE($6, NOW()) ELSE confirmed_at END
        WHERE executor = $1
          AND status = 'pending_confirmation'
          AND (($2::uuid IS NOT NULL AND signal_id = $2::uuid)
            OR ($2::uuid IS NULL AND signature = $5))
      RETURNING signal_id`, [
            input.executor,
            input.signalId ?? null,
            input.status,
            input.errorMessage ?? null,
            input.signature ?? null,
            input.confirmedAt ?? null
        ]);
        const signalIds = [...new Set(result.rows.flatMap((row) => row.signal_id ? [row.signal_id] : []))];
        if (signalIds.length > 0) {
            if (input.status === 'filled') {
                await client.query(`UPDATE signals
              SET status = 'executed', executed_at = NOW()
            WHERE id = ANY($1::uuid[])`, [signalIds]);
            }
            else {
                await client.query(`UPDATE signals SET status = 'pending'
            WHERE id = ANY($1::uuid[]) AND status = 'executing'`, [signalIds]);
            }
        }
    });
}
export async function runRobinhoodReconciliation(runtime) {
    const outcomes = await reconcileRobinhoodPending({
        adapter: runtime.adapter,
        pendingStore: runtime.pendingStore,
        config: runtime.config,
        safetyAssessment: runtime.safetyAssessment,
        nonceLock: runtime.nonceLock
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
        }
        else if (outcome.status === 'failed' && outcome.state !== 'rpc_failure') {
            await transitionPendingTrade({
                executor: 'robinhood-univ3',
                signalId: outcome.clientOrderId,
                signature: outcome.transactionHash,
                status: 'failed',
                errorMessage: outcome.reason
            });
        }
        else if (outcome.status === 'pending_confirmation') {
            await query(`UPDATE trades
            SET signature = $2,
                venue_status = $3
          WHERE executor = 'robinhood-univ3'
            AND signal_id = $1
            AND status = 'pending_confirmation'`, [outcome.clientOrderId, outcome.transactionHash, outcome.stage]);
        }
        else if (outcome.status === 'skipped' && outcome.clientOrderId) {
            await transitionPendingTrade({
                executor: 'robinhood-univ3',
                signalId: outcome.clientOrderId,
                status: 'failed',
                errorMessage: outcome.reason
            });
        }
        else if (outcome.status === 'approval_confirmed') {
            await query(`UPDATE trades SET venue_status = 'approval_confirmed'
          WHERE executor = 'robinhood-univ3'
            AND signal_id = $1
            AND status = 'pending_confirmation'`, [outcome.clientOrderId]);
        }
    }
    return outcomes;
}
export async function runChainReconciliations(tasks) {
    const results = await Promise.allSettled(tasks.map((task) => task.run()));
    results.forEach((result, index) => {
        if (result.status === 'rejected') {
            console.error(`[trade-executor] ${tasks[index].chain} reconciliation failed`, result.reason);
        }
    });
}
/**
 * Build the venue handlers the canonical coordinator routes to.
 *
 * A chain is only included when its live runtime exists. Omitting one is
 * deliberate and safe: the coordinator counts that execution `unsupported` and
 * reschedules it, so the row survives until a process that *can* probe the venue
 * claims it, rather than being resolved by a process with no evidence.
 */
export function buildVenueReconcilers(input) {
    const reconcilers = {};
    if (input.robinhoodRuntime) {
        const adapter = input.robinhoodRuntime.adapter;
        reconcilers['robinhood-chain'] = createEvmReceiptReconciler({
            probe: async (hash) => {
                const receipt = await adapter.getReceipt(hash);
                return receipt ? { status: receipt.status } : null;
            }
        });
    }
    if (input.trojanRuntime?.readConfirmation) {
        const readConfirmation = input.trojanRuntime.readConfirmation;
        reconcilers.solana = createSolanaConfirmationReconciler({
            probe: (signature) => readConfirmation(signature)
        });
    }
    if (input.polymarketReady) {
        reconcilers.polygon = createPolymarketReconciler({
            probe: (executionId) => reconcilePolymarketExecution(executionId)
        });
    }
    return reconcilers;
}
/**
 * Publish an execution that has burned every reconciliation attempt.
 *
 * Nothing else will ever claim the row, so without this it would sit ambiguous
 * and unnoticed. This does not resolve the execution — deciding a money-moving
 * state without venue evidence is exactly what must not happen automatically.
 */
function escalateStuckExecution(redisClient) {
    return async (execution, reason) => {
        console.error(`[trade-executor] execution ${execution.id} exhausted reconciliation attempts: ${reason}`);
        await redisClient.publish(REDIS_CHANNELS.alertQueue, JSON.stringify({
            type: 'RECONCILIATION_EXHAUSTED',
            title: `Unreconciled ${execution.chain} execution needs review`,
            message: `Execution ${execution.id} (${execution.direction} ${execution.tokenMint}) is still `
                + `in state ${execution.state} after ${execution.reconciliationAttempts} attempts.\n`
                + `Submission: ${execution.submissionType ?? 'none'} ${execution.submissionId ?? 'unknown'}\n`
                + `Client order id: ${execution.clientOrderId}\n`
                + `Reason: ${reason}\n`
                + 'It will not be retried automatically. Confirm the venue state by hand.',
            severity: 'high',
            chain: execution.chain
        }));
    };
}
const successfulBreakerOutcomes = new Set([
    'already-executed',
    'live-executed',
    'paper-filled',
    'submitted'
]);
const failedBreakerOutcomes = new Set(['failed', 'rejected']);
function chainFromJob(job) {
    const payload = job.data;
    const tokenMint = typeof payload?.tokenMint === 'string' ? payload.tokenMint : '';
    // Shared with the producers (`tradeQueueForTokenMint`) rather than
    // reimplemented here: since S3-25 the producer picks the queue with this same
    // derivation, and the two ends disagreeing would put a job on a queue whose
    // worker serves a different venue.
    try {
        return chainFromTokenMint(tokenMint);
    }
    catch (error) {
        throw new UnrecoverableError(error instanceof Error ? error.message : String(error));
    }
}
async function delayForCircuitBreaker(job, chain, trippedAt) {
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
export async function executeJobWithCircuitBreaker(job, execute = handleJob) {
    const chain = chainFromJob(job);
    // S4-M16: the breaker is keyed per (account, chain), not per chain alone. With
    // the `'operator'` literal, one user's three consecutive failures tripped
    // `breaker:operator:<chain>` and halted EVERY other user's trades on that chain
    // for CIRCUIT_BREAKER_RESET_MS -- a denial of service one tenant could inflict
    // on all of them, by doing nothing but trading badly.
    //
    // `riskPolicyAccountForUser` rather than a bare userId, so the breaker and the
    // risk policy cannot key differently for one user. It is deliberately NOT
    // `reconciliationAccountForUser`, which must stay `'operator'` (see the note
    // above RISK_POLICY_ACCOUNT and §1 of the checklist).
    const breakerAccount = riskPolicyAccountForUser(resolveExecutionPrincipal((job.data ?? {})).kind === 'user'
        ? job.data.userId
        : null);
    const state = await readCircuitBreakerState(breakerAccount, chain);
    if (state.trippedAt !== null) {
        const probeClaimed = await claimCircuitBreakerProbe(breakerAccount, chain, CIRCUIT_BREAKER_RESET_MS);
        if (!probeClaimed) {
            const current = await readCircuitBreakerState(breakerAccount, chain);
            if (current.trippedAt !== null) {
                console.log(`[trade-executor] circuit breaker active for ${chain}; delaying job`);
                return delayForCircuitBreaker(job, chain, current.trippedAt);
            }
        }
        else {
            console.log(`[trade-executor] circuit breaker half-open probe claimed for ${chain}`);
        }
    }
    try {
        const result = await execute(job);
        if (successfulBreakerOutcomes.has(result.status)) {
            await recordCircuitBreakerSuccess(breakerAccount, chain);
        }
        else if (failedBreakerOutcomes.has(result.status)) {
            const failed = await recordCircuitBreakerFailure(breakerAccount, chain, DEFAULT_RISK_CONFIG.maxConsecutiveFailures);
            if (failed.trippedAt !== null) {
                console.error(`[trade-executor] circuit breaker tripped for ${chain} after ${failed.consecutiveFailures} consecutive failures`);
            }
        }
        return result;
    }
    catch (error) {
        if (error instanceof UnrecoverableError || error instanceof DelayedError)
            throw error;
        // Nonce contention is not a venue failure (S4-M12). Another process holds the
        // account's nonce lock, so this job simply has not run yet — counting it
        // would let three unlucky collisions trip the breaker and halt every trade on
        // the chain for CIRCUIT_BREAKER_RESET_MS, turning a retryable millisecond
        // overlap into a five-minute outage. BullMQ retries the job with backoff, by
        // which time the holder has submitted and the pending nonce has advanced.
        if (error instanceof NonceContentionError) {
            console.warn(`[trade-executor] ${error.message}`);
            throw error;
        }
        const failed = await recordCircuitBreakerFailure(breakerAccount, chain, DEFAULT_RISK_CONFIG.maxConsecutiveFailures);
        if (failed.trippedAt !== null) {
            console.error(`[trade-executor] circuit breaker tripped for ${chain} after ${failed.consecutiveFailures} consecutive failures`);
        }
        throw error;
    }
}
const SOURCE_COPY_POSITION_EVIDENCE_MAX_AGE_MS = parsePositiveNumber(process.env.SOURCE_COPY_POSITION_EVIDENCE_MAX_AGE_MS, 10 * 60_000, 'SOURCE_COPY_POSITION_EVIDENCE_MAX_AGE_MS');
const COPY_ELIGIBILITY_THRESHOLDS = {
    // Matches the signal-engine's own emit-time window, so a signal is not
    // considered fresh enough to create and then stale enough to refuse.
    maxEventAgeMs: parsePositiveNumber(process.env.SOURCE_COPY_MAX_EVENT_AGE_MS, 10 * 60_000, 'SOURCE_COPY_MAX_EVENT_AGE_MS'),
    maxClockSkewMs: parseNonNegativeNumber(process.env.COPY_MAX_CLOCK_SKEW_MS, 30_000, 'COPY_MAX_CLOCK_SKEW_MS'),
    // Defaults to 0 so the USD floor is opt-in: the notional a wallet trades is
    // strategy-dependent, and a surprise floor would silently drop live signals.
    minimumSourceActivityUsd: parseNonNegativeNumber(process.env.COPY_MIN_SOURCE_ACTIVITY_USD, 0, 'COPY_MIN_SOURCE_ACTIVITY_USD'),
    // A wallet with fewer than three recorded trades has no track record to copy;
    // whatever score it carries is an artifact of a tiny sample.
    minimumSourceTradeCount: parseNonNegativeNumber(process.env.COPY_MIN_SOURCE_TRADES, 3, 'COPY_MIN_SOURCE_TRADES'),
    activityLookbackMs: parsePositiveNumber(process.env.COPY_ACTIVITY_LOOKBACK_MS, 30 * 24 * 60 * 60_000, 'COPY_ACTIVITY_LOOKBACK_MS')
};
// ─── Execution authority (S4-P7) ───────────────────────────────────────────────
/**
 * Which principal a job executes for.
 *
 * Read from the payload rather than hard-coded, so that the first job carrying a
 * `userId` is routed to a per-user adapter and **denied with a named code**
 * instead of silently executing with the operator's keys. Nothing enqueues a
 * `userId` today — fan-out is `S4-7` — so every job in this tree resolves to
 * `{ kind: 'operator' }` and behaviour is unchanged. The value is in what
 * happens the first time one does.
 *
 * Deliberately a separate read from `RISK_POLICY_ACCOUNT`, which becomes the user
 * id under fan-out for *sizing*. Sizing a trade wrongly is a bad trade;
 * authorizing one wrongly spends someone else's money, so the two must not share
 * a single fallback.
 */
function resolveExecutionPrincipal(payload) {
    const userId = typeof payload.userId === 'string' ? payload.userId.trim() : '';
    return userId ? { kind: 'user', userId } : { kind: 'operator' };
}
/**
 * Binds the six authority adapters to this process's configuration.
 *
 * Every accessor reads at authorize time, never at construction: `evmAccount`
 * and `polymarketSigner` are module-level in their own files, and
 * `getJupiterJitoSigner()` is only populated part-way through `main()`, so a
 * snapshot taken here would permanently report "nothing configured".
 *
 * This function is the only place in the executor that names a chain-specific
 * authority type. That is the point of it: `handleJob` names none.
 */
export function createExecutorJobPorts() {
    return {
        authorize: createExecutionAuthorityRegistry(createExecutionAuthorityAdapters({
            solana: {
                trojanWalletAddress: () => TROJAN_WALLET_ADDRESS ?? null,
                signer: () => getJupiterJitoSigner()
            },
            robinhoodChain: {
                accountAddress: () => evmAccount?.address ?? null,
                typedDataSigner: () => {
                    const account = evmAccount;
                    if (!account || typeof account.signTypedData !== 'function')
                        return null;
                    // Permit2 (`S4-M13`) is the first caller. The cast sits at the edge on
                    // purpose: `Eip712TypedData` is declared without viem's generics so a
                    // Solana adapter can satisfy the same port without importing viem.
                    return (typedData) => account.signTypedData(typedData);
                }
            },
            polygon: {
                identity: () => polymarketSigner
                    ? resolvePolymarketIdentity(polymarketSigner.address)
                    : null,
                typedDataSigner: () => {
                    const signer = polymarketSigner;
                    if (!signer || typeof signer._signTypedData !== 'function')
                        return null;
                    // ethers v5 takes the domain, the types without their EIP712Domain
                    // entry, and the message as three arguments.
                    return (typedData) => signer._signTypedData(typedData.domain, typedData.types, typedData.message);
                }
            }
        }))
    };
}
let defaultJobPorts = null;
/**
 * The default `handleJob` uses when no ports are passed.
 *
 * `main()` constructs its own set explicitly and threads it in, so production
 * does not reach for this. It exists for the direct callers — the test suites and
 * the acceptance scripts — that invoke `handleJob(job)` with one argument.
 */
function getDefaultJobPorts() {
    if (!defaultJobPorts)
        defaultJobPorts = createExecutorJobPorts();
    return defaultJobPorts;
}
async function prepareCanonicalExecutions(input) {
    const executions = {};
    let shadowReason;
    for (const executionMode of executionModesForChainMode(input.mode)) {
        const targetAccount = executionMode === 'live'
            ? input.liveTargetAccount
            : resolvePaperCopyTargetAccount(input.chain);
        if (!targetAccount) {
            throw new UnrecoverableError(`Canonical ${executionMode} execution has no target account on ${input.chain}`);
        }
        let result;
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
        }
        catch (error) {
            if (executionMode !== 'shadow')
                throw error;
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
        if (result.execution.sourceTradeId !== input.sourceTradeId
            || result.execution.direction !== input.direction
            || result.execution.chain !== input.chain) {
            throw new UnrecoverableError('Canonical execution identity does not match the queued source event');
        }
        executions[executionMode] = result.execution;
    }
    return { executions, shadowReason };
}
function canonicalExecutionIsPending(execution) {
    return execution.state === 'submitted'
        || execution.state === 'partially_filled'
        || execution.state === 'reconciliation_required';
}
function canonicalExecutionIsTerminal(execution) {
    return execution.state === 'confirmed'
        || execution.state === 'failed'
        || execution.state === 'cancelled';
}
async function persistCanonicalSubmission(input) {
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
async function persistCanonicalFill(input) {
    const result = await recordCopyExecutionEvidence({
        executionId: input.execution.id,
        evidenceType: input.evidenceType,
        evidenceId: input.evidenceId,
        baseQuantity: input.baseQuantity,
        quoteLeg: input.quoteLeg,
        priceUsd: input.priceUsd,
        confirmationState: 'confirmed',
        completesExecution: input.completesExecution ?? true,
        occurredAt: input.occurredAt ?? new Date()
    });
    // S4-M6: the priced numerator.
    //
    // The fan-out site writes this cohort's ledger row at ENQUEUE time as
    // `unpriced`, because what it holds there is a projection and none of 053's
    // priced bases describes a projection. This is where the real figure arrives.
    //
    // Here rather than at submission, deliberately: `persistCanonicalSubmission` is
    // the submission site, and an order that never fills consumed no depth. All four
    // fill paths funnel through this function with `confirmationState: 'confirmed'`,
    // which is what makes one call cover every chain.
    //
    // The before/after pair is what makes a retry safe. `recordCopyExecutionEvidence`
    // inserts evidence `ON CONFLICT DO NOTHING`, so a replayed job leaves the
    // cumulative total unmoved, the delta is zero and no statement is issued. A
    // genuine partial-then-remainder moves the total and only the increment accrues.
    if (input.execution.sourceTradeId) {
        const accrual = await accrueMasterCapacityFillNotional({
            sourceTradeId: input.execution.sourceTradeId,
            executionMode: input.execution.executionMode,
            quoteCurrency: result.fillValuation.currency,
            confirmedQuoteUsdBefore: input.execution.confirmedQuoteQuantity,
            confirmedQuoteUsdAfter: result.execution.confirmedQuoteQuantity
        }).catch((error) => ({
            applied: false,
            code: 'accrual-failed',
            reason: error instanceof Error ? error.message : String(error)
        }));
        if (!accrual.applied) {
            // Never thrown: this runs AFTER a confirmed fill, and throwing here would make
            // the executor treat a filled order as failed. Both `ledger-row-missing` and
            // `accrual-failed` UNDER-count, which fails open on the cap -- so these deserve
            // an alert rather than a log line once alerting exists (S4-M6's follow-up).
            console.warn(`[trade-executor] capacity numerator not accrued (${accrual.code}): ${accrual.reason}`);
        }
    }
}
async function terminateCanonicalExecution(execution, reason, state = 'failed') {
    if (!execution || canonicalExecutionIsTerminal(execution))
        return;
    await transitionCopyExecution({
        executionId: execution.id,
        nextState: state,
        reason
    });
}
export async function runTrojanReconciliation(runtime) {
    const outcomes = await runtime.reconcile();
    for (const outcome of outcomes) {
        if (outcome.status === 'filled') {
            await transitionPendingTrade({
                executor: 'trojan',
                signature: outcome.transactionIdentity,
                status: 'filled',
                confirmedAt: outcome.confirmedAt
            });
        }
        else if (outcome.status === 'failed' || outcome.status === 'inconsistent') {
            await transitionPendingTrade({
                executor: 'trojan',
                signature: outcome.transactionIdentity,
                status: 'failed',
                errorMessage: outcome.status === 'inconsistent' ? outcome.reason : 'transaction failed on-chain'
            });
        }
        else if (outcome.status === 'ambiguous') {
            await transitionPendingTrade({
                executor: 'trojan',
                signalId: outcome.clientOrderId,
                status: 'failed',
                errorMessage: outcome.reason
            });
        }
        else if (outcome.status === 'submission_unknown') {
            await query(`UPDATE trades SET venue_status = 'submission_unknown'
          WHERE executor = 'trojan'
            AND signal_id = $1
            AND status = 'pending_confirmation'`, [outcome.clientOrderId]);
        }
        else if (outcome.status === 'pending_confirmation'
            || outcome.status === 'pending_reconciliation') {
            await query(`UPDATE trades SET venue_status = $2
          WHERE executor = 'trojan'
            AND signature = $1
            AND status = 'pending_confirmation'`, [outcome.transactionIdentity, outcome.status]);
        }
    }
    return outcomes;
}
// ─── Worker Job Handler ────────────────────────────────────────────────────────
export async function handleJob(job, ports = getDefaultJobPorts()) {
    const payload = job.data;
    if (!payload.signalId || typeof payload.signalId !== 'string') {
        throw new UnrecoverableError('Trade job is missing a signalId');
    }
    if (!payload.tokenMint || typeof payload.tokenMint !== 'string') {
        throw new UnrecoverableError(`Trade job ${payload.signalId} has no token mint`);
    }
    let score;
    try {
        score = parseScore(payload.score, `Trade job ${payload.signalId} score`);
    }
    catch (error) {
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
    const startupResolution = clampExecutionModeForStartup(chain, modeResolution.effectiveMode, modeResolution.reason);
    const execMode = startupResolution.effectiveMode;
    const clampReason = startupResolution.reason;
    if (execMode === 'off') {
        console.log(`[trade-executor] SKIPPED: Execution is OFF for ${chain}`);
        return { status: 'skipped', reason: 'Execution disabled (off)' };
    }
    if (clampReason) {
        console.warn(`[trade-executor] WARNING: ${clampReason} | requested: ${chain} live`);
    }
    // Auto-execute gate. A stop-loss or close-all is exempt: it only ever reduces an existing
    // position/lot, and gating it behind the entry switch would leave every position
    // opened while AUTO_EXECUTE was off permanently unprotected. The chain's
    // execution mode (including the 'off' kill switch) still applies above.
    if (!payload.manual && !payload.stopLoss && !payload.closeAll && (!AUTO_EXECUTE || score < AUTO_EXECUTE_MIN_SCORE)) {
        console.log(`[trade-executor] SKIPPED: auto-execute=${AUTO_EXECUTE}, score=${score}, threshold=${AUTO_EXECUTE_MIN_SCORE} | token: ${payload.tokenMint}`);
        return {
            status: 'skipped',
            reason: `Auto-execute disabled or score ${score} < threshold ${AUTO_EXECUTE_MIN_SCORE}`
        };
    }
    const direction = payload.direction ?? 'buy';
    // Whose money this job spends. Resolved ONCE here, above every consumer, rather
    // than re-derived per call site: the function is pure over the payload so two
    // calls could not disagree, but a single declaration is what makes it obvious to
    // a reader that sizing, the exposure cap and the breaker all key on the same
    // tenant. They previously did not -- each read the `'operator'` literal.
    const exposureAccount = resolveExecutionPrincipal(payload);
    const jobUserId = exposureAccount.kind === 'user' ? exposureAccount.userId : null;
    // A stop-loss or close-all closes the position/lot, so the quantity is dictated by the
    // ledger rather than by balance-aware sizing.
    let stopLossSellQuantity = null;
    if (payload.stopLoss || payload.closeAll) {
        if (direction !== 'sell') {
            throw new UnrecoverableError(`${payload.closeAll ? 'Close-all' : 'Stop-loss'} job ${payload.signalId} must be a sell`);
        }
        const quantity = Number(payload.sellTokenAmount);
        if (!Number.isFinite(quantity) || quantity <= 0) {
            throw new UnrecoverableError(`${payload.closeAll ? 'Close-all' : 'Stop-loss'} job ${payload.signalId} needs a positive sellTokenAmount`);
        }
        stopLossSellQuantity = quantity;
    }
    const sizingMode = execMode === 'paper' ? 'paper' : 'live';
    const liveTokenSell = direction === 'sell' && chain !== 'polygon' && sizingMode === 'live';
    const size = liveTokenSell || stopLossSellQuantity !== null
        ? 0
        : await getBalanceAwarePositionSize(score, chain, payload.clusterTier ?? 'promising', sizingMode, direction, cleanMint, 
        // S4-15: size against THIS user's agreed risk percentage. Before this the
        // call resolved the operator's policy for every job, so a fan-out sized
        // fifty users off one account's settings -- the opposite of "exposure
        // proportional to what they deposited and agreed to".
        jobUserId);
    if (!Number.isFinite(size) || (size <= 0 && !liveTokenSell && stopLossSellQuantity === null)) {
        console.log(`[trade-executor] SKIPPED: position size = 0 | token: ${payload.tokenMint}`);
        return { status: 'skipped', reason: 'Position size calculated to 0' };
    }
    // Enforce the 24-hour exposure cap per (account, chain), not per chain alone
    // (S4-M47). Before the account argument existed this summed EVERY trade on the
    // chain, so under fan-out one user's spending charged every other user's
    // allowance and the first user to trade hard silently capped the cohort.
    //
    // Resolved inline rather than hoisting `principal` from line ~1441:
    // `resolveExecutionPrincipal` is pure over the payload, so calling it twice
    // cannot disagree with itself, whereas moving a declaration across 50 lines of
    // branching could change what the later reader sees.
    const dailyExposureUsd = direction === 'buy'
        ? await getRollingExposureUsd(jobUserId, chain)
        : 0;
    const dailyCapUsd = parseFloat(process.env.DAILY_EXPOSURE_CAP_USD ?? '50000');
    let thisTradeUsd = size;
    if (chain === 'solana') {
        const solPrice = await fetchTokenPriceUsd(SOL_MINT) ?? 150;
        thisTradeUsd = size * solPrice;
    }
    else if (chain === 'robinhood-chain') {
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
    if (direction === 'buy' &&
        REBUY_COOLDOWN_MINUTES > 0 &&
        await hasRecentBuy(payload.tokenMint, REBUY_COOLDOWN_MINUTES)) {
        console.log(`[trade-executor] SKIPPED: re-buy cooldown (${REBUY_COOLDOWN_MINUTES}min) active | token: ${payload.tokenMint}`);
        return { status: 'skipped', reason: `Re-buy cooldown active for ${payload.tokenMint}` };
    }
    // Execution authority (`S4-P7`). One port, six adapters behind it; the operator
    // is one of them and not a branch. Resolved here, above the claim, because the
    // granted settlement address *is* the claim's `target_account` — and only for a
    // mode that will actually move funds, since paper has nothing to authorize.
    //
    // A denial returns a skip carrying the adapter's stable code and never falls
    // through to another adapter. That is the whole point: a per-user request
    // satisfied by the operator's grant would fill a real trade with the operator's
    // key and be indistinguishable from success.
    const principal = resolveExecutionPrincipal(payload);
    let liveAuthority = null;
    if (execMode === 'live' || execMode === 'live+shadow') {
        const verdict = await ports.authorize({
            chain,
            principal,
            action: 'venue-trade',
            direction,
            instrument: cleanMint
        });
        if (verdict.kind === 'denied') {
            const reason = `Execution authority denied [${verdict.code}]: ${verdict.reason}`;
            console.error(`[trade-executor] SKIPPED: ${reason} | signalId: ${payload.signalId}`);
            return { status: 'skipped', reason };
        }
        liveAuthority = verdict.authority;
    }
    // Claim the signal atomically
    let canonicalExecutions = {};
    let canonicalLiveAlreadyConfirmed = false;
    let canonicalLiveTradeId = null;
    let canonicalShadowReason;
    if (payload.sourceTradeId) {
        // Copy eligibility is the last gate before the one-shot canonical claim.
        // Stop-loss jobs never reach it — they carry no sourceTradeId — which is
        // the behaviour we want: an exit must stay possible after its source
        // wallet has been dropped, or every position opened before a wallet was
        // paused would be stranded.
        const eligibility = await enforceCopyEligibility({
            account: COPY_ELIGIBILITY_ACCOUNT,
            signalId: payload.signalId,
            chain
        }, {
            loadFacts: (facts) => loadCopyEligibilityFacts(facts),
            recordRejection: (rejection) => recordCopyEligibilityRejection(rejection),
            thresholds: COPY_ELIGIBILITY_THRESHOLDS
        });
        if (!eligibility.allowed) {
            const reason = `Copy policy rejected the source: ${eligibility.reasons.join(', ')}`;
            console.log(`[trade-executor] SKIPPED: ${reason} | signalId: ${payload.signalId}`);
            return { status: 'skipped', reason };
        }
        const prepared = await prepareCanonicalExecutions({
            sourceTradeId: payload.sourceTradeId,
            signalId: payload.signalId,
            chain,
            direction,
            mode: execMode,
            buyQuoteQuantity: size,
            liveTargetAccount: liveAuthority?.settlementAddress ?? null
        });
        canonicalExecutions = prepared.executions;
        canonicalShadowReason = prepared.shadowReason;
        if (prepared.reason) {
            return { status: 'skipped', reason: prepared.reason };
        }
        const primary = execMode === 'paper' ? canonicalExecutions.paper : canonicalExecutions.live;
        if (!primary)
            throw new UnrecoverableError('Canonical primary execution was not created');
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
            const linkedTrade = await query(`SELECT id FROM trades WHERE copy_execution_id = $1 LIMIT 1`, [primary.id]);
            canonicalLiveTradeId = linkedTrade[0]?.id ?? null;
        }
    }
    else if (!payload.stopLoss) {
        const claimed = await claimSignalForExecution(payload.signalId);
        if (!claimed) {
            console.log(`[trade-executor] SKIPPED: signal is not pending | signalId: ${payload.signalId}`);
            return { status: 'skipped', reason: 'Signal is not pending' };
        }
    }
    // A stop-loss signal is already 'executed' — its entry filled — so it cannot
    // pass the pending claim. Its exactly-once guard is the (account, signal) row
    // in signal_stop_losses, claimed by the scorer before this job was queued.
    // Slippage tolerance for every venue call below (`S4-P4`). Resolved once per
    // job rather than repeated as a literal at each call site, where it appeared as
    // 1500 on Solana and 300 on Robinhood in fourteen places.
    // User-configured slippage tolerance (S4-P4).
    // `null` or undefined resolves to the chain default (e.g. 1500 for Solana, 300 for EVM).
    // A tighter user preference (e.g. 50 bps) is preserved and never widened to the chain default.
    const slippageBps = resolveSlippageBps(chain, payload.maxSlippageBps ?? null);
    try {
        let paperResult = null;
        let liveResult = canonicalLiveAlreadyConfirmed
            ? { status: 'live-executed', signalId: payload.signalId }
            : null;
        let liveTradeId = canonicalLiveTradeId;
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
                    // A live submit path: an unknown balance must not be capped against, and
                    // must not be treated as zero either. Throwing here is deliberate --
                    // UnrecoverableError does not retry, so this refuses the trade rather
                    // than resubmitting against a balance we still cannot read.
                    if (currentSpendableBalance === null) {
                        throw new UnrecoverableError('Solana spendable balance is unassessable, so the submission cannot be '
                            + 'capped against it; refusing rather than sizing on an unknown');
                    }
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
                let sellProportionBps;
                let maximumTokenAmountBaseUnits;
                if (canonicalExecution?.direction === 'sell') {
                    if (!canonicalExecution.sourceSellFraction || !canonicalExecution.requestedBaseQuantity) {
                        throw new UnrecoverableError('Canonical Solana SELL is missing proportional position evidence');
                    }
                    const decimals = await getTokenDecimals(payload.tokenMint, 'solana');
                    if (decimals === null) {
                        await terminateCanonicalExecution(canonicalExecution, 'Token decimals are unavailable for an exact proportional Solana SELL');
                        throw new UnrecoverableError('Token decimals are required for a canonical Solana SELL');
                    }
                    sellProportionBps = sourceSellFractionToBps(canonicalExecution.sourceSellFraction);
                    maximumTokenAmountBaseUnits = decimalQuantityToBaseUnits(canonicalExecution.requestedBaseQuantity, decimals).toString();
                }
                const submittedAt = new Date();
                // S3-7 cutover seam. Jupiter+Jito is built and unit-tested but NOT
                // certified — `S3-9` requires a capped live canary — so it carries a
                // trade only when the operator has explicitly opted in AND a signer and
                // block engine are actually configured. Neither control implies the
                // other. Default remains Trojan, the incumbent certified path.
                const jitoRuntime = getConfiguredJupiterJitoRuntime();
                // The signing identity comes from the granted authority, not from the
                // signer module: `handleJob` must not name a chain-specific authority
                // type (`S4-P7`). `null` means this authority submits through a
                // venue-managed route — the Trojan webhook — which is the certified
                // default and the branch below.
                const signingAddress = liveAuthority?.signingAddress ?? null;
                const useJupiterJito = shouldUseJupiterJito({
                    chain,
                    configured: resolveSolanaExecutor(),
                    jitoReady: Boolean(jitoRuntime && signingAddress)
                });
                if (useJupiterJito && jitoRuntime && signingAddress) {
                    const outcome = await dispatchSolanaTrade({
                        clientOrderId: canonicalExecution?.clientOrderId ?? payload.signalId,
                        tokenMint: cleanMint,
                        direction,
                        amountSol: submissionSize,
                        sellBaseUnits: maximumTokenAmountBaseUnits,
                        slippageBps
                    }, {
                        runtime: jitoRuntime,
                        signerPublicKey: signingAddress,
                        jupiterApiKey: process.env.JUPITER_API_KEY
                    });
                    if (outcome.kind === 'submitted' || outcome.kind === 'ambiguous') {
                        // A bundle id is not a transaction signature — the signature only
                        // exists once the bundle lands, and the reconciliation sweep fills
                        // it in. Persisting the bundle id here would put a value in
                        // `trades.signature` that no explorer can resolve.
                        if (canonicalExecution) {
                            await transitionCopyExecution({
                                executionId: canonicalExecution.id,
                                nextState: 'reconciliation_required',
                                reason: outcome.kind === 'ambiguous'
                                    ? outcome.reason
                                    : `jito bundle ${outcome.bundleId} awaiting confirmation`,
                                nextReconciliationAt: new Date(Date.now() + 30_000)
                            });
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
                            executor: 'jupiter-jito',
                            signature: null,
                            venueStatus: outcome.kind === 'submitted' ? outcome.venueStatus : 'submission_unknown',
                            status: 'pending_confirmation',
                            errorMessage: outcome.kind === 'ambiguous' ? outcome.reason : null,
                            slippageBps,
                            submittedAt
                        });
                        liveResult = {
                            status: 'submitted',
                            state: 'pending_confirmation',
                            signalId: payload.signalId,
                            tokenMint: payload.tokenMint,
                            size: submissionSize,
                            signature: null
                        };
                    }
                    else if (outcome.kind === 'filled') {
                        // Only reachable on a redelivered job whose bundle already landed.
                        if (canonicalExecution) {
                            await persistCanonicalSubmission({
                                execution: canonicalExecution,
                                executor: 'jupiter-jito',
                                submissionType: 'transaction',
                                submissionId: outcome.signature
                            });
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
                            executor: 'jupiter-jito',
                            signature: outcome.signature,
                            venueStatus: 'filled',
                            status: 'pending_confirmation',
                            slippageBps,
                            submittedAt
                        });
                        liveResult = {
                            status: 'submitted',
                            state: 'pending_confirmation',
                            signalId: payload.signalId,
                            tokenMint: payload.tokenMint,
                            size: submissionSize,
                            signature: outcome.signature
                        };
                    }
                    else {
                        await terminateCanonicalExecution(canonicalExecution, `Jupiter+Jito rejected the request: ${outcome.reason}`, 'cancelled');
                        liveTradeId = await persistTrade({
                            signalId: payload.signalId,
                            sourceTradeId: payload.sourceTradeId,
                            copyExecutionId: canonicalExecution?.id,
                            tokenMint: payload.tokenMint,
                            size: submissionSize,
                            chain,
                            executionMode: 'live',
                            direction,
                            executor: 'jupiter-jito',
                            status: 'rejected',
                            errorMessage: outcome.reason,
                            slippageBps,
                            submittedAt
                        });
                        liveResult = { status: 'rejected', reason: outcome.reason };
                    }
                }
                else {
                    if (principal.kind !== 'operator') {
                        return {
                            status: 'rejected',
                            reason: `Venue-managed Trojan submission is only available for operator execution; user ${principal.userId} requires a delegated transaction signer`
                        };
                    }
                    const result = await triggerTrojan({
                        signalId: canonicalExecution?.clientOrderId ?? payload.signalId,
                        tokenMint: cleanMint,
                        amountSol: submissionSize,
                        direction,
                        sellProportionBps: direction === 'sell' ? sellProportionBps ?? 10_000 : undefined,
                        maximumTokenAmountBaseUnits,
                        slippageBps
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
                            }
                            else {
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
                            slippageBps,
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
                    }
                    else if (result.status === 'rejected') {
                        await terminateCanonicalExecution(canonicalExecution, `Trojan rejected the request with HTTP ${result.httpStatus}`, 'cancelled');
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
                            slippageBps,
                            submittedAt
                        });
                        liveResult = { status: 'rejected', reason: `Trojan HTTP ${result.httpStatus}` };
                    }
                    else {
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
                                }
                                else {
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
                                        quoteLeg: { amount: executedSize.toString(), currency: 'SOL' },
                                        // `price_usd` used to be left NULL on this path, which is why
                                        // S4-M23's tracking difference could not be computed for Solana.
                                        // Both numbers are already in hand, so the realised fill price is
                                        // derived rather than re-fetched as a spot quote (S4-M35).
                                        priceUsd: deriveFillPriceUsd(valuateChainNativeQuoteLeg({
                                            chain: 'solana',
                                            amount: executedSize,
                                            nativeUsdPrice: await getCachedSolPrice()
                                        }).usdAmount, tokenQuantity),
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
                                slippageBps,
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
                        }
                        else {
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
                                slippageBps,
                                submittedAt
                            });
                            liveResult = { status: 'failed', reason: errorMessage };
                        }
                    }
                }
            }
            else if (chain === 'robinhood-chain') {
                const canonicalExecution = canonicalExecutions.live;
                let canonicalSellBaseUnits;
                let canonicalSellBps;
                if (canonicalExecution?.direction === 'sell') {
                    if (!canonicalExecution.requestedBaseQuantity || !canonicalExecution.sourceSellFraction) {
                        throw new UnrecoverableError('Canonical Robinhood SELL is missing proportional position evidence');
                    }
                    const decimals = await getTokenDecimals(payload.tokenMint, 'robinhood-chain');
                    if (decimals === null) {
                        await terminateCanonicalExecution(canonicalExecution, 'Token decimals are unavailable for an exact proportional Robinhood SELL');
                        throw new UnrecoverableError('Token decimals are required for a canonical Robinhood SELL');
                    }
                    canonicalSellBaseUnits = decimalQuantityToBaseUnits(canonicalExecution.requestedBaseQuantity, decimals);
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
                    slippageBps
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
                        }
                        else {
                            await persistCanonicalSubmission({
                                execution: canonicalExecution,
                                executor: 'robinhood-univ3',
                                submissionType: 'transaction',
                                submissionId: result.transactionHash
                            });
                            // S4-M41: read `baseSpend`, never `amountEth`. In `erc20` mode
                            // `amountEth` is `0`, and writing that as an ETH cost recorded a
                            // fabricated zero on a trade that spent a stablecoin -- which makes
                            // the position look like an infinite-return winner that can never
                            // trip a stop-loss. `null` is the honest record for a spend the
                            // ledger cannot yet denominate; `054` gives us `quote_currency` and
                            // an unassessed count precisely so unknown is representable.
                            const robinhoodQuoteLeg = result.baseSpend.kind === 'native'
                                ? { amount: result.baseSpend.amount.toString(), currency: 'ETH' }
                                : null;
                            if (!robinhoodQuoteLeg) {
                                console.warn('[trade-executor] robinhood fill recorded without a quote leg: '
                                    + `base asset spend is ${result.baseSpend.kind}, which the ledger cannot `
                                    + 'denominate yet (S4-M41). Cost basis for this fill is unassessed, not zero.');
                            }
                            await persistCanonicalFill({
                                execution: canonicalExecution,
                                evidenceType: 'chain_receipt',
                                evidenceId: result.transactionHash,
                                baseQuantity: tokenQuantity,
                                quoteLeg: robinhoodQuoteLeg,
                                // Same gap as the Solana path: no priceUsd was passed, so
                                // copy_execution_evidence.price_usd was NULL on every robinhood
                                // live fill. Derived from the USD value and the units received --
                                // and left null when the spend is unassessed, because a price
                                // derived from a fabricated zero is itself fabricated.
                                priceUsd: robinhoodQuoteLeg
                                    ? deriveFillPriceUsd(valuateChainNativeQuoteLeg({
                                        chain: 'robinhood-chain',
                                        amount: Number(robinhoodQuoteLeg.amount),
                                        nativeUsdPrice: await getCachedEthPrice()
                                    }).usdAmount, tokenQuantity)
                                    : null
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
                        slippageBps,
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
                }
                else if (result.status === 'pending_confirmation') {
                    if (canonicalExecution) {
                        if (result.transactionHash) {
                            await persistCanonicalSubmission({
                                execution: canonicalExecution,
                                executor: 'robinhood-univ3',
                                submissionType: 'transaction',
                                submissionId: result.transactionHash
                            });
                        }
                        else {
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
                        slippageBps,
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
                }
                else {
                    if (canonicalExecution && 'transactionHash' in result && result.transactionHash) {
                        await persistCanonicalSubmission({
                            execution: canonicalExecution,
                            executor: 'robinhood-univ3',
                            submissionType: 'transaction',
                            submissionId: result.transactionHash
                        });
                    }
                    await terminateCanonicalExecution(canonicalExecution, result.reason, result.status === 'skipped' ? 'cancelled' : 'failed');
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
                        slippageBps,
                        submittedAt
                    });
                    liveResult = { status: result.status, reason: result.reason };
                }
            }
            else if (chain === 'polygon') {
                const canonicalExecution = canonicalExecutions.live;
                try {
                    if (canonicalExecution?.direction === 'sell' && !canonicalExecution.requestedBaseQuantity) {
                        throw new UnrecoverableError('Canonical Polymarket SELL is missing proportional position evidence');
                    }
                    const submittedAt = new Date();
                    // The master-fill reference for the mirror price bound (S4-M16). Only a
                    // copy has a master: a manual execute or a stop-loss exit carries no
                    // `sourceTradeId` and legitimately gets no mirror, keeping the
                    // book-derived bound. Fetched here rather than threaded through the
                    // claim because `COPY_EXECUTION_COLUMNS` feeds several money-path
                    // queries, and widening all of them to carry one price is a larger
                    // change than one read.
                    let mirror;
                    // S4-M18 needs the same row: the staleness budget is measured from when
                    // the master's event actually happened, against the market's remaining
                    // time to resolution. Read once and used for both, rather than a second
                    // query for a second field of the same row.
                    let sourceEventAt;
                    if (payload.sourceTradeId) {
                        const sourceTrade = await getCanonicalSourceTradeById(payload.sourceTradeId);
                        sourceEventAt = sourceTrade?.eventAt;
                        // A null price is passed through as null, not omitted: the planner
                        // fails closed on an absent master price, and dropping `mirror`
                        // entirely would silently downgrade a copy to the book bound.
                        mirror = {
                            sourceTradeId: payload.sourceTradeId,
                            masterFillPriceUsd: sourceTrade?.priceUsd == null
                                ? null
                                : Number(sourceTrade.priceUsd)
                        };
                    }
                    const result = await triggerPolymarket({
                        signalId: canonicalExecution?.clientOrderId ?? payload.signalId,
                        tokenID: cleanMint,
                        spendAmountUsd: size, // Polymarket size logic assumes USDC/USD sizing
                        direction,
                        sellShares: canonicalExecution?.direction === 'sell'
                            ? Number(canonicalExecution.requestedBaseQuantity)
                            : undefined,
                        mirror,
                        sourceEventAt
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
                                quoteLeg: { amount: result.spendAmountUsd.toString(), currency: 'USD' },
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
                        signalId: payload.signalId,
                        tokenMint: payload.tokenMint,
                        size: executedSize,
                        signature: orderId
                    };
                }
                catch (error) {
                    if (error instanceof UnrecoverableError &&
                        (error.message.includes('Polymarket Protection') || error.message.includes('No asks'))) {
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
                    }
                    else {
                        throw error;
                    }
                }
            }
            else {
                throw new UnrecoverableError(`Live execution for ${chain} is missing certified implementation`);
            }
        }
        // 2. PAPER / SHADOW EXECUTION PATH
        const liveWasConfirmed = liveResult?.status === 'live-executed';
        if (execMode === 'live+shadow'
            && payload.sourceTradeId
            && !canonicalExecutions.shadow
            && liveWasConfirmed) {
            console.error(`[trade-executor] Shadow preparation skipped for source ${payload.sourceTradeId}: ` +
                `${canonicalShadowReason ?? 'canonical shadow execution is unavailable'}`);
            return liveResult ?? { status: 'live-executed', signalId: payload.signalId };
        }
        if (execMode === 'paper' || (execMode === 'live+shadow' && liveTradeId && liveWasConfirmed)) {
            const submittedAt = new Date();
            let paperExecution = execMode === 'live+shadow'
                ? canonicalExecutions.shadow
                : canonicalExecutions.paper;
            if (!paperExecution && payload.copyExecutionId) {
                paperExecution = (await getCopyExecutionById(payload.copyExecutionId)) ?? undefined;
            }
            try {
                if (paperExecution?.state === 'confirmed') {
                    paperResult = { status: 'already-executed', signalId: payload.signalId };
                    return liveResult || paperResult || { status: 'already-executed' };
                }
                if (paperExecution && canonicalExecutionIsPending(paperExecution)) {
                    return liveResult || { status: 'submitted', state: paperExecution.state };
                }
                let jupiterFill = null;
                let simulatedVia = 'spot-price';
                let simTokenAmount = null;
                // A stop-loss job carries the exact ledger quantity to unwind. It has no
                // sourceTradeId, so there is no canonical execution to read the quantity
                // from — the payload is the only authority, and using bankroll-derived
                // sizing instead would record a wrong-quantity sell and corrupt the
                // position ledger permanently.
                let simBaseQuantity = stopLossSellQuantity !== null
                    ? stopLossSellQuantity.toString()
                    : paperExecution?.direction === 'sell'
                        ? paperExecution.requestedBaseQuantity
                        : null;
                let simAmountUsd;
                let simPriceUsd = null;
                let simExecutor = 'paper';
                if (chain === 'solana' && direction === 'buy') {
                    const outputDecimals = await getTokenDecimals(payload.tokenMint, 'solana');
                    if (outputDecimals === null) {
                        console.warn(`[trade-executor] token decimals unavailable; skipping Jupiter quantity simulation for ${payload.tokenMint}`);
                    }
                    else {
                        jupiterFill = await getJupiterSimulatedFill({
                            inputMint: SOL_MINT,
                            outputMint: cleanMint,
                            amountLamports: Math.round(size * 1e9),
                            slippageBps: 150
                        }, outputDecimals, JUPITER_API_KEY);
                        if (jupiterFill) {
                            simulatedVia = 'jupiter';
                            simExecutor = 'jupiter-sim';
                            simTokenAmount = jupiterFill.tokenAmount;
                            simBaseQuantity = jupiterFill.tokenAmount.toString();
                            console.log(`[trade-executor] PAPER (jupiter-sim): ${payload.tokenMint} | ` +
                                `${size} SOL → ${jupiterFill.tokenAmount.toFixed(4)} tokens | ` +
                                `impact: ${jupiterFill.priceImpactPct}%`);
                        }
                    }
                }
                else if (chain === 'polygon') {
                    // A sell knows its share count up front; a buy knows its USD notional.
                    // Either way the book is walked for that exact size, so a paper fill
                    // carries the same average price the live path would have paid.
                    const requestedShares = direction === 'sell'
                        ? stopLossSellQuantity
                            ?? (paperExecution ? Number(paperExecution.requestedBaseQuantity) : null)
                        : null;
                    if (direction === 'sell' && (requestedShares === null || !(requestedShares > 0))) {
                        throw new Error('Paper Simulation aborted: Polymarket sell has no share quantity to price');
                    }
                    const plan = await simulatePolymarketBookFill({
                        tokenID: cleanMint,
                        direction,
                        requestedAmount: direction === 'buy' ? size : requestedShares
                    });
                    // The bound is about refusing near-certain markets, so it reads the best
                    // price, exactly as it did before the depth walk was introduced.
                    if (plan.bestPrice > 0.95 || plan.bestPrice < 0.05) {
                        throw new Error(`Paper Simulation aborted: Price ${plan.bestPrice} outside bounds`);
                    }
                    simulatedVia = 'polymarket-book';
                    simExecutor = 'polymarket-sim';
                    simTokenAmount = direction === 'sell' ? requestedShares : plan.estimatedShares;
                    simBaseQuantity = simTokenAmount.toString();
                    simPriceUsd = plan.averagePrice;
                    simAmountUsd = plan.estimatedNotionalUsd;
                    console.log(`[trade-executor] PAPER (polymarket-sim): ${payload.tokenMint} | Size: $${simAmountUsd} | `
                        + `Avg Price: $${plan.averagePrice} (best $${plan.bestPrice}, ${plan.slippageBps.toFixed(1)} bps)`);
                }
                else if (chain === 'robinhood-chain' && (direction === 'buy' || paperExecution)) {
                    const tokenDecimals = await getTokenDecimals(payload.tokenMint, 'robinhood-chain');
                    if (tokenDecimals === null)
                        throw new Error('Robinhood token decimals are unavailable');
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
                    }
                    else {
                        simBaseQuantity = paperExecution?.requestedBaseQuantity ?? null;
                        simTokenAmount = simBaseQuantity ? Number(simBaseQuantity) : null;
                    }
                    console.log(`[trade-executor] PAPER (robinhood-sim): ${payload.tokenMint} | Size: ${size} ETH -> Out: ${quoteWei} units`);
                }
                if (simulatedVia === 'spot-price') {
                    // Stop-loss sells have no canonical execution but still need a priced,
                    // quantity-accurate fill, so they take this path too.
                    if (paperExecution || stopLossSellQuantity !== null) {
                        simPriceUsd = await fetchTokenPriceUsd(payload.tokenMint);
                        if (!simPriceUsd || simPriceUsd <= 0) {
                            throw new Error('Spot-price simulation lacks a positive token price');
                        }
                        if (direction === 'buy') {
                            if (chain === 'solana') {
                                const nativePrice = await getCachedSolPrice();
                                if (!nativePrice)
                                    throw new Error('Spot-price simulation lacks a SOL price');
                                simAmountUsd = size * nativePrice;
                            }
                            else if (chain === 'robinhood-chain') {
                                const nativePrice = await getCachedEthPrice();
                                if (!nativePrice)
                                    throw new Error('Spot-price simulation lacks an ETH price');
                                simAmountUsd = size * nativePrice;
                            }
                            else {
                                simAmountUsd = size;
                            }
                            simBaseQuantity = (simAmountUsd / simPriceUsd).toString();
                        }
                        else {
                            simBaseQuantity = stopLossSellQuantity !== null
                                ? stopLossSellQuantity.toString()
                                : paperExecution.requestedBaseQuantity;
                            simAmountUsd = Number(simBaseQuantity) * simPriceUsd;
                        }
                        simTokenAmount = Number(simBaseQuantity);
                    }
                    console.log(`[trade-executor] PAPER (spot-price fallback): ${payload.tokenMint} | ` +
                        `${stopLossSellQuantity !== null ? `${stopLossSellQuantity} tokens (stop-loss)` : `${size} base units`} ` +
                        `(score: ${payload.score})`);
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
                        // Paper simulation sizes its quote leg in USD on every chain -- see the
                        // simAmountUsd assignments above, which already multiply a SOL or ETH size
                        // by its native price. So the currency is stated, not inferred from
                        // `chain`, which would mislabel a Solana paper fill as SOL.
                        quoteLeg: simAmountUsd == null
                            ? null
                            : { amount: simAmountUsd.toString(), currency: 'USD' },
                        priceUsd: simPriceUsd?.toString() ?? null,
                        occurredAt: confirmedAt
                    });
                }
                await persistTrade({
                    signalId: payload.signalId,
                    sourceTradeId: payload.sourceTradeId,
                    copyExecutionId: paperExecution?.id ?? payload.copyExecutionId,
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
                    status: 'paper-filled',
                    signalId: payload.signalId,
                    tokenMint: payload.tokenMint,
                    size,
                    mode: 'paper',
                    simulatedVia
                };
            }
            catch (paperError) {
                const message = paperError instanceof Error ? paperError.message : String(paperError);
                console.error(`[trade-executor] Shadow execution failed: ${message}`);
                await terminateCanonicalExecution(paperExecution, message);
                if (execMode === 'paper') {
                    if (!payload.sourceTradeId)
                        await releaseSignalClaim(payload.signalId);
                    paperResult = { status: 'skipped', reason: `Paper simulation failed: ${message}` };
                }
            }
        }
        return liveResult || paperResult || { status: 'skipped', reason: 'Unknown execution mode' };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await Promise.allSettled(Object.values(canonicalExecutions).map((execution) => terminateCanonicalExecution(execution, message)));
        if (!payload.sourceTradeId)
            await releaseSignalClaim(payload.signalId).catch(() => { });
        throw err;
    }
}
export async function main() {
    initLogger('trade-executor');
    console.log('[trade-executor] Starting executor worker...');
    const redisClient = getRedis();
    configureRobinhoodOpsAlerts(redisClient);
    let robinhoodRuntime = null;
    let robinhoodRuntimeError = null;
    try {
        robinhoodRuntime = createRobinhoodRuntime(redisClient);
    }
    catch (error) {
        robinhoodRuntimeError = error instanceof Error ? error : new Error(String(error));
    }
    await verifyRobinhoodEnvironment({
        runtimeCheck: () => {
            if (!robinhoodRuntime) {
                throw robinhoodRuntimeError ?? new Error('Robinhood live runtime is unavailable');
            }
        }
    });
    let trojanRuntime = null;
    try {
        trojanRuntime = createTrojanRuntimeFromEnvironment(redisClient);
        configureTrojanRuntime(trojanRuntime);
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        setTrojanRuntimeUnavailable(reason);
    }
    // Jupiter + Jito (DG-1). Stood up alongside Trojan, not in place of it: the
    // legacy path retires only once this one is certified (S3-6), and until then
    // `resolveChainMode` accepts either being ready.
    //
    // A configuration error here must not stop the worker — it is caught, recorded
    // as a readiness reason, and the chain clamps to paper. Throwing would take
    // down execution for every chain because one chain's optional live path is
    // misconfigured.
    try {
        const created = createJupiterJitoRuntimeFromEnvironment(redisClient);
        if (created) {
            console.log(`[trade-executor] Jupiter+Jito ready, signer ${created.signer.publicKey.slice(0, 8)}…`);
        }
        else {
            console.log(`[trade-executor] Jupiter+Jito unavailable: ${getJupiterJitoLiveReadiness().reason}`);
        }
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.error(`[trade-executor] Jupiter+Jito configuration failed: ${reason}`);
    }
    await verifyPolymarketEnvironment().catch(err => {
        console.error(`[trade-executor] Polymarket startup check failed: ${err.message}`);
    });
    let reconciliationRunning = false;
    const reconcilePending = async () => {
        if (reconciliationRunning)
            return;
        reconciliationRunning = true;
        try {
            const tasks = [];
            if (robinhoodRuntime) {
                tasks.push({
                    chain: 'robinhood-chain',
                    run: () => runRobinhoodReconciliation(robinhoodRuntime)
                });
            }
            if (trojanRuntime) {
                tasks.push({ chain: 'solana', run: () => runTrojanReconciliation(trojanRuntime) });
            }
            const jupiterJito = getConfiguredJupiterJitoRuntime();
            if (jupiterJito) {
                tasks.push({
                    chain: 'solana',
                    run: async () => {
                        // The block height is what makes an expired-blockhash miss
                        // *provable*. Without it the sweep can only ever time out into
                        // `ambiguous`, so a definitively-dead bundle would sit pending until
                        // its TTL instead of resolving immediately. A failure reading it is
                        // not fatal — the sweep degrades to the timeout path.
                        let blockHeight;
                        try {
                            blockHeight = await getJupiterJitoSigner()?.getBlockHeight();
                        }
                        catch (error) {
                            console.warn('[trade-executor] block height unavailable for Jito sweep', error instanceof Error ? error.message : error);
                        }
                        const resolutions = await jupiterJito.sweep(blockHeight);
                        if (resolutions.length > 0) {
                            console.log(`[trade-executor] jito sweep resolved ${resolutions.length}: `
                                + resolutions.map((r) => `${r.clientOrderId}=${r.status}`).join(', '));
                        }
                    }
                });
            }
            // Redeem resolved Polymarket positions (S3-18). A resolved market stops
            // accepting orders, so a winning position cannot be sold — redemption is
            // the only exit, and without this the position stays open in the ledger
            // forever with its collateral stranded.
            //
            // Gated on the live client existing: redemption is a real on-chain claim,
            // so there is nothing to do in paper mode. `runChainReconciliations` maps
            // positionally rather than keying by chain, so a second 'polygon' task
            // sits alongside the venue sweep without either being dropped.
            const polymarketClient = getPolymarketClientIfReady();
            if (polymarketClient && getPolymarketLiveReadiness().ready) {
                tasks.push({
                    chain: 'polygon',
                    run: async () => {
                        // The claim ports are REQUIRED, not optional decoration. Without
                        // them `runPolymarketRedemptionSweep` falls back to
                        // `unwiredPositionExitPort`, which throws for every market that maps
                        // to a position -- so before this line, S4-M19's single-winner claim
                        // was inert in production and every market was counted `failed`.
                        // Found 2026-09-01 while wiring S4-M45.
                        const sweep = await runPolymarketRedemptionSweep({
                            client: polymarketClient,
                            claimPositionExit: claimPolymarketPositionExit,
                            confirmPositionExit: confirmPolymarketPositionExit,
                            releasePositionExit: releasePolymarketPositionExit,
                            releaseStalePositionExits: releaseStalePolymarketPositionExits,
                            log: (message) => console.log(message)
                        });
                        if (sweep.redeemed > 0 || sweep.failed > 0) {
                            console.log(`[trade-executor] polymarket redemption: scanned ${sweep.scanned}, `
                                + `redeemed ${sweep.redeemed}, failed ${sweep.failed}, skipped ${sweep.skipped}`);
                        }
                    }
                });
            }
            await runChainReconciliations(tasks);
            // The per-venue sweeps above are the fast path and run first. This is the
            // backstop for canonical executions their pending stores can no longer
            // see. It shares this guard rather than getting its own timer so two
            // reconciliation passes can never overlap.
            try {
                const sweep = await runReconciliationCoordinator({
                    claim: ({ limit }) => claimCopyExecutionsForReconciliation({ limit }),
                    release: (input) => releaseCopyExecutionReconciliationClaim(input),
                    reconcilers: buildVenueReconcilers({
                        robinhoodRuntime,
                        trojanRuntime,
                        polymarketReady: getPolymarketLiveReadiness().ready
                    }),
                    escalate: escalateStuckExecution(redisClient),
                    account: RECONCILIATION_ACCOUNT
                });
                if (sweep.claimed > 0) {
                    console.log(`[trade-executor] canonical reconciliation: claimed ${sweep.claimed}, `
                        + `resolved ${sweep.resolved}, pending ${sweep.pending}, `
                        + `unresolved ${sweep.unresolved}, exhausted ${sweep.exhausted}, `
                        + `unsupported ${sweep.unsupported}`);
                }
            }
            catch (error) {
                console.error('[trade-executor] canonical reconciliation failed', error);
            }
            // Escalate Polymarket exits reconciliation has already declared unfilled
            // (S4-M17). An unfilled sell leaves the user holding a position their
            // master has left, which is worse than a missed entry, so the ladder in
            // `polymarket-exit-escalation.ts` re-offers it at progressively deeper
            // limits and then hands the decision to a human.
            //
            // Last in the pass, and inside this guard rather than on a timer of its
            // own (C1): a rung rests for its full lifetime inside this call, so
            // running it earlier would delay the fast per-venue sweeps above, and a
            // second timer could overlap a ladder with the reconciliation that
            // classifies its own rungs.
            try {
                const exits = await runPolymarketExitEscalationSweep({
                    emitAlert: async (alert, candidate) => {
                        console.error(`[trade-executor] polymarket exit escalation ${alert.code} on trade `
                            + `${candidate.id}: ${alert.reason}`);
                        await redisClient.publish(REDIS_CHANNELS.alertQueue, JSON.stringify({
                            type: 'POLYMARKET_EXIT_ESCALATION',
                            title: 'Polymarket exit could not be completed',
                            message: `Trade ${candidate.id} (sell ${candidate.token_mint}) still holds `
                                + `${alert.remainingShares} shares after the exit escalation ladder.\n`
                                + `Venue order: ${candidate.venue_order_id}\n`
                                + `Code: ${alert.code}\n`
                                + `Reason: ${alert.reason}\n`
                                + 'It will not be escalated further automatically. Redeem, hold, or unwind by hand.',
                            severity: alert.severity === 'critical' ? 'high' : 'medium',
                            chain: 'polygon'
                        }));
                    },
                    log: (message) => console.log(message)
                });
                if (exits.escalated > 0 || exits.alerted > 0 || exits.failed > 0 || exits.skipped > 0) {
                    console.log(`[trade-executor] polymarket exit escalation: scanned ${exits.scanned}, `
                        + `escalated ${exits.escalated}, completed ${exits.completed}, `
                        + `alerted ${exits.alerted}, redeemed ${exits.redeemed}, `
                        + `failed ${exits.failed}, skipped ${exits.skipped}`);
                }
            }
            catch (error) {
                console.error('[trade-executor] polymarket exit escalation failed', error);
            }
        }
        finally {
            reconciliationRunning = false;
        }
    };
    await reconcilePending().catch((error) => {
        console.error('[trade-executor] startup reconciliation failed', error);
    });
    // One worker per chain at concurrency 1, plus a drain worker on the pre-split
    // queue (D6 / S3-25). Before the split a single concurrency-3 worker served
    // every chain, so a slow venue held a slot the other two needed; now a
    // Polymarket settlement delay or a Robinhood RPC outage cannot stall Solana
    // copies. Total concurrency is unchanged — the three slots are just no longer
    // shared. See `trade-workers.ts` for why concurrency stays at 1.
    // The authority port, constructed here at the process edge and threaded into
    // every job (`S4-P7`). `handleJob`'s default parameter exists for the test
    // suites and the acceptance scripts; the worker never relies on it.
    const jobPorts = createExecutorJobPorts();
    for (const spec of tradeWorkerSpecs()) {
        const tradeWorker = new Worker(spec.queue, (job) => {
            const misroute = misroutedJobWarning(spec, chainFromJob(job));
            if (misroute)
                console.error(misroute);
            return executeJobWithCircuitBreaker(job, (queued) => handleJob(queued, jobPorts));
        }, { connection: redisClient, concurrency: spec.concurrency, autorun: true });
        tradeWorker.on('failed', (_job, err) => {
            console.error(`[trade-executor] job failed on ${spec.queue}`, err?.message);
        });
        tradeWorker.on('error', (err) => {
            console.error(`[trade-executor] worker error on ${spec.queue}`, err);
        });
        console.log(`[trade-executor] worker listening on ${spec.queue}`
            + ` (chain: ${spec.chain ?? 'any — drain only'}, concurrency: ${spec.concurrency})`);
    }
    setInterval(() => {
        reconcilePending().catch((error) => {
            console.error('[trade-executor] periodic reconciliation failed', error);
        });
    }, 60_000);
    setInterval(() => {
        pollPolymarketOrders().catch(() => { });
    }, 60_000);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error('[trade-executor] fatal startup failure', error);
        process.exitCode = 1;
    });
}
//# sourceMappingURL=index.js.map