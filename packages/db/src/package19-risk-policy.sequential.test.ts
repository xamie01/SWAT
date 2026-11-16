import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('./client.js', () => ({ query: mocks.query }));
import { clearRiskPolicyCache, resolveRiskPolicy } from './risk-policy.js';
import { assessMasterCapacity, usableLiquidityFromPoolTvlUsd } from './master-capacity.js';
import { isBalanceStale, resolveKnownBalanceUsd, type UserBalance } from './user-balances.js';

const now = new Date('2026-11-13T12:00:00Z');
const balance: UserBalance = {
  userId: 'user-a', chain: 'solana', asset: 'SOL', amount: 1, amountRaw: '1', decimals: 9,
  usd: 100, usdPricedAt: now, fetchedAt: now, source: 'poller'
};

beforeEach(() => { mocks.query.mockReset(); clearRiskPolicyCache(); mocks.query.mockResolvedValue([]); });
afterEach(() => clearRiskPolicyCache());

describe('package19 current policy and missing valuation', () => {
  it('rejects an explicit invalid policy rather than replacing it with defaults', async () => {
    mocks.query.mockResolvedValue([{ key: 'trading', value: { max_position_pct: 'not-a-number' } }]);
    await expect(resolveRiskPolicy('operator', 'solana')).rejects.toThrow(/risk policy/i);
  });

  it('forced refresh does not join a pre-stop in-flight query or let it repopulate cache', async () => {
    let finishOld!: (rows: Array<{ key: string; value: unknown }>) => void;
    mocks.query.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
    const old = resolveRiskPolicy('operator', 'solana');
    mocks.query.mockResolvedValueOnce([{ key: 'trading', value: { max_position_pct: 1 } }]);
    const current = resolveRiskPolicy('operator', 'solana', { forceFresh: true });
    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect((await current).maxPositionPct).toBe(1);
    finishOld([{ key: 'trading', value: { max_position_pct: 20 } }]);
    await expect(old).rejects.toThrow(/stale/i);
    expect((await resolveRiskPolicy('operator', 'solana')).maxPositionPct).toBe(1);
  });

  it('uses the supplied transaction client without cached or independent reads', async () => {
    await resolveRiskPolicy('operator', 'solana');
    const client = { query: vi.fn().mockResolvedValue({ rows: [{ key: 'trading', value: { max_position_pct: 2 } }] }) } as unknown as PoolClient;
    expect((await resolveRiskPolicy('operator', 'solana', { client })).maxPositionPct).toBe(2);
    expect(client.query).toHaveBeenCalledOnce();
    expect(mocks.query).toHaveBeenCalledOnce();
  });

  it.each([new Date('invalid'), new Date(now.getTime() + 1)])('rejects invalid/future observations %s', fetchedAt => {
    expect(isBalanceStale({ fetchedAt }, now)).toBe(true);
  });

  it.each([null, new Date('invalid'), new Date(now.getTime() - 60_001), new Date(now.getTime() + 1)])(
    'fresh balance with missing/stale USD pricing %s does not fund new spend', usdPricedAt => {
      expect(resolveKnownBalanceUsd([{ ...balance, usdPricedAt }], now)).toBeNull();
    }
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])('rejects unassessable USD %s', usd => {
    expect(resolveKnownBalanceUsd([{ ...balance, usd }], now)).toBeNull();
  });

  it.each(['partial-unpriced-legs', 'unavailable'] as const)('never admits %s liabilities', coverage => {
    const decision = assessMasterCapacity({
      masterWalletAddress: 'solana:MASTER', chain: 'solana', tokenMint: 'solana:TOKEN',
      windowMs: 300_000, windowEndsAt: now,
      observation: { committedNotionalUsd: coverage === 'unavailable' ? null : 1, projectedNotionalUsd: 1, coverage, unpricedLegCount: 1 },
      liquidity: usableLiquidityFromPoolTvlUsd('solana', 'solana:TOKEN', 200_000),
      activeFollowerCount: 1, policy: { unassessablePolicy: 'admit' }
    });
    expect(decision.outcome).toBe('skip');
    expect(decision.reasonCode).toBe('capacity-not-assessable');
  });
});
