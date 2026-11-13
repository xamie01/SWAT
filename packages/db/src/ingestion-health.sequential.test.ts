import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  query: vi.fn(), clientQuery: vi.fn(), release: vi.fn(), connect: vi.fn()
}));
vi.mock('./client.js', () => ({ pool: { connect: mocks.connect }, query: mocks.query }));
import { getIngestionHealth24h, recordIngestionBatch } from './ingestion-health.js';
const evidence = { observed: 2, quarantined: 2, accepted: 0,
  completeness: 'unknown' as const, scope: 'requested-window' as const, confirmation: 'withheld' as const };

describe('package11 DB health evidence public seams', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connect.mockResolvedValue({ query: mocks.clientQuery, release: mocks.release, on: vi.fn(), off: vi.fn() });
    mocks.clientQuery.mockImplementation(async (sql: string) => ({
      command: sql === 'COMMIT' ? 'COMMIT' : undefined,
      rows: sql.includes('pg_attribute') ? [{ available: true }] : []
    }));
  });
  it('keeps legacy writes working without the evidence column and does not invent zero evidence', async () => {
    mocks.clientQuery.mockImplementation(async (sql: string) => ({ command: sql === 'COMMIT' ? 'COMMIT' : undefined, rows: [] }));
    await recordIngestionBatch({ chain: 'solana', source: 'solana-backfill', skipped: 3, evidence });
    const insert = mocks.clientQuery.mock.calls.find(([sql]) => sql.includes('INSERT INTO ingestion_health_batches'))!;
    expect(insert[0]).not.toContain('error_message, evidence');
    expect(insert[1]).toHaveLength(8);
    mocks.query.mockResolvedValue([{ chain: 'solana', last_event_at: null, last_batch_at: null,
      last_success_at: null, inserted_24h: '0', skipped_24h: '3', failed_24h: '0',
      evidence_batches: [null], source_evidence: [{ source: 'solana-backfill', batchAt: '2026-11-13T12:00:00Z', evidence: null }] }]);
    expect(await getIngestionHealth24h()).toEqual([expect.objectContaining({ evidenceTotals: null,
      sourceEvidence: [{ source: 'solana-backfill', batchAt: '2026-11-13T12:00:00Z', evidence: null }] })]);
  });
  it('rejects quarantine outside skipped and fabricated verification before opening a transaction', async () => {
    await expect(recordIngestionBatch({ chain: 'solana', source: 'solana-backfill', skipped: 1, evidence }))
      .rejects.toThrow(/quarantine/);
    await expect(recordIngestionBatch({ chain: 'solana', source: 'solana-backfill', skipped: 3,
      evidence: { ...evidence, confirmation: 'verified' } as never })).rejects.toThrow(/evidence/);
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it('projects additive counters and independent latest source evidence without changing legacy totals', async () => {
    mocks.query.mockResolvedValue([{
      chain: 'solana', last_event_at: null, last_batch_at: null, last_success_at: null,
      inserted_24h: '0', skipped_24h: '3', failed_24h: '0',
      evidence_batches: [evidence],
      source_evidence: [{ source: 'solana-webhook', batchAt: '2026-11-13T12:00:00Z', evidence }]
    }]);
    expect(await getIngestionHealth24h()).toEqual([expect.objectContaining({
      inserted24h: '0', skipped24h: '3',
      evidenceTotals: { observed: 2, quarantined: 2, accepted: 0 },
      sourceEvidence: [{ source: 'solana-webhook', batchAt: '2026-11-13T12:00:00Z', evidence }]
    })]);
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("to_jsonb(b)->'evidence'"));
  });
  it('persists explicit quarantine evidence when the additive column exists', async () => {
    await recordIngestionBatch({ chain: 'solana', source: 'solana-backfill', skipped: 3, evidence });
    expect(mocks.clientQuery).toHaveBeenCalledWith(
      expect.stringContaining('error_message, evidence'),
      expect.arrayContaining([JSON.stringify(evidence)])
    );
  });
});
