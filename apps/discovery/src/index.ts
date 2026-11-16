import { Queue } from 'bullmq';
import cron from 'node-cron';
import { Redis } from 'ioredis';
import {
  createWalletBackfillJob,
  QUEUES,
  REDIS_CHANNELS
} from '@swat/shared';
import {
  findFundedUnknownWallets,
  findFrequentCounterparties,
  logDiscoveryRun
} from '@swat/db';
import {
  persistDiscoveredWalletBackfill,
  listPendingDiscoveryBackfills,
  acknowledgeDiscoveryBackfill
} from '../../../packages/db/src/discovery-queries.js';
import { createDiscoveryRunner } from './runner.js';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const queueConnection = new Redis(redisUrl, { maxRetriesPerRequest: null });
const backfillQueue = new Queue(QUEUES.walletBackfill, {
  connection: queueConnection
});

const runner = createDiscoveryRunner({
  findFundedUnknownWallets,
  findFrequentCounterparties,
  logDiscoveryRun,
  persistBackfill: persistDiscoveredWalletBackfill,
  listPendingBackfills: listPendingDiscoveryBackfills,
  acknowledgeBackfill: acknowledgeDiscoveryBackfill,
  enqueueBackfill: async (address, chain) => {
    const job = createWalletBackfillJob(address, chain);
    // Retain this discovery job's identity across a lost DB acknowledgement.
    // Administrative removal/Redis loss still bounds queue idempotency.
    await backfillQueue.add(job.name, job.data, { ...job.options, removeOnComplete: false });
  }
});

// Recovery is independent of discovery candidates and RUN_ON_STARTUP. Queue
// acceptance is idempotent only while the stable BullMQ job ID is retained.
const recoverBackfills = () => runner.recoverPendingBackfills().catch(error => {
  console.error('[discovery] pending backfill recovery failed', error);
});
void recoverBackfills();
cron.schedule('* * * * *', () => { void recoverBackfills(); }, { timezone: 'UTC' });

cron.schedule(
  '30 2 * * *',
  () => {
    void runner.runNightlyDiscoverySafe();
  },
  {
    timezone: 'UTC'
  }
);

const subscriber = new Redis(redisUrl, { maxRetriesPerRequest: null });

function subscribeChannels() {
  subscriber.subscribe(REDIS_CHANNELS.discoveryRun, (error) => {
    if (error) console.error('[discovery] subscribe failed', error);
    else console.log('[discovery] subscribed to discovery control channel.');
  });
}

subscribeChannels();
subscriber.on('ready', subscribeChannels);
subscriber.on('error', (error) =>
  console.error('[discovery] redis subscriber error', error.message)
);
queueConnection.on('error', (error) =>
  console.error('[discovery] redis queue error', error.message)
);
backfillQueue.on('error', (error: Error) =>
  console.error('[discovery] backfill queue error', error)
);

subscriber.on('message', (channel) => {
  if (channel === REDIS_CHANNELS.discoveryRun) {
    void runner.runNightlyDiscoverySafe();
  }
});

console.log(
  '[discovery] Service running. Scheduled at 02:30 UTC daily; listening for on-demand triggers.'
);

if (process.env.RUN_ON_STARTUP === 'true') {
  void runner.runNightlyDiscoverySafe();
}
