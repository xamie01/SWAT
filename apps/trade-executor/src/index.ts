import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { DEFAULT_RISK_CONFIG } from '@swat/shared';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
const mode = process.env.TRADING_MODE ?? 'paper';

let consecutiveFailures = 0;

const TROJAN_WEBHOOK_URL = process.env.TROJAN_WEBHOOK_URL;
const BASE_POSITION_SOL = 0.1; // Base position size

function calculatePositionSize(score: number): number {
  if (score >= 95) return BASE_POSITION_SOL * 2.0; // High conviction
  if (score >= 90) return BASE_POSITION_SOL * 1.5;
  if (score >= 80) return BASE_POSITION_SOL * 1.0;
  return 0; // Below threshold
}

new Worker(
  'swat:trades',
  async (job) => {
    if (consecutiveFailures >= DEFAULT_RISK_CONFIG.maxConsecutiveFailures) {
      throw new Error('Circuit breaker active: too many consecutive failures');
    }

    const payload = job.data as { signalId: string; score: number; tokenMint: string };

    if (payload.score < 80) {
      return { status: 'ignored', reason: 'score below auto execute threshold' };
    }

    const sizeSol = calculatePositionSize(payload.score);

    if (mode === 'paper') {
      console.log(`[trade-executor] PAPER MODE: Would execute buy for ${payload.tokenMint} with ${sizeSol} SOL`);
      return {
        status: 'paper-filled',
        signalId: payload.signalId,
        sizeSol,
        note: 'Paper mode execution only, no on-chain swap sent'
      };
    }

    // Live Execution via Trojan Bot Webhook
    if (!TROJAN_WEBHOOK_URL) {
      throw new Error('TROJAN_WEBHOOK_URL is missing in live mode');
    }

    const response = await fetch(TROJAN_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'buy',
        tokenAddress: payload.tokenMint,
        amountSol: sizeSol,
        slippageBps: 200,
        priorityFeeSol: 0.005,
        source: 'SWAT_ENGINE'
      })
    });

    if (!response.ok) {
      throw new Error(`Trojan webhook failed: ${response.status}`);
    }

    console.log(`[trade-executor] LIVE MODE: Executed buy for ${payload.tokenMint} with ${sizeSol} SOL via Trojan`);
    return { status: 'live-executed', signalId: payload.signalId, sizeSol };
  },
  {
    connection: redis
  }
).on('failed', (_job, err) => {
  consecutiveFailures += 1;
  console.error('[trade-executor] job failed', err.message);
}).on('completed', () => {
  consecutiveFailures = 0;
});

console.log(`[trade-executor] service running in ${mode} mode`);
