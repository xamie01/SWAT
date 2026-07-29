import { describe, expect, it, vi } from 'vitest';
import {
  IngestionBatchError,
  runTrackedIngestion,
  type IngestionBatchResult
} from './ingestion-health.js';

const RESULT: IngestionBatchResult = {
  fetched: 12,
  inserted: 8,
  skipped: 3,
  failed: 1,
  lastEventAt: new Date('2026-07-19T12:00:00.000Z')
};

describe('tracked ingestion batches', () => {
  it('records completed counters with the source event time', async () => {
    const recorder = vi.fn().mockResolvedValue(undefined);

    await expect(
      runTrackedIngestion({
        chain: 'robinhood-chain',
        source: 'robinhood-evm',
        run: async () => RESULT
      }, recorder)
    ).resolves.toBe(RESULT);

    expect(recorder).toHaveBeenCalledWith(expect.objectContaining({
      chain: 'robinhood-chain',
      source: 'robinhood-evm',
      lastEventAt: RESULT.lastEventAt,
      inserted: 8,
      skipped: 3,
      failed: 1
    }));
  });

  it('records partial counters and rethrows a failed batch', async () => {
    const recorder = vi.fn().mockResolvedValue(undefined);
    const error = new IngestionBatchError('wallet refresh failed', RESULT);

    await expect(
      runTrackedIngestion({
        chain: 'polygon',
        source: 'polymarket-data-api',
        run: async () => {
          throw error;
        }
      }, recorder)
    ).rejects.toBe(error);

    expect(recorder).toHaveBeenCalledWith(expect.objectContaining({
      inserted: 8,
      skipped: 3,
      failed: 1,
      errorMessage: 'wallet refresh failed'
    }));
  });

  it('records one failed batch when ingestion stops before counters exist', async () => {
    const recorder = vi.fn().mockResolvedValue(undefined);

    await expect(
      runTrackedIngestion({
        chain: 'solana',
        source: 'solana-backfill',
        run: async () => {
          throw new Error('RPC unavailable');
        }
      }, recorder)
    ).rejects.toThrow('RPC unavailable');

    expect(recorder).toHaveBeenCalledWith(expect.objectContaining({
      inserted: 0,
      skipped: 0,
      failed: 1,
      lastEventAt: null
    }));
  });

  it('does not misclassify a health write failure as an ingestion failure', async () => {
    const recorder = vi.fn().mockRejectedValue(new Error('health write failed'));

    await expect(
      runTrackedIngestion({
        chain: 'solana',
        source: 'solana-backfill',
        run: async () => RESULT
      }, recorder)
    ).rejects.toThrow('health write failed');

    expect(recorder).toHaveBeenCalledOnce();
  });
});
