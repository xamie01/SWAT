/**
 * Egress-contained BullMQ fixture worker for Wave 4 Stage B (I7).
 * Consumes `swat-backfill-wallet` and `swat-token-discovery` completely locally
 * with zero outbound network or provider calls.
 */
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const apiRequire = createRequire(resolve(__dirname, '../apps/api/package.json'));
const { Queue, Worker } = apiRequire('bullmq') as {
  Queue: new (name: string, opts: Record<string, unknown>) => any;
  Worker: new (name: string, processor: (job: { id?: string }) => Promise<unknown>, opts: Record<string, unknown>) => any;
};
const Redis = apiRequire('ioredis') as new (url: string, opts?: Record<string, unknown>) => any;

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  console.error('REDIS_URL is required');
  process.exit(2);
}

const readyFile = process.env.WORKER_READY_FILE;
const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
const workerConnectionA = new Redis(redisUrl, { maxRetriesPerRequest: null });
const workerConnectionB = new Redis(redisUrl, { maxRetriesPerRequest: null });

const QUEUES = ['swat-backfill-wallet', 'swat-token-discovery'] as const;

async function main() {
  const queues = QUEUES.map((name) => new Queue(name, { connection }));
  await Promise.all(queues.map((q) => q.waitUntilReady()));

  for (const name of QUEUES) {
    await connection.set(`bull:${name}:id`, '0', 'NX');
  }

  let processed = 0;
  const workerA = new Worker(
    QUEUES[0],
    async (job) => {
      processed += 1;
      return {
        contained: true,
        egressDenied: true,
        queue: QUEUES[0],
        jobId: job.id ?? null,
        completedAt: new Date().toISOString()
      };
    },
    { connection: workerConnectionA, concurrency: 16 }
  );

  const workerB = new Worker(
    QUEUES[1],
    async (job) => {
      processed += 1;
      return {
        contained: true,
        egressDenied: true,
        queue: QUEUES[1],
        jobId: job.id ?? null,
        completedAt: new Date().toISOString()
      };
    },
    { connection: workerConnectionB, concurrency: 16 }
  );

  await Promise.all([workerA.waitUntilReady(), workerB.waitUntilReady()]);

  if (readyFile) {
    writeFileSync(readyFile, JSON.stringify({ pid: process.pid, queues: QUEUES, readyAt: new Date().toISOString() }) + '\n', { mode: 0o600 });
  }
  console.log(JSON.stringify({ event: 'fixture-worker-ready', pid: process.pid, queues: QUEUES }));

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await Promise.allSettled([workerA.close(), workerB.close(), ...queues.map((q) => q.close())]);
    connection.disconnect();
    workerConnectionA.disconnect();
    workerConnectionB.disconnect();
    console.log(JSON.stringify({ event: 'fixture-worker-stopped', processed }));
    process.exit(0);
  };

  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
