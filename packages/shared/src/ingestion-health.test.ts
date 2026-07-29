import { describe, expect, it } from 'vitest';
import { buildIngestionHealthSnapshots } from './ingestion-health.js';

const NOW = new Date('2026-07-19T12:00:00.000Z');

describe('ingestion health snapshots', () => {
  it('calculates 24-hour counters, lag, and insert ratio', () => {
    const [solana] = buildIngestionHealthSnapshots([
      {
        chain: 'solana',
        lastEventAt: '2026-07-19T11:58:00.000Z',
        lastBatchAt: '2026-07-19T11:59:00.000Z',
        lastSuccessAt: '2026-07-19T11:59:00.000Z',
        inserted24h: '9',
        skipped24h: '1',
        failed24h: '2'
      }
    ], NOW);

    expect(solana).toMatchObject({
      status: 'healthy',
      lagSeconds: 120,
      batchLagSeconds: 60,
      inserted24h: 9,
      skipped24h: 1,
      failed24h: 2,
      insertRatio: 0.9
    });
  });

  it('uses strict threshold boundaries and marks later events stale', () => {
    const boundary = buildIngestionHealthSnapshots([
      {
        chain: 'polygon',
        lastEventAt: '2026-07-19T11:50:00.000Z',
        lastBatchAt: null,
        lastSuccessAt: null,
        inserted24h: 0,
        skipped24h: 0,
        failed24h: 0
      }
    ], NOW).find((item) => item.chain === 'polygon');

    const stale = buildIngestionHealthSnapshots([
      {
        chain: 'polygon',
        lastEventAt: '2026-07-19T11:49:59.000Z',
        lastBatchAt: null,
        lastSuccessAt: null,
        inserted24h: 0,
        skipped24h: 0,
        failed24h: 0
      }
    ], NOW).find((item) => item.chain === 'polygon');

    expect(boundary?.status).toBe('healthy');
    expect(stale?.status).toBe('stale');
  });

  it('returns every supported chain and never treats missing data as healthy', () => {
    const snapshots = buildIngestionHealthSnapshots([], NOW);

    expect(snapshots.map((item) => item.chain)).toEqual([
      'solana',
      'polygon',
      'robinhood-chain'
    ]);
    expect(snapshots.every((item) => item.status === 'empty')).toBe(true);
    expect(snapshots.every((item) => item.insertRatio === null)).toBe(true);
  });
});
