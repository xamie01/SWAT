import { describe, expect, it, vi } from 'vitest';
import { INGESTION_CHAINS, buildIngestionHealthSnapshots, type Chain, type RawIngestionHealth } from '@swat/shared';
import {
  checkIngestionHealth,
  formatIngestionOpsMessage
} from './ingestion-health.js';

const NOW = new Date('2026-07-19T12:00:00.000Z');

function row(
  chain: Chain,
  lastEventAt: string | null
): RawIngestionHealth {
  return {
    chain,
    lastEventAt,
    lastBatchAt: lastEventAt,
    lastSuccessAt: lastEventAt,
    inserted24h: 9,
    skipped24h: 1,
    failed24h: 0
  };
}

function rowsWith(
  target: RawIngestionHealth
): RawIngestionHealth[] {
  const healthyEvent = '2026-07-19T11:59:00.000Z';
  return INGESTION_CHAINS.map((chain) =>
    chain === target.chain ? target : row(chain, healthyEvent)
  );
}

function createStatefulReservations() {
  const states = new Map<Chain, 'unknown' | 'healthy' | 'stale'>();
  const reservations = new Map<string, { chain: Chain; target: 'healthy' | 'stale' }>();
  let sequence = 0;

  return {
    reserve: vi.fn(async (chain: Chain, target: 'healthy' | 'stale') => {
      const current = states.get(chain) ?? 'unknown';
      if (target === 'healthy' && current !== 'stale') {
        states.set(chain, 'healthy');
        return null;
      }
      if (target === current) return null;
      const token = `reservation-${++sequence}`;
      reservations.set(token, { chain, target });
      return token;
    }),
    complete: vi.fn(async (
      chain: Chain,
      reservation: string,
      target: 'healthy' | 'stale'
    ) => {
      const pending = reservations.get(reservation);
      if (!pending || pending.chain !== chain || pending.target !== target) return false;
      states.set(chain, target);
      reservations.delete(reservation);
      return true;
    }),
    release: vi.fn(async (_chain: Chain, reservation: string) => {
      reservations.delete(reservation);
    })
  };
}

describe('ingestion health alert monitor', () => {
  it('displays fresh but unready evidence without converting missing counters into zero', () => {
    const health = buildIngestionHealthSnapshots([row('solana', '2026-07-19T11:59:00.000Z')], NOW)[0]!;
    const message = formatIngestionOpsMessage(health, 'stale');
    expect(message).toContain('<b>State:</b> UNREADY');
    expect(message).toContain('<b>Readiness:</b> unknown');
    expect(message).toContain('<b>Completeness:</b> unknown');
    expect(message).toContain('<b>Confirmation:</b> unknown');
    expect(message).toContain('<b>24h observed:</b> unknown');
    expect(message).toContain('<b>24h quarantined:</b> unknown');
    expect(message).toContain('<b>24h accepted:</b> unknown');
  });

  it('displays withheld confirmation and actual attempt counters separately from legacy inserts', () => {
    const health = buildIngestionHealthSnapshots([{
      ...row('solana', '2026-07-19T11:59:00.000Z'),
      evidenceTotals: { observed: 3, quarantined: 3, accepted: 0 },
      sourceEvidence: [{ source: 'solana-webhook', batchAt: NOW, evidence: {
        observed: 3, quarantined: 3, accepted: 0,
        completeness: 'complete', scope: 'delivery', confirmation: 'withheld'
      } }]
    }], NOW)[0]!;
    const message = formatIngestionOpsMessage(health, 'stale');
    expect(message).toContain('<b>State:</b> UNREADY');
    expect(message).toContain('<b>Readiness:</b> blocked');
    expect(message).toContain('<b>Completeness:</b> complete');
    expect(message).toContain('<b>Confirmation:</b> withheld');
    expect(message).toContain('<b>24h observed:</b> 3');
    expect(message).toContain('<b>24h quarantined:</b> 3');
    expect(message).toContain('<b>24h accepted:</b> 0');
    expect(message).toContain('<b>24h inserted:</b> 9');
  });

  it('deduplicates nonhealthy alerts and never fabricates recovery from recent events', async () => {
    const state = createStatefulReservations();
    const send = vi.fn().mockResolvedValue(undefined);
    let rows = rowsWith(row('solana', '2026-07-19T11:50:00.000Z'));
    const dependencies = {
      ...state,
      loadHealth: async () => rows,
      send,
      now: () => NOW
    };

    await checkIngestionHealth(dependencies);
    await checkIngestionHealth(dependencies);
    rows = rowsWith(row('solana', '2026-07-19T11:59:00.000Z'));
    await checkIngestionHealth(dependencies);
    await checkIngestionHealth(dependencies);

    expect(send).toHaveBeenCalledTimes(INGESTION_CHAINS.length);
    expect(send.mock.calls[0][0]).toContain('SWAT INGESTION OPS ALERT');
    expect(send.mock.calls.every(([message]) => !String(message).includes('SWAT INGESTION RECOVERY'))).toBe(true);
    expect(state.reserve.mock.calls.every(([, target]) => target === 'stale')).toBe(true);
  });

  it('releases an unsent reservation so the next poll can retry', async () => {
    const state = createStatefulReservations();
    let polygonFailure = true;
    const send = vi.fn(async (message: string) => {
      if (polygonFailure && message.includes('<b>Chain:</b> polygon')) {
        polygonFailure = false;
        throw new Error('Telegram unavailable');
      }
    });
    const dependencies = {
      ...state,
      loadHealth: async () => rowsWith(row('polygon', null)),
      send,
      now: () => NOW
    };

    const first = await checkIngestionHealth(dependencies);
    const second = await checkIngestionHealth(dependencies);

    expect(first.find((item) => item.chain === 'polygon')?.action).toBe('failed');
    expect(second.find((item) => item.chain === 'polygon')?.action).toBe('sent');
    expect(state.release).toHaveBeenCalledOnce();
  });

  it('formats empty state as an explicit no-data incident', () => {
    const health = buildIngestionHealthSnapshots([{
      ...row('robinhood-chain', null), inserted24h: 0, skipped24h: 0, failed24h: 1
    }], NOW).find(item => item.chain === 'robinhood-chain')!;
    const message = formatIngestionOpsMessage(health, 'stale');

    expect(message).toContain('<b>State:</b> NO DATA');
    expect(message).toContain('<b>Last event:</b> never');
  });
});
