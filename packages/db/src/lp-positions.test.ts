import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const clientQuery = vi.fn();
  return {
    clientQuery,
    query: vi.fn(),
    connect: vi.fn(async () => ({
      query: clientQuery,
      release: vi.fn(),
      on: vi.fn(),
      off: vi.fn()
    }))
  };
});

vi.mock('./client.js', () => ({
  query: mocks.query,
  pool: { connect: mocks.connect }
}));

import { createLpPosition, listPositionsForMonitor, transitionLpPosition } from './lp-positions.js';
import { crossTenantScope, forUser } from './tenancy.js';

const scope = forUser('11111111-1111-1111-1111-111111111111');

const positionRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'pos-1',
  user_id: scope.userId,
  chain: 'solana',
  protocol: 'meteora-dlmm',
  pool_address: 'solana:3ucNos4Nbum3ZNF6ndRiMKK4sjKbLRPmv4V7WtH2sApY',
  strategy_type: 'spot',
  range_lower: 150,
  range_upper: 190,
  rung_allocations: [
    { priceLower: 150, priceUpper: 165, weight: 0.5, binId: 100 },
    { priceLower: 165, priceUpper: 190, weight: 0.5, binId: 110 }
  ],
  deposit_amount: 1000,
  deposit_asset: 'solana:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  state: 'active',
  on_chain_position_address: null,
  opened_at: new Date('2026-10-04T00:00:00Z'),
  closed_at: null,
  updated_at: new Date('2026-10-04T00:00:00Z'),
  ...overrides
});

/**
 * The PoolClient routes by statement content: a test names the needle and the
 * rows each statement returns, and everything else (BEGIN, COMMIT, journal
 * inserts) resolves empty. `withTransaction` is real, so BEGIN/COMMIT are in
 * the statement log and a helper that forgets its transaction is visible.
 */
type ClientRoute = readonly [needle: string, rows: unknown[]];
let clientRoutes: ClientRoute[] = [];

beforeEach(() => {
  clientRoutes = [];
  mocks.query.mockReset();
  mocks.query.mockImplementation(async () => []);
  mocks.clientQuery.mockReset();
  mocks.clientQuery.mockImplementation(async (text: unknown) => {
    const sql = String(text);
    for (const [needle, rows] of clientRoutes) {
      if (sql.includes(needle)) return { rows };
    }
    return { rows: [] };
  });
});

function statementLog(): string[] {
  return mocks.clientQuery.mock.calls.map((call) => String(call[0]));
}

describe('lp-positions state machine', () => {
  it('creates a building position and journals the initial state in one transaction', async () => {
    clientRoutes.push(
      ['INSERT INTO lp_positions', [positionRow({ state: 'building' })]],
      ['lp_position_state_history', []]
    );

    const created = await createLpPosition(scope, {
      chain: 'solana',
      protocol: 'meteora-dlmm',
      poolAddress: 'solana:3ucNos4Nbum3ZNF6ndRiMKK4sjKbLRPmv4V7WtH2sApY',
      strategyType: 'spot',
      rangeLower: 150,
      rangeUpper: 190,
      rungAllocations: [
        { priceLower: 150, priceUpper: 165, weight: 0.5, binId: 100 },
        { priceLower: 165, priceUpper: 190, weight: 0.5, binId: 110 }
      ],
      depositAmount: 1000,
      depositAsset: 'solana:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
    });

    expect(created.state).toBe('building');
    expect(created.rungAllocations).toHaveLength(2);
    const log = statementLog();
    expect(log[0]).toBe('BEGIN');
    expect(log.some((statement) => statement.includes('INSERT INTO lp_positions'))).toBe(true);
    expect(log.some((statement) => statement.includes('INSERT INTO lp_position_state_history'))).toBe(true);
    expect(log.at(-1)).toBe('COMMIT');
  });

  it('rejects rungs whose weights sum above 1 before touching the database', async () => {
    await expect(
      createLpPosition(scope, {
        chain: 'solana',
        protocol: 'meteora-dlmm',
        poolAddress: 'solana:pool',
        strategyType: 'spot',
        rangeLower: 150,
        rangeUpper: 190,
        rungAllocations: [
          { priceLower: 150, priceUpper: 165, weight: 0.7 },
          { priceLower: 165, priceUpper: 190, weight: 0.7 }
        ],
        depositAmount: 1000,
        depositAsset: 'solana:usdc'
      })
    ).rejects.toThrow('at most 1');
    expect(mocks.clientQuery).not.toHaveBeenCalled();
  });

  it('refuses an unprefixed pool address', async () => {
    await expect(
      createLpPosition(scope, {
        chain: 'solana',
        protocol: 'meteora-dlmm',
        poolAddress: '3ucNos4Nbum3ZNF6ndRiMKK4sjKbLRPmv4V7WtH2sApY',
        strategyType: 'spot',
        rangeLower: 150,
        rangeUpper: 190,
        rungAllocations: [],
        depositAmount: 1000,
        depositAsset: 'solana:usdc'
      })
    ).rejects.toThrow('chain-prefixed');
  });

  it('transitions active -> closed, sets closed_at, and journals the reason', async () => {
    clientRoutes.push(
      ['FOR UPDATE', [positionRow({ state: 'active' })]],
      ['UPDATE lp_positions', [positionRow({ state: 'closed', closed_at: new Date() })]],
      ['lp_position_state_history', []]
    );

    const closed = await transitionLpPosition(scope, 'pos-1', {
      toState: 'closed',
      reason: 'user close'
    });

    expect(closed.state).toBe('closed');
    const log = statementLog();
    expect(log.some((statement) => statement.includes('FOR UPDATE'))).toBe(true);
    const update = log.find((statement) => statement.includes('UPDATE lp_positions'));
    expect(update).toContain("CASE WHEN $2 = 'closed' THEN NOW()");
    const historyCall = mocks.clientQuery.mock.calls.find(
      (call) => String(call[0]).includes('lp_position_state_history')
    );
    expect(historyCall?.[1]).toEqual(['pos-1', 'active', 'closed', 'user close']);
  });

  it('refuses a transition the machine forbids and writes nothing', async () => {
    clientRoutes.push(['FOR UPDATE', [positionRow({ state: 'closed' })]]);

    await expect(
      transitionLpPosition(scope, 'pos-1', { toState: 'active', reason: 'reopen' })
    ).rejects.toThrow('invalid lp position transition: closed -> active');

    const log = statementLog();
    expect(log.some((statement) => statement.includes('UPDATE lp_positions'))).toBe(false);
    expect(log.some((statement) => statement.includes('lp_position_state_history'))).toBe(false);
    expect(log.at(-1)).toBe('ROLLBACK');
  });

  it('requires a reason for every transition', async () => {
    await expect(
      transitionLpPosition(scope, 'pos-1', { toState: 'closed', reason: '   ' })
    ).rejects.toThrow('requires a reason');
    expect(mocks.clientQuery).not.toHaveBeenCalled();
  });

  it('the monitor sweep is a platform sweep and refuses a user scope', async () => {
    await expect(listPositionsForMonitor(scope, 'solana')).rejects.toThrow('crossTenantScope');
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('the monitor sweep reads only open, monitorable states on one chain', async () => {
    mocks.query.mockImplementation(async () => [positionRow()]);
    await listPositionsForMonitor(crossTenantScope('lp position monitor sweep'), 'solana', 100);

    const [sql, params] = mocks.query.mock.calls[0];
    expect(String(sql)).toContain("state IN ('active', 'near_edge', 'out_of_range')");
    expect(params[0]).toBe('solana');
    expect(params[1]).toBe(100);
  });
});
