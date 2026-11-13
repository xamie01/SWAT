import { describe, expect, it } from 'vitest';
import { buildIngestionHealthSnapshots } from './ingestion-health.js';

const now = new Date('2026-11-13T12:00:00Z');
const row = {
  chain: 'solana' as const, lastEventAt: '2026-11-13T11:59:59Z',
  lastBatchAt: '2026-11-13T11:59:59Z', lastSuccessAt: '2026-11-13T11:59:59Z',
  inserted24h: '0', skipped24h: '3', failed24h: '0'
};

describe('package11 public health readiness', () => {
  it('keeps complete paging separate from withheld confirmation, including zero observations', () => {
    const [health] = buildIngestionHealthSnapshots([{ ...row,
      evidenceTotals: { observed: 0, quarantined: 0, accepted: 0 },
      sourceEvidence: [{ source: 'solana-backfill', batchAt: row.lastBatchAt,
        evidence: { observed: 0, quarantined: 0, accepted: 0, completeness: 'complete',
          scope: 'provider-pagination', confirmation: 'withheld' } }]
    }], now);
    expect(health).toMatchObject({ status: 'unready', readiness: 'blocked',
      completeness: 'complete', confirmation: 'withheld', observed24h: 0 });
  });
  it('does not let a newer source hide an incomplete or unknown independent source', () => {
    const [health] = buildIngestionHealthSnapshots([{ ...row, sourceEvidence: [
      { source: 'solana-backfill', batchAt: row.lastBatchAt,
        evidence: { observed: 1, quarantined: 1, accepted: 0, completeness: 'partial',
          scope: 'requested-window', confirmation: 'withheld' } },
      { source: 'solana-webhook', batchAt: row.lastBatchAt, evidence: null }
    ] }], now);
    expect(health).toMatchObject({ readiness: 'blocked', completeness: 'partial', confirmation: 'withheld' });
    expect(health.sourceEvidence).toHaveLength(2);
  });
  it('treats fabricated verified confirmation and stale completeness as unknown', () => {
    const [health] = buildIngestionHealthSnapshots([{ ...row, sourceEvidence: [
      { source: 'legacy', batchAt: row.lastBatchAt,
        evidence: { observed: 9, quarantined: 0, accepted: 9, completeness: 'complete',
          scope: 'delivery', confirmation: 'verified' } as never },
      { source: 'old', batchAt: '2026-11-12T00:00:00Z',
        evidence: { observed: 0, quarantined: 0, accepted: 0, completeness: 'complete',
          scope: 'requested-window', confirmation: 'unknown' } }
    ] }], now);
    expect(health).toMatchObject({ readiness: 'unknown', completeness: 'unknown', confirmation: 'unknown' });
  });
  it('does not label recent observed events or legacy success timestamps healthy', () => {
    const [health] = buildIngestionHealthSnapshots([row], now);
    expect(health).toMatchObject({
      status: 'unready', eventFreshness: 'fresh', readiness: 'unknown',
      completeness: 'unknown', confirmation: 'unknown',
      observed24h: null, quarantined24h: null, accepted24h: null,
      inserted24h: 0, skipped24h: 3
    });
  });
});
