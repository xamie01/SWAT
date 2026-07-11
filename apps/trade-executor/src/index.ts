import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
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
// Absolute ceiling on a single position, as a final safety clamp on the
// computed size (defends against misconfiguration sending a huge live buy).
const MAX_POSITION_SOL = parseFloat(process.env.MAX_POSITION_SOL ?? '5');
const AUTO_EXECUTE = process.env.AUTO_EXECUTE === 'true';
const AUTO_EXECUTE_MIN_SCORE = Number(process.env.AUTO_EXECUTE_MIN_SCORE ?? 85);
// Don't re-buy the same token within this window (a held position keeps
// re-triggering snipe signals). 0 disables the cooldown.
const REBUY_COOLDOWN_MINUTES = Number(process.env.REBUY_COOLDOWN_MINUTES ?? 60);

// Fail fast on a misconfigured base size rather than sending NaN/garbage to the
// live trade path.
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

/**
 * SOL/USD with a 30s Redis cache (shared key with the indexer). Returns null
 * when no real price is available — never a fabricated fallback, which would
 * silently corrupt cost basis on real trades.
 */
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

/**
 * Persist a filled trade. Best-effort: a logging failure must not fail the job
 * (which would trip the circuit breaker for a non-execution reason).
 *
 * When `jupiterFill` is provided (paper trades with a successful Jupiter quote),
 * its token amount and price impact override the simple spot-price division.
 * The spot-price values are still fetched and stored as `price_usd` for
 * reference, but `token_amount` comes from Jupiter's AMM-routed output.
 */
async function persistTrade(opts: {
  signalId: string;
  tokenMint: string;
  sizeSol: number;
  executionMode: 'paper' | 'live';
  executor: 'paper' | 'trojan' | 'jupiter-sim';
  signature?: string | null;
  jupiterFill?: JupiterSimulatedFill | null;
}) {
  try {
    const [solPrice, tokenPrice] = await Promise.all([
      getCachedSolPrice(),
      fetchTokenPriceUsd(opts.tokenMint)
    ]);
    // If SOL price is unavailable, store null USD rather than a fabricated cost
    // basis — the on-chain SOL amount is still recorded for later reconciliation.
    const amountUsd = solPrice !== null ? opts.sizeSol * solPrice : null;

    // Prefer the Jupiter-simulated token amount (AMM-routed, accounts for
    // slippage and price impact) over the naive spot-price division.
    const jup = opts.jupiterFill;
    const tokenAmount = jup
      ? jup.tokenAmount
      : (amountUsd !== null && tokenPrice && tokenPrice > 0 ? amountUsd / tokenPrice : null);

    await insertTrade({
      signalId: opts.signalId,
      tokenMint: opts.tokenMint,
      direction: 'buy',
      amountSol: opts.sizeSol,
      amountUsd,
      tokenAmount,
      priceUsd: tokenPrice,
      slippageBps: jup ? 150 : 1500,
      signature: opts.signature ?? null,
      executionMode: opts.executionMode,
      executor: opts.executor,
      status: 'filled',
      // Jupiter simulation enrichment (null for live trades / legacy paper)
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

// ─── Position Sizing (§9.5 of swat.md) ───────────────────────────────────────

type ClusterTier = 'elite' | 'pro' | 'promising' | 'speculative';

const TIER_MULTIPLIER: Record<ClusterTier, number> = {
  elite:       1.0,
  pro:         0.75,
  promising:   0.5,
  speculative: 0.25
};

function calculatePositionSize(score: number, clusterTier: ClusterTier = 'promising'): number {
  const tierMult = TIER_MULTIPLIER[clusterTier] ?? 0.5;
  const scoreMult = score >= 90 ? 1.0 : score >= 80 ? 0.75 : 0.5;
  const raw = BASE_POSITION_SOL * tierMult * scoreMult;
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  // Clamp to the absolute ceiling so a misconfiguration can't size a huge buy.
  return Number(Math.min(raw, MAX_POSITION_SOL).toFixed(4));
}

// ─── Trojan API integration ───────────────────────────────────────────────────

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
    // Truncate the response body before embedding it in the (logged) error so a
    // verbose upstream error can't dump request/credential echoes into logs.
    const text = (await response.text()).slice(0, 200);
    throw new Error(`Trojan API error ${response.status}: ${text}`);
  }

  return response.json();
}

// ─── Worker ───────────────────────────────────────────────────────────────────

async function handleJob(job: { data: unknown }) {
  const payload = job.data as {
    signalId: string;
    score: number;
    tokenMint: string;
    clusterTier?: ClusterTier;
    manual?: boolean;
  };

  // Auto-execute only fires above the configured threshold unless manually triggered
  if (!payload.manual && (!AUTO_EXECUTE || payload.score < AUTO_EXECUTE_MIN_SCORE)) {
    console.log(`[trade-executor] ⏭️ SKIPPED: auto-execute=${AUTO_EXECUTE}, score=${payload.score}, threshold=${AUTO_EXECUTE_MIN_SCORE} | token: ${payload.tokenMint}`);
    return {
      status: 'skipped',
      reason: `Auto-execute disabled or score ${payload.score} < threshold ${AUTO_EXECUTE_MIN_SCORE}`
    };
  }

  const sizeSol = calculatePositionSize(payload.score, payload.clusterTier ?? 'promising');

  if (!Number.isFinite(sizeSol) || sizeSol <= 0) {
    console.log(`[trade-executor] ⏭️ SKIPPED: position size = 0 | token: ${payload.tokenMint}`);
    return { status: 'skipped', reason: 'Position size calculated to 0' };
  }

  // Re-buy cooldown: skip if we already bought this token recently (a held
  // position keeps producing fresh snipe signals after the dedupe window).
  if (REBUY_COOLDOWN_MINUTES > 0 && await hasRecentBuy(payload.tokenMint, REBUY_COOLDOWN_MINUTES)) {
    console.log(`[trade-executor] ⏭️ SKIPPED: re-buy cooldown (${REBUY_COOLDOWN_MINUTES}min) active | token: ${payload.tokenMint}`);
    return { status: 'skipped', reason: `Re-buy cooldown active for ${payload.tokenMint}` };
  }

  // IDEMPOTENCY GUARD: atomically claim the signal before placing any trade.
  // A duplicate/re-delivered signal (e.g. repeated manual /execute clicks) loses
  // the claim and is skipped — preventing a second (live) buy.
  const claimed = await claimSignalForExecution(payload.signalId);
  if (!claimed) {
    console.log(`[trade-executor] ⏭️ SKIPPED: signal already claimed | signalId: ${payload.signalId}`);
    return { status: 'skipped', reason: 'Signal already executing or executed' };
  }

  try {
    if (mode === 'paper') {
      // Fetch a Jupiter quote for a realistic simulated fill.  If the quote
      // fails (network, rate limit, no route for this token) we fall back to
      // the existing spot-price logic — the trade is still recorded, just
      // without AMM-routed accuracy.
      const jupiterFill = await getJupiterSimulatedFill(
        {
          inputMint:     SOL_MINT,
          outputMint:    payload.tokenMint,
          amountLamports: Math.round(sizeSol * 1e9),
          slippageBps:   150
        },
        undefined, // outputDecimals — default 9 for most SPL tokens
        JUPITER_API_KEY
      );

      if (jupiterFill) {
        console.log(
          `[trade-executor] PAPER (jupiter-sim): ${payload.tokenMint} | ` +
          `${sizeSol} SOL → ${jupiterFill.tokenAmount.toFixed(4)} tokens | ` +
          `impact: ${jupiterFill.priceImpactPct}% | ` +
          `route hops: ${jupiterFill.routePlan.length} | ` +
          `slot: ${jupiterFill.contextSlot}`
        );
      } else {
        console.log(
          `[trade-executor] PAPER (spot-price fallback): ${payload.tokenMint} | ${sizeSol} SOL (score: ${payload.score})`
        );
      }

      await persistTrade({
        signalId: payload.signalId,
        tokenMint: payload.tokenMint,
        sizeSol,
        executionMode: 'paper',
        executor: jupiterFill ? 'jupiter-sim' : 'paper',
        jupiterFill
      });
      return {
        status:    'paper-filled',
        signalId:  payload.signalId,
        tokenMint: payload.tokenMint,
        sizeSol,
        mode:      'paper',
        simulatedVia: jupiterFill ? 'jupiter' : 'spot-price'
      };
    }

    // Live execution via Trojan
    const result = await triggerTrojan({
      tokenMint:   payload.tokenMint,
      amountSol:   sizeSol,
      slippageBps: 1500
    });

    console.log(`[trade-executor] LIVE: executed buy for ${payload.tokenMint} @ ${sizeSol} SOL`);
    await persistTrade({
      signalId: payload.signalId,
      tokenMint: payload.tokenMint,
      sizeSol,
      executionMode: 'live',
      executor: 'trojan',
      signature: (result as { signature?: string } | null)?.signature ?? null
    });
    return {
      status:    'live-executed',
      signalId:  payload.signalId,
      tokenMint: payload.tokenMint,
      sizeSol,
      trojanResult: result
    };
  } catch (err) {
    // Execution failed before fill — release the claim so it can be retried.
    await releaseSignalClaim(payload.signalId).catch(() => {});
    throw err;
  }
}

new Worker(
  'swat-trades',
  async (job) => {
    // Synchronous circuit breaker: checked and mutated inside the job (with
    // concurrency 1) so a burst of jobs can't all read 0 before the async
    // 'failed' handler fires.
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
  // concurrency 1 keeps the breaker counter coherent and serializes live trades.
  { connection: redis, concurrency: 1 }
)
  .on('failed', (_job, err) => {
    console.error('[trade-executor] job failed', err?.message);
  });

console.log(`[trade-executor] running in ${mode} mode | auto-execute: ${AUTO_EXECUTE} (min score: ${AUTO_EXECUTE_MIN_SCORE})`);
