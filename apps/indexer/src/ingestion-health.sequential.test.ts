import { describe, expect, it, vi } from 'vitest';
import { IngestionBatchError, runTrackedIngestion } from './ingestion-health.js';

// Approved public seam: tracked batch -> health recorder, not DB side-channel state.
describe('package11 evidence tracking', () => {
  it('exposes failed-batch evidence as partial at the direct public error seam', () => {
    const error = new IngestionBatchError('processing aborted', {
      fetched: 2, inserted: 0, skipped: 1, failed: 1, lastEventAt: null,
      evidence: { observed: 1, quarantined: 1, accepted: 0, completeness: 'complete',
        scope: 'provider-pagination', confirmation: 'withheld' }
    });
    expect(error.result.evidence?.completeness).toBe('partial');
  });
  it('preserves partial evidence on batch failure and does not convert a health-write failure into acceptance', async () => {
    const recorder = vi.fn().mockResolvedValue(undefined);
    const result = { fetched: 3, inserted: 0, skipped: 1, failed: 0, lastEventAt: null,
      evidence: { observed: 1, quarantined: 1, accepted: 0, completeness: 'complete' as const,
        scope: 'provider-pagination' as const, confirmation: 'withheld' as const } };
    const error = new IngestionBatchError('budget exhausted', result);
    await expect(runTrackedIngestion({ chain: 'polygon', source: 'polymarket-data-api',
      run: async () => { throw error; } }, recorder)).rejects.toBe(error);
    expect(recorder).toHaveBeenCalledWith(expect.objectContaining({
      skipped: 1, failed: 1, evidence: { ...result.evidence, completeness: 'partial' } }));
  });
  it('records quarantine separately without reclassifying legacy skipped/inserted counts', async () => {
    const recorder = vi.fn().mockResolvedValue(undefined);
    const result = {
      fetched: 3, inserted: 0, skipped: 3, failed: 0,
      lastEventAt: new Date('2026-11-13T12:00:00Z'),
      evidence: {
        observed: 2, quarantined: 2, accepted: 0,
        completeness: 'partial' as const, scope: 'requested-window' as const,
        confirmation: 'withheld' as const
      }
    };
    await expect(runTrackedIngestion({
      chain: 'solana', source: 'solana-backfill', run: async () => result
    }, recorder)).resolves.toBe(result);
    expect(recorder).toHaveBeenCalledWith(expect.objectContaining({
      inserted: 0, skipped: 3, failed: 0, evidence: result.evidence
    }));
  });
});
