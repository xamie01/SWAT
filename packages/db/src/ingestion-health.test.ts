import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const clientQuery = vi.fn();
  const release = vi.fn();
  return {
    clientQuery,
    release,
    // `on`/`off`: a real PoolClient is an EventEmitter, and withTransaction
    // attaches an 'error' listener so a mid-transaction socket failure cannot
    // crash the process. transaction.test.ts covers that behaviour itself.
    connect: vi.fn(async () => ({ query: clientQuery, release, on: vi.fn(), off: vi.fn() })),
    query: vi.fn()
  };
});

vi.mock('./client.js', () => ({
  pool: { connect: mocks.connect },
  query: mocks.query
}));

import { recordIngestionBatch } from './ingestion-health.js';

describe('recordIngestionBatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.clientQuery.mockResolvedValue({ rows: [] });
  });

  it('records the batch event and updates counters in one transaction', async () => {
    const batchAt = new Date('2026-07-19T12:00:00.000Z');
    const lastEventAt = new Date('2026-07-19T11:59:00.000Z');

    await recordIngestionBatch({
      chain: 'polygon',
      source: 'polymarket-data-api',
      batchAt,
      lastEventAt,
      inserted: 8,
      skipped: 2,
      failed: 1
    });

    expect(mocks.clientQuery.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      expect.stringContaining('INSERT INTO ingestion_health_batches'),
      expect.stringContaining('inserted_total = ingestion_health.inserted_total'),
      'COMMIT'
    ]);
    expect(mocks.clientQuery).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      ['polygon', 'polymarket-data-api', batchAt, lastEventAt, 8, 2, 1, null]
    );
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it('rolls back when either health write fails', async () => {
    mocks.clientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error('write failed'))
      .mockResolvedValueOnce({ rows: [] });

    await expect(
      recordIngestionBatch({ chain: 'solana', source: 'solana-webhook' })
    ).rejects.toThrow('write failed');

    expect(mocks.clientQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it('rejects invalid counters before opening a transaction', async () => {
    await expect(
      recordIngestionBatch({
        chain: 'solana',
        source: 'solana-backfill',
        inserted: -1
      })
    ).rejects.toThrow(/inserted/);
    expect(mocks.connect).not.toHaveBeenCalled();
  });
});
