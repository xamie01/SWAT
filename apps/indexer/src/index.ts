import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { upsertWallet } from '@swat/db';
import { walletInputSchema } from '@swat/shared';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const redis = new IORedis(redisUrl, { maxRetriesPerRequest: null });

const backfillQueue = new Queue('swat:backfill-wallet', { connection: redis });

export async function ingestWallets(input: Array<{ address: string; source?: 'shiller' | 'manual' | 'discovered'; nickname?: string }>) {
  const parsed = input.map((wallet) => walletInputSchema.safeParse(wallet));
  const valid = parsed.filter((p): p is { success: true; data: { address: string; source: 'shiller' | 'manual' | 'discovered'; nickname?: string } } => p.success).map((p) => p.data);

  for (const wallet of valid) {
    await upsertWallet(wallet);
    await backfillQueue.add('backfill-wallet', { address: wallet.address }, { jobId: `backfill:${wallet.address}`, removeOnComplete: true, removeOnFail: 1000 });
  }

  return { accepted: valid.length, rejected: parsed.length - valid.length };
}

new Worker(
  'swat:backfill-wallet',
  async (job) => {
    const address = (job.data as { address: string }).address;
    console.log(`[indexer] backfill requested for ${address}`);
    // TODO: Helius getSignaturesForAddress + getParsedTransactions integration
    return { address, status: 'queued_for_helius_backfill' };
  },
  { connection: redis }
);

const fromEnv = (process.env.WALLET_ADDRESSES ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)
  .map((address) => ({ address, source: 'manual' as const }));

if (fromEnv.length > 0) {
  ingestWallets(fromEnv)
    .then((result) => console.log(`[indexer] ingestion result`, result))
    .catch((error) => {
      console.error('[indexer] ingestion failed', error);
      process.exit(1);
    });
}

console.log('[indexer] service running');
