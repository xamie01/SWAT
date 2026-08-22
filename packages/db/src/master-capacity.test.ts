import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SLIPPAGE_BPS } from '@swat/shared';

const mocks = vi.hoisted(() => ({
  query: vi.fn()
}));

vi.mock('./client.js', () => ({
  query: mocks.query
}));

import {
  AGGREGATE_IMPACT_SHARE_OF_SLIPPAGE,
  CAPACITY_USER_MESSAGE,
  DEFAULT_FOLLOWER_SOFT_CAP,
  MASTER_CAPACITY_WINDOWS,
  MasterCapacityInputError,
  PLATFORM_MAX_AGGREGATE_IMPACT_BPS,
  allocateMasterBudget,
  assertNoPerUserCapacityInput,
  assessMasterCapacity,
  capacityNotionalUsd,
  fetchMasterCapacityPolicy,
  fetchMasterWindowNotional,
  priceImpactBps,
  recordMasterCapacityLedgerEntry,
  unknownLiquidity,
  usableLiquidityFromPoolTvlUsd
} from './master-capacity.js';
import type { MasterCapacityInput, UsableLiquidity } from './master-capacity.js';

const WINDOW_END = new Date('2026-08-22T12:00:00.000Z');

/** A deep pair: $200k TVL, so $100k of one-sided usable liquidity. */
function deepLiquidity(): UsableLiquidity {
  return usableLiquidityFromPoolTvlUsd('solana', 'solana:TOKEN', 200_000);
}

function input(overrides: Partial<MasterCapacityInput> = {}): MasterCapacityInput {
  return {
    masterWalletAddress: 'solana:MASTER',
    chain: 'solana',
    tokenMint: 'solana:TOKEN',
    windowMs: MASTER_CAPACITY_WINDOWS.fanoutDrainMs,
    windowEndsAt: WINDOW_END,
    observation: {
      committedNotionalUsd: 0,
      projectedNotionalUsd: 1_000,
      coverage: 'accounted'
    },
    liquidity: deepLiquidity(),
    activeFollowerCount: 10,
    policy: { unassessablePolicy: 'skip' },
    ...overrides
  };
}

describe('priceImpactBps', () => {
  it('is notional over the one-sided reserve, in bps', () => {
    // Constant product: average execution price / spot = 1 + dx/x exactly.
    expect(priceImpactBps(1_000, 100_000)).toBe(100);
    expect(priceImpactBps(500, 100_000)).toBe(50);
    expect(priceImpactBps(0, 100_000)).toBe(0);
  });

  it('refuses a non-positive or non-finite reserve rather than dividing by it', () => {
    expect(() => priceImpactBps(100, 0)).toThrow(MasterCapacityInputError);
    expect(() => priceImpactBps(100, -1)).toThrow(MasterCapacityInputError);
    expect(() => priceImpactBps(100, Number.NaN)).toThrow(MasterCapacityInputError);
  });

  it('refuses a negative notional', () => {
    expect(() => priceImpactBps(-1, 100_000)).toThrow(MasterCapacityInputError);
  });

  it('round-trips through capacityNotionalUsd', () => {
    const cap = capacityNotionalUsd(100_000, 250);
    expect(cap).toBe(2_500);
    expect(priceImpactBps(cap, 100_000)).toBe(250);
  });
});

describe('usableLiquidityFromPoolTvlUsd', () => {
  it('halves a both-sided TVL and marks the figure approximate', () => {
    const liquidity = usableLiquidityFromPoolTvlUsd('solana', 'solana:TOKEN', 200_000);
    expect(liquidity.usableLiquidityUsd).toBe(100_000);
    expect(liquidity.basis).toBe('amm-pool-tvl');
    expect(liquidity.approximate).toBe(true);
  });

  it('reports a missing, zero or non-finite TVL as unknown and never as zero', () => {
    for (const tvl of [null, 0, Number.NaN, -5]) {
      const liquidity = usableLiquidityFromPoolTvlUsd('solana', 'solana:TOKEN', tvl);
      expect(liquidity.basis).toBe('unknown');
      expect(liquidity.usableLiquidityUsd).toBeNull();
    }
  });
});

describe('platform limits', () => {
  it('derives the impact ceiling from the chain default slippage tolerance', () => {
    for (const chain of ['solana', 'polygon', 'robinhood-chain'] as const) {
      expect(PLATFORM_MAX_AGGREGATE_IMPACT_BPS[chain]).toBe(
        Math.floor(DEFAULT_SLIPPAGE_BPS[chain] * AGGREGATE_IMPACT_SHARE_OF_SLIPPAGE)
      );
      expect(PLATFORM_MAX_AGGREGATE_IMPACT_BPS[chain]).toBeLessThan(DEFAULT_SLIPPAGE_BPS[chain]);
    }
  });

  it('is a real number on every chain, so no chain ships with the cap disabled', () => {
    for (const value of Object.values(PLATFORM_MAX_AGGREGATE_IMPACT_BPS)) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
  });
});

describe('assessMasterCapacity — primary price-impact cap', () => {
  it('admits flow well under the ceiling and reports nothing unassessed', () => {
    const decision = assessMasterCapacity(input());
    expect(decision.outcome).toBe('admit');
    expect(decision.reasonCode).toBe('capacity-within-limits');
    expect(decision.binding).toEqual([]);
    expect(decision.unassessed).toEqual([]);
    expect(decision.user.message).toBeNull();
    expect(decision.internal.priceImpact?.totalImpactBps).toBe(100);
    expect(decision.internal.priceImpact?.capBps).toBe(500);
  });

  it('skips when committed plus projected exceeds the ceiling', () => {
    const decision = assessMasterCapacity(
      input({
        observation: {
          committedNotionalUsd: 45_000,
          projectedNotionalUsd: 10_000,
          coverage: 'accounted'
        }
      })
    );
    expect(decision.outcome).toBe('skip');
    expect(decision.reasonCode).toBe('capacity-price-impact-cap-reached');
    expect(decision.binding).toContain('aggregate-price-impact');
    expect(decision.internal.priceImpact?.totalImpactBps).toBe(5_500);
  });

  it('admits at exactly the ceiling and skips one dollar past it', () => {
    // 500 bps of $100,000 usable liquidity is $5,000 of notional.
    const at = assessMasterCapacity(
      input({
        observation: { committedNotionalUsd: 0, projectedNotionalUsd: 5_000, coverage: 'accounted' }
      })
    );
    expect(at.outcome).toBe('admit');
    const past = assessMasterCapacity(
      input({
        observation: { committedNotionalUsd: 0, projectedNotionalUsd: 5_001, coverage: 'accounted' }
      })
    );
    expect(past.outcome).toBe('skip');
  });

  it('counts already-committed flow, so the cohort cannot re-spend its own headroom', () => {
    const decision = assessMasterCapacity(
      input({
        observation: {
          committedNotionalUsd: 4_900,
          projectedNotionalUsd: 200,
          coverage: 'accounted'
        }
      })
    );
    expect(decision.outcome).toBe('skip');
    expect(decision.internal.priceImpact?.headroomUsd).toBeCloseTo(100, 6);
  });

  it('uses the per-chain ceiling, so the same flow can pass on solana and fail on polygon', () => {
    const observation = {
      committedNotionalUsd: 0,
      projectedNotionalUsd: 2_000,
      coverage: 'accounted' as const
    };
    const solana = assessMasterCapacity(input({ observation }));
    const polygon = assessMasterCapacity(
      input({
        chain: 'polygon',
        masterWalletAddress: 'polygon:0xmaster',
        tokenMint: 'polygon:0xtoken',
        liquidity: usableLiquidityFromPoolTvlUsd('polygon', 'polygon:0xtoken', 200_000),
        observation
      })
    );
    expect(solana.outcome).toBe('admit');
    expect(polygon.outcome).toBe('skip');
  });

  it('honours a per-master ceiling override', () => {
    const decision = assessMasterCapacity(
      input({ policy: { unassessablePolicy: 'skip', maxAggregateImpactBps: 50 } })
    );
    expect(decision.outcome).toBe('skip');
    expect(decision.internal.priceImpact?.capBps).toBe(50);
  });
});

describe('assessMasterCapacity — crude follower soft-cap', () => {
  it('binds independently of the impact cap', () => {
    const decision = assessMasterCapacity(input({ activeFollowerCount: 51 }));
    expect(decision.outcome).toBe('skip');
    expect(decision.reasonCode).toBe('capacity-follower-soft-cap-reached');
    expect(decision.binding).toEqual(['follower-soft-cap']);
    expect(decision.internal.priceImpact?.totalImpactBps).toBe(100);
    expect(decision.internal.followerSoftCap).toEqual({
      activeFollowerCount: 51,
      softCap: DEFAULT_FOLLOWER_SOFT_CAP,
      crude: true
    });
  });

  it('reports both layers when both bind, and the primary code wins', () => {
    const decision = assessMasterCapacity(
      input({
        activeFollowerCount: 500,
        observation: {
          committedNotionalUsd: 0,
          projectedNotionalUsd: 50_000,
          coverage: 'accounted'
        }
      })
    );
    expect(decision.reasonCode).toBe('capacity-price-impact-cap-reached');
    expect(decision.binding).toEqual(['aggregate-price-impact', 'follower-soft-cap']);
  });

  it('is the only live cap when liquidity is unknown and the caller admits', () => {
    const decision = assessMasterCapacity(
      input({
        liquidity: unknownLiquidity('solana', 'solana:TOKEN', 'no pair'),
        activeFollowerCount: 51,
        policy: { unassessablePolicy: 'admit' }
      })
    );
    expect(decision.outcome).toBe('skip');
    expect(decision.reasonCode).toBe('capacity-follower-soft-cap-reached');
  });

  it('treats an unknown follower count as unassessed, never as zero', () => {
    const decision = assessMasterCapacity(input({ activeFollowerCount: null }));
    expect(decision.outcome).toBe('admit');
    expect(decision.internal.followerSoftCap).toBeNull();
    expect(decision.unassessed.map((entry) => entry.reason)).toEqual(['follower-count-unknown']);
  });

  it('honours a per-master soft-cap override', () => {
    const decision = assessMasterCapacity(
      input({ activeFollowerCount: 6, policy: { unassessablePolicy: 'skip', followerSoftCap: 5 } })
    );
    expect(decision.reasonCode).toBe('capacity-follower-soft-cap-reached');
  });
});

describe('assessMasterCapacity — unassessable primary', () => {
  it('fails closed with its own code when the caller declared skip', () => {
    const decision = assessMasterCapacity(
      input({ liquidity: unknownLiquidity('solana', 'solana:TOKEN', 'DexScreener returned null') })
    );
    expect(decision.outcome).toBe('skip');
    expect(decision.reasonCode).toBe('capacity-not-assessable');
    expect(decision.binding).toContain('unassessable-primary');
    expect(decision.unassessed.map((entry) => entry.reason)).toContain('liquidity-unknown');
    expect(decision.internal.priceImpact).toBeNull();
  });

  it('fails open with a distinct code when the caller declared admit', () => {
    const decision = assessMasterCapacity(
      input({
        liquidity: unknownLiquidity('polygon', 'polygon:0xtoken', 'no pre-fan-out book read'),
        policy: { unassessablePolicy: 'admit' }
      })
    );
    expect(decision.outcome).toBe('admit');
    expect(decision.reasonCode).toBe('capacity-admitted-unassessed');
    // An admit under partial information is never reportable as a clean pass.
    expect(decision.reasonCode).not.toBe('capacity-within-limits');
    expect(decision.unassessed.length).toBeGreaterThan(0);
  });

  it('distinguishes a missing feed from an unknown figure', () => {
    const decision = assessMasterCapacity(
      input({
        liquidity: {
          chain: 'polygon',
          tokenMint: 'polygon:0xtoken',
          usableLiquidityUsd: null,
          basis: 'order-book-depth',
          approximate: false,
          note: 'Polymarket book is only read inside the executor at submission time.'
        }
      })
    );
    expect(decision.unassessed.map((entry) => entry.reason)).toContain('liquidity-feed-missing');
  });

  it('treats unavailable notional accounting as unassessable, not as zero flow', () => {
    const decision = assessMasterCapacity(
      input({
        observation: {
          committedNotionalUsd: null,
          projectedNotionalUsd: 1_000,
          coverage: 'unavailable'
        }
      })
    );
    expect(decision.outcome).toBe('skip');
    expect(decision.reasonCode).toBe('capacity-not-assessable');
    expect(decision.unassessed.map((entry) => entry.reason)).toContain(
      'copy-notional-unaccounted'
    );
  });

  it('records a partial notional sum as a lower bound even when it admits', () => {
    const decision = assessMasterCapacity(
      input({
        observation: {
          committedNotionalUsd: 1_000,
          projectedNotionalUsd: 100,
          coverage: 'partial-unpriced-legs',
          unpricedLegCount: 3
        }
      })
    );
    expect(decision.outcome).toBe('admit');
    expect(decision.unassessed.map((entry) => entry.reason)).toContain('copy-notional-partial');
    expect(decision.internal.priceImpact?.lowerBound).toBe(true);
  });
});

describe('assessMasterCapacity — uniform skip', () => {
  it('refuses an input carrying per-user or per-tier data', () => {
    const forbidden = [
      { userId: 'u1' },
      { userTier: 'pro' },
      { targetAccount: 'solana:FOLLOWER' },
      { policy: { unassessablePolicy: 'skip', subscriberPriority: 3 } },
      { observation: { committedNotionalUsd: 0, projectedNotionalUsd: 1, coverage: 'accounted', perUserSplit: [1] } }
    ];
    for (const extra of forbidden) {
      expect(() =>
        assessMasterCapacity({ ...input(), ...extra } as unknown as MasterCapacityInput)
      ).toThrow(MasterCapacityInputError);
    }
  });

  it('catches per-user keys nested inside arrays', () => {
    expect(() =>
      assertNoPerUserCapacityInput({ cohort: [{ ok: 1 }, { tierName: 'gold' }] })
    ).toThrow(/per-user data/);
  });

  it('does not mistake the master wallet for per-user data', () => {
    expect(() => assertNoPerUserCapacityInput(input())).not.toThrow();
  });

  it('refuses an input nested deeper than it can inspect', () => {
    let nested: Record<string, unknown> = { leaf: 1 };
    for (let index = 0; index < 12; index += 1) nested = { level: nested };
    expect(() => assertNoPerUserCapacityInput(nested)).toThrow(/deeper than/);
  });

  it('returns an identical decision for repeated calls with the same master and token', () => {
    // There is no per-user input to vary, so this is the strongest available
    // statement that every user in the cohort receives the same answer.
    const first = assessMasterCapacity(input({ activeFollowerCount: 900 }));
    const second = assessMasterCapacity(input({ activeFollowerCount: 900 }));
    expect(second).toEqual(first);
    expect(first.outcome).toBe('skip');
  });
});

describe('assessMasterCapacity — the two messages', () => {
  it('returns the generic user string and the specific internal code together', () => {
    const decision = assessMasterCapacity(
      input({
        observation: {
          committedNotionalUsd: 0,
          projectedNotionalUsd: 90_000,
          coverage: 'accounted'
        }
      })
    );
    expect(decision.user.message).toBe(CAPACITY_USER_MESSAGE);
    expect(decision.internal.code).toBe('capacity-price-impact-cap-reached');
    expect(decision.internal.detail).toMatch(/bps/);
  });

  it('shows the same user string whichever layer bound, so the cause cannot be inferred', () => {
    const byImpact = assessMasterCapacity(
      input({
        observation: { committedNotionalUsd: 0, projectedNotionalUsd: 90_000, coverage: 'accounted' }
      })
    );
    const byFollowers = assessMasterCapacity(input({ activeFollowerCount: 5_000 }));
    const byUnassessable = assessMasterCapacity(
      input({ liquidity: unknownLiquidity('solana', 'solana:TOKEN', 'no pair') })
    );
    expect(byFollowers.user.message).toBe(byImpact.user.message);
    expect(byUnassessable.user.message).toBe(byImpact.user.message);
    expect(byFollowers.internal.code).not.toBe(byImpact.internal.code);
    expect(byUnassessable.internal.code).not.toBe(byImpact.internal.code);
  });

  it('never leaks a figure or a follower count to the user (S4-M9)', () => {
    const decision = assessMasterCapacity(input({ activeFollowerCount: 873 }));
    const userFacing = JSON.stringify(decision.user);
    expect(userFacing).not.toMatch(/\d/);
    expect(userFacing).not.toMatch(/follower/i);
    expect(userFacing).not.toMatch(/liquidity/i);
    expect(userFacing).not.toMatch(/impact/i);
    expect(userFacing).not.toMatch(/bps/i);
    expect(userFacing).not.toMatch(/quota/i);
    expect(CAPACITY_USER_MESSAGE).not.toMatch(/\d/);
  });

  it('says nothing to the user on an admit', () => {
    expect(assessMasterCapacity(input()).user.message).toBeNull();
  });
});

describe('assessMasterCapacity — incoherent inputs fail loud', () => {
  it('rejects a non-positive window', () => {
    expect(() => assessMasterCapacity(input({ windowMs: 0 }))).toThrow(MasterCapacityInputError);
    expect(() => assessMasterCapacity(input({ windowMs: -1 }))).toThrow(MasterCapacityInputError);
  });

  it('rejects an invalid window end', () => {
    expect(() => assessMasterCapacity(input({ windowEndsAt: new Date('nope') }))).toThrow(
      MasterCapacityInputError
    );
  });

  it('rejects a negative projected notional', () => {
    expect(() =>
      assessMasterCapacity(
        input({
          observation: {
            committedNotionalUsd: 0,
            projectedNotionalUsd: -1,
            coverage: 'accounted'
          }
        })
      )
    ).toThrow(MasterCapacityInputError);
  });

  it('rejects a fractional follower count rather than rounding it', () => {
    expect(() => assessMasterCapacity(input({ activeFollowerCount: 2.5 }))).toThrow(
      MasterCapacityInputError
    );
  });

  it('rejects a non-integer or non-positive soft cap', () => {
    expect(() =>
      assessMasterCapacity(input({ policy: { unassessablePolicy: 'skip', followerSoftCap: 0 } }))
    ).toThrow(MasterCapacityInputError);
    expect(() =>
      assessMasterCapacity(input({ policy: { unassessablePolicy: 'skip', followerSoftCap: 1.5 } }))
    ).toThrow(MasterCapacityInputError);
  });

  it('derives the window start from the injected end, never from a clock', () => {
    const decision = assessMasterCapacity(input({ windowMs: 60_000 }));
    expect(decision.internal.windowStartsAt.toISOString()).toBe('2026-08-22T11:59:00.000Z');
    expect(decision.internal.windowEndsAt).toBe(WINDOW_END);
  });
});

describe('allocateMasterBudget', () => {
  it('splits the budget equally when no master has an explicit share', () => {
    expect(allocateMasterBudget({ dailyBudgetOperations: 1_000, activeMasterCount: 4 })).toEqual({
      equalShareOperations: 250,
      explicitOperations: 0,
      equalShareMasterCount: 4,
      oversubscribed: false
    });
  });

  it('reserves explicit shares before splitting the remainder', () => {
    const allocation = allocateMasterBudget({
      dailyBudgetOperations: 1_000,
      activeMasterCount: 5,
      explicitSharesBps: { 'solana:WHALE': 5_000 }
    });
    expect(allocation.explicitOperations).toBe(500);
    expect(allocation.equalShareMasterCount).toBe(4);
    expect(allocation.equalShareOperations).toBe(125);
  });

  it('reports oversubscription instead of clamping it away', () => {
    const allocation = allocateMasterBudget({
      dailyBudgetOperations: 1_000,
      activeMasterCount: 2,
      explicitSharesBps: { a: 8_000, b: 6_000 }
    });
    expect(allocation.oversubscribed).toBe(true);
    expect(allocation.equalShareOperations).toBe(0);
  });

  it('does not divide by zero when every master has an explicit share', () => {
    const allocation = allocateMasterBudget({
      dailyBudgetOperations: 1_000,
      activeMasterCount: 1,
      explicitSharesBps: { a: 10_000 }
    });
    expect(allocation.equalShareOperations).toBe(0);
    expect(allocation.equalShareMasterCount).toBe(0);
  });

  it('rejects a share outside 0-10000 bps', () => {
    expect(() =>
      allocateMasterBudget({
        dailyBudgetOperations: 1_000,
        activeMasterCount: 1,
        explicitSharesBps: { a: 10_001 }
      })
    ).toThrow(MasterCapacityInputError);
  });
});

describe('DB seams (mocked client)', () => {
  beforeEach(() => {
    mocks.query.mockReset();
  });

  it('reports a window with unpriced legs as partial rather than accounted', async () => {
    mocks.query.mockResolvedValueOnce([
      { committed_notional_usd: '4200.5', priced_leg_count: '7', unpriced_leg_count: '2' }
    ]);
    const observation = await fetchMasterWindowNotional({
      masterWalletAddress: 'solana:MASTER',
      chain: 'solana',
      tokenMint: 'solana:TOKEN',
      windowStartsAt: new Date('2026-08-22T11:55:00.000Z'),
      windowEndsAt: WINDOW_END,
      executionModes: ['live']
    });
    expect(observation).toEqual({
      committedNotionalUsd: 4_200.5,
      projectedNotionalUsd: 0,
      coverage: 'partial-unpriced-legs',
      unpricedLegCount: 2
    });
  });

  it('reports an entirely priced window as accounted', async () => {
    mocks.query.mockResolvedValueOnce([
      { committed_notional_usd: '0', priced_leg_count: '0', unpriced_leg_count: '0' }
    ]);
    const observation = await fetchMasterWindowNotional({
      masterWalletAddress: 'solana:MASTER',
      chain: 'solana',
      tokenMint: 'solana:TOKEN',
      windowStartsAt: new Date('2026-08-22T11:55:00.000Z'),
      windowEndsAt: WINDOW_END,
      executionModes: ['live']
    });
    expect(observation.coverage).toBe('accounted');
    expect(observation.committedNotionalUsd).toBe(0);
  });

  it('reports an absent aggregate row as unavailable, not as zero', async () => {
    mocks.query.mockResolvedValueOnce([]);
    const observation = await fetchMasterWindowNotional({
      masterWalletAddress: 'solana:MASTER',
      chain: 'solana',
      tokenMint: 'solana:TOKEN',
      windowStartsAt: new Date('2026-08-22T11:55:00.000Z'),
      windowEndsAt: WINDOW_END,
      executionModes: ['live']
    });
    expect(observation.coverage).toBe('unavailable');
    expect(observation.committedNotionalUsd).toBeNull();
  });

  it('filters the window sum to the execution modes the caller named', async () => {
    mocks.query.mockResolvedValueOnce([
      { committed_notional_usd: '10', priced_leg_count: '1', unpriced_leg_count: '0' }
    ]);
    await fetchMasterWindowNotional({
      masterWalletAddress: 'solana:MASTER',
      chain: 'solana',
      tokenMint: 'solana:TOKEN',
      windowStartsAt: new Date('2026-08-22T11:55:00.000Z'),
      windowEndsAt: WINDOW_END,
      executionModes: ['live']
    });
    const [sql, params] = mocks.query.mock.calls[0] as [string, unknown[]];
    // Paper and shadow copies never reach a venue, so counting them would skip
    // live users over volume that never existed.
    expect(sql).toMatch(/execution_mode = ANY\(\$6\)/);
    expect(params[5]).toEqual(['live']);
  });

  it('refuses an empty execution-mode list rather than reporting zero flow', async () => {
    await expect(
      fetchMasterWindowNotional({
        masterWalletAddress: 'solana:MASTER',
        chain: 'solana',
        tokenMint: 'solana:TOKEN',
        windowStartsAt: new Date('2026-08-22T11:55:00.000Z'),
        windowEndsAt: WINDOW_END,
        executionModes: []
      })
    ).rejects.toBeInstanceOf(MasterCapacityInputError);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('writes a ledger entry idempotently per source trade and mode', async () => {
    mocks.query.mockResolvedValueOnce([]);
    await recordMasterCapacityLedgerEntry({
      masterWalletAddress: 'solana:MASTER',
      chain: 'solana',
      tokenMint: 'solana:TOKEN',
      sourceTradeId: '00000000-0000-0000-0000-000000000001',
      executionMode: 'paper',
      notionalUsd: 1_500,
      notionalBasis: 'quote-stablecoin',
      committedAt: WINDOW_END
    });
    const [sql] = mocks.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/ON CONFLICT \(source_trade_id, execution_mode\) DO NOTHING/);
    expect(sql).not.toMatch(/user_id/);
  });

  it('turns an absent policy row into platform defaults rather than nulls', async () => {
    mocks.query.mockResolvedValueOnce([]);
    const result = await fetchMasterCapacityPolicy({
      masterWalletAddress: 'solana:MASTER',
      chain: 'solana'
    });
    expect(result.policy).toEqual({
      maxAggregateImpactBps: undefined,
      followerSoftCap: undefined
    });
    expect(result.dailyBudgetShareBps).toBeNull();
  });

  it('passes per-master overrides through unchanged', async () => {
    mocks.query.mockResolvedValueOnce([
      { max_aggregate_impact_bps: 75, follower_soft_cap: 20, daily_budget_share_bps: 1_200 }
    ]);
    const result = await fetchMasterCapacityPolicy({
      masterWalletAddress: 'solana:MASTER',
      chain: 'solana'
    });
    expect(result.policy).toEqual({ maxAggregateImpactBps: 75, followerSoftCap: 20 });
    expect(result.dailyBudgetShareBps).toBe(1_200);
  });
});
