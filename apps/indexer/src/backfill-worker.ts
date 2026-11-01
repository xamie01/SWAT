import type { Job } from 'bullmq';
import type { RecordIngestionBatchInput } from '@swat/db';
import {
  isChain,
  resolveChainAddress,
  type Chain,
  type WalletBackfillJobData
} from '@swat/shared';
import { runTrackedIngestion, type IngestionBatchResult } from './ingestion-health.js';

type BatchRecorder = (input: RecordIngestionBatchInput) => Promise<void>;

export type WalletBackfillProcessorDependencies = {
  backfillSolana(address: string): Promise<IngestionBatchResult>;
  backfillPolygon(address: string): Promise<IngestionBatchResult>;
  backfillRobinhood(address: string): Promise<IngestionBatchResult>;
  recordBatch: BatchRecorder;
  sourceForChain?: (chain: Chain) => string;
};

export function getBackfillSource(chain: Chain): string {
  if (chain === 'solana') return 'solana-backfill';
  if (chain === 'polygon') return 'polymarket-data-api';
  return 'robinhood-evm';
}

export function createWalletBackfillProcessor(
  dependencies: WalletBackfillProcessorDependencies
) {
  return async (job: Pick<Job, 'data'>) => {
    const data = job.data as Partial<WalletBackfillJobData>;
    if (!isChain(data.chain)) {
      throw new Error(`Unsupported wallet backfill chain: ${String(data.chain)}`);
    }
    if (typeof data.address !== 'string') {
      throw new Error('Wallet backfill job is missing an address');
    }

    const resolved = resolveChainAddress(data.address, data.chain);
    const { chain, raw: address } = resolved;
    const source = dependencies.sourceForChain?.(chain) ?? getBackfillSource(chain);
    console.log(`[indexer] backfill started for ${address} (${chain})`);

    const result = await runTrackedIngestion({
      chain,
      source,
      run: () => {
        if (chain === 'solana') return dependencies.backfillSolana(address);
        if (chain === 'polygon') return dependencies.backfillPolygon(address);
        return dependencies.backfillRobinhood(address);
      }
    }, dependencies.recordBatch);

    console.log(`[indexer] backfill complete for ${address} (${chain}):`, result);

    // Immediate post-backfill scoring so trader metrics are created instantly
    try {
      const { getWalletMetrics, updateWalletScore } = await import('@swat/db');
      const { calculateCompositeScore, scoreToTier } = await import('@swat/shared');
      const metrics = await getWalletMetrics(resolved.prefixed, chain);
      const score = calculateCompositeScore(metrics);
      const tier = scoreToTier(score);
      await updateWalletScore(resolved.prefixed, score, tier, metrics);
      console.log(`[indexer] immediate post-backfill scoring complete for ${resolved.prefixed}: score=${score}, tier=${tier}`);
    } catch (scoreErr) {
      console.warn(`[indexer] post-backfill scoring deferred for ${resolved.prefixed}:`, scoreErr);
    }

    return { address, chain, ...result };
  };
}
