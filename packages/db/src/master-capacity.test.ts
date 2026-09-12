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
  usableLiquidityFromPoolTvlUsd,
  accrueMasterCapacityFillNotional,
  decideCapacityFillAccrual,
  mergePricedBasis,
  pricedBasisForQuoteCurrency,
  subtractDecimalText
} from './master-capacity.js';
import type {
  CapacityFillAccrualInput,
  MasterCapacityInput,
  UsableLiquidity
} from './master-capacity.js';

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

// ═══════════════════════════════════════════════════════════════════════════
// The priced numerator (S4-M6)
// ═══════════════════════════════════════════════════════════════════════════

describe('subtractDecimalText', () => {
  it('subtracts exactly, without binary floating point drift', () => {
    // 0.3 - 0.1 is 0.19999999999999998 in JS. A numerator assembled from
    // hundreds of those drifts against the NUMERIC column it mirrors.
    expect(subtractDecimalText('0.3', '0.1')).toBe('0.2');
    expect(subtractDecimalText('1500.75', '1000.25')).toBe('500.5');
    expect(subtractDecimalText('0.000000001', '0')).toBe('0.000000001');
  });

  it('returns a signed result rather than clamping a negative difference', () => {
    expect(subtractDecimalText('10', '25')).toBe('-15');
  });

  it('is zero, not negative zero, when the two figures are equal', () => {
    expect(subtractDecimalText('150.00', '150')).toBe('0');
    expect(subtractDecimalText('0', '0')).toBe('0');
  });

  it('rejects an unparseable or negative input rather than guessing', () => {
    expect(subtractDecimalText('abc', '1')).toBeNull();
    expect(subtractDecimalText('', '1')).toBeNull();
    expect(subtractDecimalText('-5', '1')).toBeNull();
    expect(subtractDecimalText(null, '1')).toBeNull();
  });
});

describe('pricedBasisForQuoteCurrency', () => {
  it('calls a USD-settled fill quote-stablecoin', () => {
    // Polymarket settles in USDC/pUSD, treated 1:1, and paper sizes in USD.
    expect(pricedBasisForQuoteCurrency('USD')).toBe('quote-stablecoin');
  });

  it('calls a SOL or ETH settled fill marked-to-price, because a rate was applied', () => {
    expect(pricedBasisForQuoteCurrency('SOL')).toBe('marked-to-price');
    expect(pricedBasisForQuoteCurrency('ETH')).toBe('marked-to-price');
  });

  it('returns null for an unknown currency rather than defaulting a basis', () => {
    expect(pricedBasisForQuoteCurrency(null)).toBeNull();
    expect(pricedBasisForQuoteCurrency(undefined)).toBeNull();
  });
});

describe('mergePricedBasis', () => {
  it('takes the incoming basis over an unpriced row', () => {
    expect(mergePricedBasis('unpriced', 'quote-stablecoin')).toBe('quote-stablecoin');
    expect(mergePricedBasis(null, 'marked-to-price')).toBe('marked-to-price');
  });

  it('keeps the basis when it already matches', () => {
    expect(mergePricedBasis('quote-stablecoin', 'quote-stablecoin')).toBe('quote-stablecoin');
  });

  it('degrades a mixed row to marked-to-price, never upgrades it to quote-stablecoin', () => {
    // A sum containing a rate-converted leg is only as trustworthy as the rate.
    expect(mergePricedBasis('quote-stablecoin', 'marked-to-price')).toBe('marked-to-price');
    expect(mergePricedBasis('marked-to-price', 'quote-stablecoin')).toBe('marked-to-price');
  });
});

function accrual(
  overrides: Partial<CapacityFillAccrualInput> = {}
): CapacityFillAccrualInput {
  return {
    sourceTradeId: '00000000-0000-0000-0000-000000000001',
    executionMode: 'live',
    quoteCurrency: 'USD',
    confirmedQuoteUsdBefore: null,
    confirmedQuoteUsdAfter: '150',
    ...overrides
  };
}

describe('decideCapacityFillAccrual', () => {
  it('accrues the increment between the cumulative totals, with a basis', () => {
    const decision = decideCapacityFillAccrual(
      accrual({ confirmedQuoteUsdBefore: '100', confirmedQuoteUsdAfter: '250.5' })
    );
    expect(decision.code).toBe('accrue');
    expect(decision.deltaUsd).toBe('150.5');
    expect(decision.notionalBasis).toBe('quote-stablecoin');
  });

  it('accrues the whole total on the first priced fill, when nothing was valued before', () => {
    const decision = decideCapacityFillAccrual(accrual({ confirmedQuoteUsdBefore: null }));
    expect(decision.code).toBe('accrue');
    expect(decision.deltaUsd).toBe('150');
  });

  it('accrues only the increment on a second partial fill, never the whole total again', () => {
    // The reason the input is a cumulative pair rather than a per-fill amount:
    // a per-fill amount would count the first partial twice.
    const decision = decideCapacityFillAccrual(
      accrual({ confirmedQuoteUsdBefore: '150', confirmedQuoteUsdAfter: '400' })
    );
    expect(decision.deltaUsd).toBe('250');
  });

  it('is a no-op when the cumulative total did not move, so a retry cannot double-count', () => {
    // The self-correcting half of the caller's idempotency contract: a BullMQ
    // retry re-presents the same evidence row, whose insert is ON CONFLICT DO
    // NOTHING, so the total is unchanged and the delta is zero by arithmetic.
    const decision = decideCapacityFillAccrual(
      accrual({ confirmedQuoteUsdBefore: '150', confirmedQuoteUsdAfter: '150' })
    );
    expect(decision.code).toBe('no-new-usd');
    expect(decision.deltaUsd).toBeNull();
  });

  it('never accrues a zero when nothing about the fill is valued in USD', () => {
    // A zero would read as "this cohort spent nothing" and turn the window from a
    // declared lower bound into a complete sum that is neither.
    const decision = decideCapacityFillAccrual(
      accrual({ confirmedQuoteUsdBefore: null, confirmedQuoteUsdAfter: null, quoteCurrency: null })
    );
    expect(decision.code).toBe('fill-value-unknown');
    expect(decision.deltaUsd).toBeNull();
    expect(decision.notionalBasis).toBeNull();
  });

  it('leaves the row unpriced when a USD figure moved but no settlement currency was reported', () => {
    const decision = decideCapacityFillAccrual(
      accrual({ confirmedQuoteUsdBefore: '10', confirmedQuoteUsdAfter: '60', quoteCurrency: null })
    );
    expect(decision.code).toBe('fill-value-unknown');
    expect(decision.deltaUsd).toBeNull();
  });

  it('refuses a negative delta rather than subtracting it below zero', () => {
    const decision = decideCapacityFillAccrual(
      accrual({ confirmedQuoteUsdBefore: '400', confirmedQuoteUsdAfter: '150' })
    );
    expect(decision.code).toBe('refuse-reversed-fill');
    expect(decision.deltaUsd).toBeNull();
  });

  it('refuses a total that became unknown after being valued', () => {
    const decision = decideCapacityFillAccrual(
      accrual({ confirmedQuoteUsdBefore: '400', confirmedQuoteUsdAfter: null })
    );
    expect(decision.code).toBe('refuse-reversed-fill');
  });

  it('marks a SOL-settled fill marked-to-price, so the per-chain basis is not one constant', () => {
    const decision = decideCapacityFillAccrual(accrual({ quoteCurrency: 'SOL' }));
    expect(decision.notionalBasis).toBe('marked-to-price');
  });

  it('refuses per-user data in the accrual input, so this write cannot introduce a user dimension', () => {
    expect(() =>
      decideCapacityFillAccrual({
        ...accrual(),
        // @ts-expect-error deliberately widening the type the way a future change might
        targetAccount: 'solana:USERWALLET'
      })
    ).toThrow(MasterCapacityInputError);
  });

  it('rejects an unparseable cumulative figure loudly instead of treating it as unknown', () => {
    expect(() =>
      decideCapacityFillAccrual(accrual({ confirmedQuoteUsdAfter: 'not-a-number' }))
    ).toThrow(MasterCapacityInputError);
    expect(() =>
      decideCapacityFillAccrual(accrual({ confirmedQuoteUsdBefore: '-5' }))
    ).toThrow(MasterCapacityInputError);
  });

  it('rejects an execution mode 053 would not admit', () => {
    expect(() =>
      // @ts-expect-error `off` is an ExecutionMode but not a ledger mode
      decideCapacityFillAccrual(accrual({ executionMode: 'off' }))
    ).toThrow(MasterCapacityInputError);
  });
});

describe('accrueMasterCapacityFillNotional (mocked client)', () => {
  beforeEach(() => {
    mocks.query.mockReset();
  });

  it('accumulates onto the existing cohort row instead of inserting a second one', async () => {
    // The unique key is (source_trade_id, execution_mode) and the row is
    // cohort-level. A per-fill INSERT would collide, DO NOTHING would keep the
    // first row, and the first confirmed user's fill would masquerade as the
    // whole cohort's notional.
    mocks.query.mockResolvedValueOnce([
      { notional_usd: '150', notional_basis: 'quote-stablecoin' }
    ]);
    const result = await accrueMasterCapacityFillNotional(accrual());
    const [sql, params] = mocks.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/^UPDATE master_capacity_ledger/);
    expect(sql).not.toMatch(/INSERT/i);
    expect(sql).toMatch(/COALESCE\(notional_usd, 0\) \+ \$1::numeric/);
    expect(sql).toMatch(/WHERE source_trade_id = \$3::uuid\s+AND execution_mode = \$4/);
    expect(params).toEqual([
      '150',
      'quote-stablecoin',
      '00000000-0000-0000-0000-000000000001',
      'live'
    ]);
    expect(result.applied).toBe(true);
    expect(result.notionalUsd).toBe('150');
  });

  it('sets notional_usd and notional_basis in one statement, because 053 couples them', async () => {
    // chk_master_capacity_ledger_basis is
    //   (notional_basis = 'unpriced') = (notional_usd IS NULL)
    // and a CHECK is evaluated per row per statement, so a two-statement version
    // fails on whichever half runs first.
    mocks.query.mockResolvedValueOnce([
      { notional_usd: '150', notional_basis: 'quote-stablecoin' }
    ]);
    await accrueMasterCapacityFillNotional(accrual());
    expect(mocks.query).toHaveBeenCalledTimes(1);
    const [sql] = mocks.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/SET notional_usd =[\s\S]*notional_basis = CASE/);
    expect(sql.match(/UPDATE master_capacity_ledger/g)).toHaveLength(1);
  });

  it('carries no user dimension into the ledger write', async () => {
    mocks.query.mockResolvedValueOnce([
      { notional_usd: '150', notional_basis: 'quote-stablecoin' }
    ]);
    await accrueMasterCapacityFillNotional(accrual());
    const [sql] = mocks.query.mock.calls[0] as [string, unknown[]];
    expect(sql).not.toMatch(/user_id|target_account/);
  });

  it('issues no statement at all when the fill USD value is unknown', async () => {
    const result = await accrueMasterCapacityFillNotional(
      accrual({ confirmedQuoteUsdAfter: null, quoteCurrency: null })
    );
    expect(result.applied).toBe(false);
    expect(result.code).toBe('fill-value-unknown');
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('issues no statement when a retry re-presents an already-accrued fill', async () => {
    const result = await accrueMasterCapacityFillNotional(
      accrual({ confirmedQuoteUsdBefore: '150', confirmedQuoteUsdAfter: '150' })
    );
    expect(result.code).toBe('no-new-usd');
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('reports a missing cohort row instead of silently dropping real flow', async () => {
    // The fan-out writer swallows its failures, so a fill can arrive for a
    // fan-out that has no row. Under-counting the numerator permits larger
    // cohorts than it should, which fails OPEN.
    mocks.query.mockResolvedValueOnce([]);
    const result = await accrueMasterCapacityFillNotional(accrual());
    expect(result.applied).toBe(false);
    expect(result.code).toBe('ledger-row-missing');
    expect(result.reason).toMatch(/MISSING from the capacity numerator/);
  });

  it('degrades a mixed cohort row to marked-to-price in the statement itself', async () => {
    mocks.query.mockResolvedValueOnce([
      { notional_usd: '150', notional_basis: 'marked-to-price' }
    ]);
    await accrueMasterCapacityFillNotional(accrual({ quoteCurrency: 'USD' }));
    const [sql] = mocks.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/ELSE 'marked-to-price'/);
  });
});
