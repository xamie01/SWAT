import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { DEFAULT_RISK_CONFIG } from '@swat/shared';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
const mode = process.env.TRADING_MODE ?? 'paper';

let consecutiveFailures = 0;

new Worker(
  'swat:trades',
  async (job) => {
    if (consecutiveFailures >= DEFAULT_RISK_CONFIG.maxConsecutiveFailures) {
      throw new Error('Circuit breaker active: too many consecutive failures');
    }

    const payload = job.data as { signalId: string; score: number };

    if (payload.score < 80) {
      return { status: 'ignored', reason: 'score below auto execute threshold' };
    }

    if (mode === 'paper') {
      return {
        status: 'paper-filled',
        signalId: payload.signalId,
        note: 'Paper mode execution only, no on-chain swap sent'
      };
    }

    throw new Error('Live trading path reserved for Jupiter integration and transaction simulation');
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
