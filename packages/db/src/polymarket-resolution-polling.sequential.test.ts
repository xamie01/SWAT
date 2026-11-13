import { describe, expect, it, vi } from 'vitest';
import { createSqlResolutionPollStore, type ResolutionPollSqlClient } from './polymarket-resolution-polling.js';

const conditionId = `0x${'1'.repeat(64)}`;
const state = { token: 'owner-1', after: null, upper: conditionId, attempted: 0, failed: 0 };
const row = { owner_token: 'owner-1', after_id: null, upper_id: conditionId, cycle_attempted: '0', cycle_failed: '0', cycle_open: true };

function fixture() {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('FOR UPDATE')) return { rows: [row] };
    if (sql.includes('RETURNING')) return { rows: [{ ...row, after_id: conditionId, cycle_attempted: '1', cycle_failed: '1' }] };
    return { rows: [] };
  });
  const client = { query } as unknown as ResolutionPollSqlClient;
  const transaction = async <T>(run: (client: ResolutionPollSqlClient) => Promise<T>): Promise<T> => run(client);
  const applyObservation = vi.fn(async () => {});
  return { query, transaction, applyObservation, store: createSqlResolutionPollStore({ transaction, applyObservation }) };
}

describe('SQL resolution polling durable storage public seam', () => {
  it('durably reserves cursor and pessimistic failed coverage before returning', async () => {
    const { store, query } = fixture();
    expect(await store.reserveAttempt(state, conditionId)).toEqual({ ...state, after: conditionId, attempted: 1, failed: 1 });
    const update = query.mock.calls.find(([sql]) => sql.includes('RETURNING'));
    expect(update?.[0]).toContain('cycle_failed = cycle_failed + 1');
    expect(update?.[0]).toContain('cycle_attempted = cycle_attempted + 1');
  });

  it('a restarted owner retains cursor and pessimistic failure rather than resetting the prefix', async () => {
    const { query, transaction, applyObservation } = fixture();
    query.mockImplementation(async sql => ({ rows: sql.includes('RETURNING') ? [{
      ...row, owner_token: 'owner-2', after_id: conditionId, cycle_attempted: '1', cycle_failed: '1'
    }] : [] }));
    const restarted = createSqlResolutionPollStore({ transaction, applyObservation });
    expect(await restarted.claim('owner-2', 40_000)).toEqual({
      token: 'owner-2', after: conditionId, upper: conditionId, attempted: 1, failed: 1
    });
    expect(query.mock.calls.some(([sql]) => sql.includes('FROM polymarket_markets'))).toBe(false);
  });

  it('a contending owner gets busy without reading the market population', async () => {
    const { store, query } = fixture();
    query.mockResolvedValue({ rows: [] });
    expect(await store.claim('owner-2', 40_000)).toBeNull();
    expect(query.mock.calls.some(([sql]) => sql.includes('FROM polymarket_markets'))).toBe(false);
  });

  it('a stale/expired owner cannot settle metadata or apply market state', async () => {
    const { store, query, applyObservation } = fixture();
    query.mockResolvedValue({ rows: [] });
    await expect(store.settleCovered({ ...state, after: conditionId, attempted: 1, failed: 1 }, null)).rejects.toThrow('lease lost');
    expect(applyObservation).not.toHaveBeenCalled();
  });

  it('mismatched durable counts/cursor refuse covered writes', async () => {
    const { store, applyObservation } = fixture();
    await expect(store.settleCovered({ ...state, after: conditionId, attempted: 1, failed: 1 }, null)).rejects.toThrow('Stale');
    expect(applyObservation).not.toHaveBeenCalled();
  });

  it('a new cycle captures only one upper key instead of loading or counting the entire population', async () => {
    const { store, query } = fixture();
    query.mockImplementation(async sql => {
      if (sql.includes('FROM polymarket_markets')) return { rows: [{ condition_id: conditionId }] } as never;
      if (sql.includes('RETURNING')) return { rows: [{ ...row, cycle_open: sql.includes('cycle_open = TRUE') }] };
      return { rows: [] };
    });
    expect(await store.claim('owner-1', 40_000)).toEqual(state);
    const read = query.mock.calls.find(([sql]) => sql.includes('FROM polymarket_markets'))![0];
    expect(read).toContain('LIMIT 1');
    expect(read).toContain('COLLATE "C" DESC');
    expect(read).not.toContain('COUNT');
  });

  it('releasing an old owner is fenced and cannot release its replacement', async () => {
    const { store, query } = fixture();
    await store.release(state);
    const release = query.mock.calls.at(-1)!;
    expect(release[0]).toContain('owner_token = $2');
  });

  it('metadata apply failures abort settlement rather than decrementing failure coverage', async () => {
    const { store, query, applyObservation } = fixture();
    query.mockImplementation(async sql => ({ rows: sql.includes('FOR UPDATE') ? [{
      ...row, after_id: conditionId, cycle_attempted: '1', cycle_failed: '1'
    }] : [] }));
    applyObservation.mockRejectedValueOnce(new Error('apply failed'));
    await expect(store.settleCovered({ ...state, after: conditionId, attempted: 1, failed: 1 }, null)).rejects.toThrow('apply failed');
    expect(query.mock.calls.some(([sql]) => sql.includes('cycle_failed = cycle_failed - 1'))).toBe(false);
  });
});
