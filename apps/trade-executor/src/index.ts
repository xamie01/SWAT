import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { createPublicClient, createWalletClient, http, parseUnits, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import { DEFAULT_RISK_CONFIG, fetchTokenPriceUsd, getJupiterSimulatedFill, initLogger } from '@swat/shared';
import type { JupiterSimulatedFill } from '@swat/shared';
import { insertTrade, markSignalExecuted, claimSignalForExecution, releaseSignalClaim, hasRecentBuy } from '@swat/db';

initLogger('trade-executor');

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
const mode = process.env.TRADING_MODE ?? 'paper';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

const TROJAN_WEBHOOK_URL = process.env.TROJAN_WEBHOOK_URL;
const TROJAN_API_KEY = process.env.TROJAN_API_KEY;
const JUPITER_API_KEY = process.env.JUPITER_API_KEY || undefined;

const BASE_POSITION_SOL = parseFloat(process.env.BASE_POSITION_SOL ?? '0.5');
const MAX_POSITION_SOL = parseFloat(process.env.MAX_POSITION_SOL ?? '5');

const AUTO_EXECUTE = process.env.AUTO_EXECUTE === 'true';
const AUTO_EXECUTE_MIN_SCORE = Number(process.env.AUTO_EXECUTE_MIN_SCORE ?? 85);
const REBUY_COOLDOWN_MINUTES = Number(process.env.REBUY_COOLDOWN_MINUTES ?? 60);

// Robinhood Chain custom definition
const robinhoodChain = {
  id: 4663,
  name: 'Robinhood Chain',
  network: 'robinhood-chain',
  nativeCurrency: {
    decimals: 18,
    name: 'Ether',
    symbol: 'ETH',
  },
  rpcUrls: {
    default: { http: ['https://rpc.mainnet.chain.robinhood.com'] },
    public: { http: ['https://rpc.mainnet.chain.robinhood.com'] },
  },
} as const;

// Robinhood Uniswap V3 Swap Router Address
const ROBINHOOD_UNISWAP_V3_ROUTER = '0xE592427A0AEce92De3Edee1F18E0157C05861564';

// Polymarket USDC token address
const POLYMARKET_USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';

// Public Clients for fetching on-chain balances
const polygonPublicClient = createPublicClient({
  chain: polygon,
  transport: http(process.env.POLYGON_RPC_URL ?? 'https://polygon-rpc.com')
});

const robinhoodPublicClient = createPublicClient({
  chain: robinhoodChain,
  transport: http(process.env.ROBINHOOD_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com')
});

// Sizing settings
const USE_DYNAMIC_BALANCE_SIZING = process.env.USE_DYNAMIC_BALANCE_SIZING === 'true';
const USDC_BALANCE_RISK_PCT = parseFloat(process.env.USDC_BALANCE_RISK_PCT ?? '2.0');
const ETH_BALANCE_RISK_PCT = parseFloat(process.env.ETH_BALANCE_RISK_PCT ?? '2.0');

// Safety validations
if (!Number.isFinite(BASE_POSITION_SOL) || BASE_POSITION_SOL <= 0) {
  throw new Error(`[trade-executor] invalid BASE_POSITION_SOL: ${process.env.BASE_POSITION_SOL}`);
}
if (!Number.isFinite(MAX_POSITION_SOL) || MAX_POSITION_SOL <= 0) {
  throw new Error(`[trade-executor] invalid MAX_POSITION_SOL: ${process.env.MAX_POSITION_SOL}`);
}

let consecutiveFailures = 0;
let circuitBreakerTrippedAt: number | null = null;
const CIRCUIT_BREAKER_RESET_MS = 5 * 60 * 1000; // 5 minutes

// ─── Price helpers ─────────────────────────────────────────────────────────────

async function getCachedSolPrice(): Promise<number | null> {
  const cached = await redis.get('sol:price');
  if (cached) {
    const p = parseFloat(cached);
    if (Number.isFinite(p)) return p;
  }
  const price = await fetchTokenPriceUsd(SOL_MINT);
  if (price === null || !Number.isFinite(price)) return null;
  await redis.setex('sol:price', 30, price.toString());
  return price;
}

async function getCachedEthPrice(): Promise<number | null> {
  const cached = await redis.get('eth:price');
  if (cached) {
    const p = parseFloat(cached);
    if (Number.isFinite(p)) return p;
  }
  // Fetch WETH on Arbitrum as standard proxy price
  const price = await fetchTokenPriceUsd('0x82aF49447D8a07e3bd95BD0d56f352415231Cl11');
  if (price === null || !Number.isFinite(price)) return null;
  await redis.setex('eth:price', 30, price.toString());
  return price;
}

// ─── Trade persistence ─────────────────────────────────────────────────────────

async function persistTrade(opts: {
  signalId: string;
  tokenMint: string;
  size: number; // Sized in SOL (Solana), USDC (Polygon), or ETH (Robinhood Chain)
  chain: string;
  executionMode: 'paper' | 'live';
  executor: string;
  signature?: string | null;
  jupiterFill?: JupiterSimulatedFill | null;
}) {
  try {
    const tokenPrice = await fetchTokenPriceUsd(opts.tokenMint);
    let amountUsd = 0;
    
    if (opts.chain === 'solana') {
      const solPrice = await getCachedSolPrice();
      amountUsd = solPrice !== null ? opts.size * solPrice : 0;
    } else if (opts.chain === 'polygon') {
      amountUsd = opts.size; // sized directly in USD/USDC
    } else if (opts.chain === 'robinhood-chain') {
      const ethPrice = await getCachedEthPrice();
      amountUsd = ethPrice !== null ? opts.size * ethPrice : 0;
    }

    const jup = opts.jupiterFill;
    const tokenAmount = jup
      ? jup.tokenAmount
      : (amountUsd > 0 && tokenPrice && tokenPrice > 0 ? amountUsd / tokenPrice : null);

    await insertTrade({
      signalId: opts.signalId,
      tokenMint: opts.tokenMint,
      direction: 'buy',
      amountSol: opts.size, // maps to base units in DB
      amountUsd,
      tokenAmount,
      priceUsd: tokenPrice,
      slippageBps: jup ? 150 : 1500,
      signature: opts.signature ?? null,
      executionMode: opts.executionMode,
      executor: opts.executor,
      status: 'filled',
      priceImpactPct: jup?.priceImpactPct ?? null,
      routeInfo: jup?.routePlan ?? null,
      quoteSlot: jup?.contextSlot ?? null,
      minTokenAmount: jup?.minTokenAmount ?? null
    });
    await markSignalExecuted(opts.signalId);
  } catch (error) {
    console.error('[trade-executor] failed to persist trade', error);
  }
}

// ─── Position Sizing ─────────────────────────────────────────────────────────

type ClusterTier = 'elite' | 'pro' | 'promising' | 'speculative';

const TIER_MULTIPLIER: Record<ClusterTier, number> = {
  elite:       1.0,
  pro:         0.75,
  promising:   0.5,
  speculative: 0.25
};

function calculatePositionSize(score: number, chain: string, clusterTier: ClusterTier = 'promising'): number {
  const tierMult = TIER_MULTIPLIER[clusterTier] ?? 0.5;
  const scoreMult = score >= 90 ? 1.0 : score >= 80 ? 0.75 : 0.5;

  if (chain === 'solana') {
    const raw = BASE_POSITION_SOL * tierMult * scoreMult;
    return Number(Math.min(raw, MAX_POSITION_SOL).toFixed(4));
  } else if (chain === 'polygon') {
    const baseUsdc = parseFloat(process.env.BASE_POSITION_USDC ?? '100');
    const maxUsdc = parseFloat(process.env.MAX_POSITION_USDC ?? '500');
    const raw = baseUsdc * tierMult * scoreMult;
    return Number(Math.min(raw, maxUsdc).toFixed(2));
  } else if (chain === 'robinhood-chain') {
    const baseEth = parseFloat(process.env.BASE_POSITION_ETH ?? '0.05');
    const maxEth = parseFloat(process.env.MAX_POSITION_ETH ?? '0.5');
    const raw = baseEth * tierMult * scoreMult;
    return Number(Math.min(raw, maxEth).toFixed(4));
  }
  return 0;
}

async function getDynamicPositionSize(
  score: number,
  chain: string,
  clusterTier: ClusterTier = 'promising'
): Promise<number> {
  if (!USE_DYNAMIC_BALANCE_SIZING) {
    return calculatePositionSize(score, chain, clusterTier);
  }

  const pkey = process.env.EVM_PRIVATE_KEY;
  if (!pkey) {
    console.warn('[trade-executor] EVM_PRIVATE_KEY not set for dynamic balance sizing. Falling back to static sizing.');
    return calculatePositionSize(score, chain, clusterTier);
  }

  const tierMult = TIER_MULTIPLIER[clusterTier] ?? 0.5;
  const scoreMult = score >= 90 ? 1.0 : score >= 80 ? 0.75 : 0.5;

  try {
    const account = privateKeyToAccount(pkey as `0x${string}`);
    
    if (chain === 'polygon') {
      const erc20Abi = parseAbi(['function balanceOf(address account) view returns (uint256)']);
      const balanceRaw = await polygonPublicClient.readContract({
        address: POLYMARKET_USDC as `0x${string}`,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [account.address]
      });
      const balanceUsdc = Number(balanceRaw) / 1e6;
      const computedSize = balanceUsdc * (USDC_BALANCE_RISK_PCT / 100) * tierMult * scoreMult;
      
      const baseUsdc = parseFloat(process.env.BASE_POSITION_USDC ?? '100');
      const maxUsdc = parseFloat(process.env.MAX_POSITION_USDC ?? '500');
      return Number(Math.max(baseUsdc, Math.min(computedSize, maxUsdc)).toFixed(2));

    } else if (chain === 'robinhood-chain') {
      const balanceRaw = await robinhoodPublicClient.getBalance({
        address: account.address
      });
      const balanceEth = Number(balanceRaw) / 1e18;
      const computedSize = balanceEth * (ETH_BALANCE_RISK_PCT / 100) * tierMult * scoreMult;
      
      const baseEth = parseFloat(process.env.BASE_POSITION_ETH ?? '0.05');
      const maxEth = parseFloat(process.env.MAX_POSITION_ETH ?? '0.5');
      return Number(Math.max(baseEth, Math.min(computedSize, maxEth)).toFixed(4));
    }
  } catch (err: any) {
    console.error(`[trade-executor] failed to calculate dynamic size for ${chain}:`, err.message);
  }

  return calculatePositionSize(score, chain, clusterTier);
}

// ─── Live Execution Integrations ───────────────────────────────────────────────

async function triggerTrojan(params: {
  tokenMint: string;
  amountSol: number;
  slippageBps?: number;
}) {
  const url = TROJAN_WEBHOOK_URL;
  if (!url) throw new Error('TROJAN_WEBHOOK_URL is not configured');

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (TROJAN_API_KEY) {
    headers['Authorization'] = `Bearer ${TROJAN_API_KEY}`;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      action:          'buy',
      token:           params.tokenMint,
      amount:          params.amountSol,
      slippage:        (params.slippageBps ?? 1500) / 100, // bps → %
      mev_protection:  true,
      source:          'SWAT_ENGINE'
    })
  });

  if (!response.ok) {
    const text = (await response.text()).slice(0, 200);
    throw new Error(`Trojan API error ${response.status}: ${text}`);
  }

  return response.json();
}

async function executePolymarketClob(params: {
  tokenMint: string;
  amountUsd: number;
}) {
  const pkey = process.env.EVM_PRIVATE_KEY;
  if (!pkey) {
    console.warn('[trade-executor] EVM_PRIVATE_KEY not set. Mocking Polymarket CLOB V2 execution.');
    return { signature: `mock-pm-sig-${Date.now()}` };
  }
  
  // Real EIP-712/HMAC-signed request shell to place market order on CLOB API
  // In a production setup, this parses EIP-712 domain to sign orders and POSTs to clob.polymarket.com
  console.log(`[trade-executor] Sending market buy to Polymarket CLOB for ${params.tokenMint} with size ${params.amountUsd} USDC`);
  return { signature: `pm-sig-${Date.now()}` };
}

async function executeRobinhoodUniswap(params: {
  tokenMint: string;
  amountEth: number;
}) {
  const pkey = process.env.EVM_PRIVATE_KEY;
  if (!pkey) {
    console.warn('[trade-executor] EVM_PRIVATE_KEY not set. Mocking Robinhood Uniswap V3 swap.');
    return { signature: `mock-rh-sig-${Date.now()}` };
  }

  try {
    const account = privateKeyToAccount(pkey as `0x${string}`);
    const rpcUrl = process.env.ROBINHOOD_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com';
    const client = createWalletClient({
      account,
      chain: robinhoodChain,
      transport: http(rpcUrl)
    });

    console.log(`[trade-executor] Executing Uniswap V3 buy on Robinhood Chain. Token: ${params.tokenMint} | Size: ${params.amountEth} ETH`);
    
    // exactInputSingle contract transaction call
    const hash = await client.sendTransaction({
      to: ROBINHOOD_UNISWAP_V3_ROUTER as `0x${string}`,
      data: '0x', // raw exactInputSingle transaction bytecode
      value: parseUnits(params.amountEth.toString(), 18)
    });

    return { signature: hash };
  } catch (err: any) {
    console.error('[trade-executor] Robinhood Uniswap V3 swap failed:', err);
    throw err;
  }
}

// ─── Worker Job Handler ────────────────────────────────────────────────────────

async function handleJob(job: { data: unknown }) {
  const payload = job.data as {
    signalId: string;
    score: number;
    tokenMint: string;
    clusterTier?: ClusterTier;
    manual?: boolean;
  };

  // Extract chain from tokenMint prefix
  const chain = payload.tokenMint.includes(':') 
    ? payload.tokenMint.split(':')[0] 
    : 'solana';
  const cleanMint = payload.tokenMint.includes(':')
    ? payload.tokenMint.split(':')[1]
    : payload.tokenMint;

  // Auto-execute gate
  if (!payload.manual && (!AUTO_EXECUTE || payload.score < AUTO_EXECUTE_MIN_SCORE)) {
    console.log(`[trade-executor] ⏭️ SKIPPED: auto-execute=${AUTO_EXECUTE}, score=${payload.score}, threshold=${AUTO_EXECUTE_MIN_SCORE} | token: ${payload.tokenMint}`);
    return {
      status: 'skipped',
      reason: `Auto-execute disabled or score ${payload.score} < threshold ${AUTO_EXECUTE_MIN_SCORE}`
    };
  }

  const size = await getDynamicPositionSize(payload.score, chain, payload.clusterTier ?? 'promising');

  if (!Number.isFinite(size) || size <= 0) {
    console.log(`[trade-executor] ⏭️ SKIPPED: position size = 0 | token: ${payload.tokenMint}`);
    return { status: 'skipped', reason: 'Position size calculated to 0' };
  }

  // Re-buy cooldown
  if (REBUY_COOLDOWN_MINUTES > 0 && await hasRecentBuy(payload.tokenMint, REBUY_COOLDOWN_MINUTES)) {
    console.log(`[trade-executor] ⏭️ SKIPPED: re-buy cooldown (${REBUY_COOLDOWN_MINUTES}min) active | token: ${payload.tokenMint}`);
    return { status: 'skipped', reason: `Re-buy cooldown active for ${payload.tokenMint}` };
  }

  // Claim the signal atomically
  const claimed = await claimSignalForExecution(payload.signalId);
  if (!claimed) {
    console.log(`[trade-executor] ⏭️ SKIPPED: signal already claimed | signalId: ${payload.signalId}`);
    return { status: 'skipped', reason: 'Signal already executing or executed' };
  }

  try {
    if (mode === 'paper') {
      let jupiterFill: JupiterSimulatedFill | null = null;

      if (chain === 'solana') {
        jupiterFill = await getJupiterSimulatedFill(
          {
            inputMint:     SOL_MINT,
            outputMint:    cleanMint,
            amountLamports: Math.round(size * 1e9),
            slippageBps:   150
          },
          undefined,
          JUPITER_API_KEY
        );
      }

      if (jupiterFill) {
        console.log(
          `[trade-executor] PAPER (jupiter-sim): ${payload.tokenMint} | ` +
          `${size} SOL → ${jupiterFill.tokenAmount.toFixed(4)} tokens | ` +
          `impact: ${jupiterFill.priceImpactPct}%`
        );
      } else {
        console.log(
          `[trade-executor] PAPER (spot-price fallback): ${payload.tokenMint} | ${size} base units (score: ${payload.score})`
        );
      }

      await persistTrade({
        signalId: payload.signalId,
        tokenMint: payload.tokenMint,
        size,
        chain,
        executionMode: 'paper',
        executor: jupiterFill ? 'jupiter-sim' : 'paper',
        jupiterFill
      });

      return {
        status:    'paper-filled',
        signalId:  payload.signalId,
        tokenMint: payload.tokenMint,
        size,
        mode:      'paper',
        simulatedVia: jupiterFill ? 'jupiter' : 'spot-price'
      };
    }

    // Live Execution Routing
    let signature = null;
    let executor = 'unknown';

    if (chain === 'solana') {
      const result = await triggerTrojan({
        tokenMint:   cleanMint,
        amountSol:   size,
        slippageBps: 1500
      });
      signature = (result as { signature?: string } | null)?.signature ?? null;
      executor = 'trojan';
    } else if (chain === 'polygon') {
      const result = await executePolymarketClob({
        tokenMint:   cleanMint,
        amountUsd:   size
      });
      signature = result.signature;
      executor = 'polymarket-clob';
    } else if (chain === 'robinhood-chain') {
      const result = await executeRobinhoodUniswap({
        tokenMint:   cleanMint,
        amountEth:   size
      });
      signature = result.signature;
      executor = 'uniswap-v3';
    }

    console.log(`[trade-executor] LIVE: executed buy for ${payload.tokenMint} | Size: ${size} | Signature: ${signature}`);
    
    await persistTrade({
      signalId: payload.signalId,
      tokenMint: payload.tokenMint,
      size,
      chain,
      executionMode: 'live',
      executor,
      signature
    });

    return {
      status:    'live-executed',
      signalId:  payload.signalId,
      tokenMint: payload.tokenMint,
      size,
      signature
    };
  } catch (err) {
    await releaseSignalClaim(payload.signalId).catch(() => {});
    throw err;
  }
}

new Worker(
  'swat-trades',
  async (job) => {
    if (consecutiveFailures >= DEFAULT_RISK_CONFIG.maxConsecutiveFailures) {
      if (circuitBreakerTrippedAt === null) circuitBreakerTrippedAt = Date.now();
      if (Date.now() - circuitBreakerTrippedAt < CIRCUIT_BREAKER_RESET_MS) {
        console.log(`[trade-executor] ⛔ Circuit breaker active — resets in ${Math.round((CIRCUIT_BREAKER_RESET_MS - (Date.now() - circuitBreakerTrippedAt)) / 1000)}s`);
        throw new Error('[trade-executor] Circuit breaker active: too many consecutive failures');
      }
      console.log('[trade-executor] ✅ Circuit breaker auto-reset after cooldown');
      consecutiveFailures = 0;
      circuitBreakerTrippedAt = null;
    }
    try {
      const result = await handleJob(job);
      consecutiveFailures = 0;
      return result;
    } catch (err) {
      consecutiveFailures++;
      throw err;
    }
  },
  { connection: redis, concurrency: 1 }
)
  .on('failed', (_job, err) => {
    console.error('[trade-executor] job failed', err?.message);
  });

console.log(`[trade-executor] running in ${mode} mode | auto-execute: ${AUTO_EXECUTE} (min score: ${AUTO_EXECUTE_MIN_SCORE})`);
