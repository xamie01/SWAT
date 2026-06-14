import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { DEFAULT_RISK_CONFIG, fetchTokenPriceUsd } from '@swat/shared';
import { insertTrade, markSignalExecuted } from '@swat/db';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
const mode = process.env.TRADING_MODE ?? 'paper';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

const TROJAN_WEBHOOK_URL = process.env.TROJAN_WEBHOOK_URL;
const TROJAN_API_KEY = process.env.TROJAN_API_KEY;
const BASE_POSITION_SOL = parseFloat(process.env.BASE_POSITION_SOL ?? '0.5');
const AUTO_EXECUTE = process.env.AUTO_EXECUTE === 'true';
const AUTO_EXECUTE_MIN_SCORE = Number(process.env.AUTO_EXECUTE_MIN_SCORE ?? 90);

let consecutiveFailures = 0;

// ─── Price helpers ─────────────────────────────────────────────────────────────

/** SOL/USD with a 30s Redis cache (shared key with the indexer). */
async function getCachedSolPrice(): Promise<number> {
  const cached = await redis.get('sol:price');
  if (cached) return parseFloat(cached);
  const price = (await fetchTokenPriceUsd(SOL_MINT)) ?? 150;
  await redis.setex('sol:price', 30, price.toString());
  return price;
}

/**
 * Persist a filled trade. Best-effort: a logging failure must not fail the job
 * (which would trip the circuit breaker for a non-execution reason).
 */
async function persistTrade(opts: {
  signalId: string;
  tokenMint: string;
  sizeSol: number;
  executionMode: 'paper' | 'live';
  executor: 'paper' | 'trojan';
  signature?: string | null;
}) {
  try {
    const [solPrice, tokenPrice] = await Promise.all([
      getCachedSolPrice(),
      fetchTokenPriceUsd(opts.tokenMint)
    ]);
    const amountUsd = opts.sizeSol * solPrice;
    const tokenAmount = tokenPrice && tokenPrice > 0 ? amountUsd / tokenPrice : null;

    await insertTrade({
      signalId: opts.signalId,
      tokenMint: opts.tokenMint,
      direction: 'buy',
      amountSol: opts.sizeSol,
      amountUsd,
      tokenAmount,
      priceUsd: tokenPrice,
      slippageBps: 1500,
      signature: opts.signature ?? null,
      executionMode: opts.executionMode,
      executor: opts.executor,
      status: 'filled'
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
  return Number((BASE_POSITION_SOL * tierMult * scoreMult).toFixed(4));
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
    const text = await response.text();
    throw new Error(`Trojan API error ${response.status}: ${text}`);
  }

  return response.json();
}

// ─── Worker ───────────────────────────────────────────────────────────────────

new Worker(
  'swat-trades',
  async (job) => {
    if (consecutiveFailures >= DEFAULT_RISK_CONFIG.maxConsecutiveFailures) {
      throw new Error('[trade-executor] Circuit breaker active: too many consecutive failures');
    }

    const payload = job.data as {
      signalId: string;
      score: number;
      tokenMint: string;
      clusterTier?: ClusterTier;
      manual?: boolean;
    };

    // Auto-execute only fires above the configured threshold unless manually triggered
    if (!payload.manual && (!AUTO_EXECUTE || payload.score < AUTO_EXECUTE_MIN_SCORE)) {
      return {
        status: 'skipped',
        reason: `Auto-execute disabled or score ${payload.score} < threshold ${AUTO_EXECUTE_MIN_SCORE}`
      };
    }

    const sizeSol = calculatePositionSize(payload.score, payload.clusterTier ?? 'promising');

    if (sizeSol <= 0) {
      return { status: 'skipped', reason: 'Position size calculated to 0' };
    }

    if (mode === 'paper') {
      console.log(`[trade-executor] PAPER: would buy ${payload.tokenMint} with ${sizeSol} SOL (score: ${payload.score})`);
      await persistTrade({
        signalId: payload.signalId,
        tokenMint: payload.tokenMint,
        sizeSol,
        executionMode: 'paper',
        executor: 'paper'
      });
      return {
        status:    'paper-filled',
        signalId:  payload.signalId,
        tokenMint: payload.tokenMint,
        sizeSol,
        mode:      'paper'
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
  },
  { connection: redis }
)
  .on('failed', (_job, err) => {
    consecutiveFailures++;
    console.error('[trade-executor] job failed', err.message);
  })
  .on('completed', () => {
    consecutiveFailures = 0;
  });

console.log(`[trade-executor] running in ${mode} mode | auto-execute: ${AUTO_EXECUTE} (min score: ${AUTO_EXECUTE_MIN_SCORE})`);
