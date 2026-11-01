import { describe, expect, it, vi } from 'vitest';
import { INGESTION_CHAINS, type Chain, type RawIngestionHealth } from '@swat/shared';
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
  it('deduplicates stale alerts and sends one recovery transition', async () => {
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

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][0]).toContain('SWAT INGESTION OPS ALERT');
    expect(send.mock.calls[1][0]).toContain('SWAT INGESTION RECOVERY');
  });

  it('releases an unsent reservation so the next poll can retry', async () => {
    const state = createStatefulReservations();
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('Telegram unavailable'))
      .mockResolvedValueOnce(undefined);
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
    const message = formatIngestionOpsMessage({
      chain: 'robinhood-chain',
      status: 'empty',
      lastEventAt: null,
      lastBatchAt: null,
      lastSuccessAt: null,
      lagSeconds: null,
      batchLagSeconds: null,
      staleAfterSeconds: 900,
      targetLagSeconds: 900,
      inserted24h: 0,
      skipped24h: 0,
      failed24h: 1,
      insertRatio: null
    }, 'stale');

    expect(message).toContain('<b>State:</b> NO DATA');
    expect(message).toContain('<b>Last event:</b> never');
  });
});
