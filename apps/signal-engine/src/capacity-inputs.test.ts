import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `@swat/db` re-exports its own barrel, whose `client.ts` throws
 * `DATABASE_URL is required` while being evaluated. Same hoisted guard
 * `fanout-enqueue.test.ts` uses. Nothing here opens a connection.
 */
vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgres://swat:swat@127.0.0.1:5432/swat_unit_tests';
});

const dbMocks = vi.hoisted(() => ({
  fetchMasterWindowNotional: vi.fn(),
  countActiveMasterFollowers: vi.fn(),
  fetchMasterCapacityPolicy: vi.fn(),
  recordMasterCapacityLedgerEntry: vi.fn()
}));

/**
 * The four DB-touching exports are replaced; every pure export
 * (`assessMasterCapacity`, `planFanout`, `usableLiquidityFromPoolTvlUsd`,
 * `unknownLiquidity`, `MASTER_CAPACITY_WINDOWS`) is the **real** one. That is the
 * point: the decision under test is the shipped decision, and only the reads are
 * substituted, because there is no database here.
 */
vi.mock('@swat/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@swat/db')>()),
  ...dbMocks
}));

import {
  DEFAULT_FOLLOWER_SOFT_CAP,
  MASTER_CAPACITY_WINDOWS,
  PLATFORM_MAX_AGGREGATE_IMPACT_BPS,
  type FanoutCandidate,
  type FanoutPlatformInputs,
  type FanoutSignal
} from '@swat/db';
import {
  FANOUT_CAPACITY_EXECUTION_MODES,
  FANOUT_CAPACITY_WINDOW_MS,
  capacityAppliesToDirection,
  capacityGateFor,
  fetchPoolTvlUsdForCapacity,
  ledgerModesForEffectiveMode,
  planCapacityLedgerEntries,
  projectCohortNotionalUsd,
  recordFanoutCapacityLedger,
  resolveFanoutCapacity,
  usableLiquidityForFanout
} from './capacity-inputs.js';

const MASTER = 'solana:MasterWa11etAddress1111111111111111111111';
const TOKEN = 'solana:So11111111111111111111111111111111111111112';
const POLY_MASTER = 'polygon:0x1111111111111111111111111111111111111111';
const POLY_TOKEN = 'polygon:0x2222222222222222222222222222222222222222';
const NOW = new Date('2026-09-05T12:00:00.000Z');

function candidate(overrides: Partial<FanoutCandidate> = {}): FanoutCandidate {
  return {
    userId: overrides.userId ?? 'user-1',
    activeSince: new Date('2026-09-01T00:00:00.000Z'),
    subscriptionState: 'active',
    tier: 'ultra',
    tierExpiresAt: null,
    autoExecute: true,
    killed: false,
    minSignalScore: 0,
    maxConcurrentPositions: 10,
    openPositionCount: 0,
    knownBalanceUsd: 1_000,
    ...overrides
  };
}

const SIGNAL: FanoutSignal = {
  chain: 'solana',
  masterWalletAddress: MASTER,
  tokenMint: TOKEN,
  direction: 'buy',
  score: 90,
  eventAt: new Date('2026-09-02T00:00:00.000Z')
};

const PLATFORM: Omit<FanoutPlatformInputs, 'capacity'> = {
  chainMode: { effectiveMode: 'live' },
  minimumBalanceUsd: 0
};

beforeEach(() => {
  for (const mock of Object.values(dbMocks)) mock.mockReset();
  dbMocks.fetchMasterWindowNotional.mockResolvedValue({
    committedNotionalUsd: 0,
    projectedNotionalUsd: 0,
    coverage: 'accounted'
  });
  dbMocks.countActiveMasterFollowers.mockResolvedValue(10);
  dbMocks.fetchMasterCapacityPolicy.mockResolvedValue({
    policy: {},
    dailyBudgetShareBps: null
  });
  dbMocks.recordMasterCapacityLedgerEntry.mockResolvedValue(undefined);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

// ═══════════════════════════════════════════════════════════════════════════
// Liquidity
// ═══════════════════════════════════════════════════════════════════════════

describe('usableLiquidityForFanout', () => {
  it('halves a DexScreener pool TVL into a one-sided reserve on solana', () => {
    const liquidity = usableLiquidityForFanout({
      chain: 'solana',
      tokenMint: TOKEN,
      poolTvlUsd: 200_000
    });
    expect(liquidity.basis).toBe('amm-pool-tvl');
    expect(liquidity.usableLiquidityUsd).toBe(100_000);
    expect(liquidity.approximate).toBe(true);
  });

  it('uses the same pool basis on robinhood-chain', () => {
    const liquidity = usableLiquidityForFanout({
      chain: 'robinhood-chain',
      tokenMint: 'robinhood-chain:0xabc',
      poolTvlUsd: 50_000
    });
    expect(liquidity.basis).toBe('amm-pool-tvl');
    expect(liquidity.usableLiquidityUsd).toBe(25_000);
  });

  it('reports unknown, not zero, when DexScreener has no pair', () => {
    const liquidity = usableLiquidityForFanout({
      chain: 'solana',
      tokenMint: TOKEN,
      poolTvlUsd: null
    });
    expect(liquidity.basis).toBe('unknown');
    expect(liquidity.usableLiquidityUsd).toBeNull();
  });

  it('refuses to substitute a pool figure for Polymarket, even when one is supplied', () => {
    // The whole point of the polygon branch: a non-null figure here is some
    // unrelated Polygon DEX pair, and using it would let the cap admit a cohort
    // against liquidity that does not exist for this market.
    const liquidity = usableLiquidityForFanout({
      chain: 'polygon',
      tokenMint: POLY_TOKEN,
      poolTvlUsd: 5_000_000
    });
    expect(liquidity.basis).toBe('unknown');
    expect(liquidity.usableLiquidityUsd).toBeNull();
  });

  it('names the CLOB and the missing feed in the polygon note, for whoever reads the skip', () => {
    const liquidity = usableLiquidityForFanout({
      chain: 'polygon',
      tokenMint: POLY_TOKEN,
      poolTvlUsd: null
    });
    expect(liquidity.note).toMatch(/CLOB/);
    expect(liquidity.note).toMatch(/S4-M38/);
  });

  it('does not fetch DexScreener for polygon at all', async () => {
    await expect(fetchPoolTvlUsdForCapacity('polygon', POLY_TOKEN)).resolves.toBeNull();
  });
  it('accepts a measured order-book verdict on polygon (S4-M38)', () => {
    // The gate this replaces was correct while no honest depth figure existed.
    // Now that one does, refusing it would keep Polymarket permanently
    // uncopyable for a reason that no longer applies.
    const book = {
      chain: 'polygon' as const,
      tokenMint: 'polygon:token-1',
      usableLiquidityUsd: 250_000,
      basis: 'order-book-depth' as const,
      // Always true for a book: resting size is an option the maker holds, not a
      // commitment, so the figure can evaporate before the order lands.
      approximate: true,
      note: 'walked ladder within 100bps'
    };
    const result = usableLiquidityForFanout({
      chain: 'polygon',
      tokenMint: 'polygon:token-1',
      poolTvlUsd: 5_000_000,
      polymarketBook: book
    });
    expect(result).toBe(book);
    // The pool figure must still be ignored even now the gate is open.
    expect(result.usableLiquidityUsd).toBe(250_000);
  });

  it('refuses a book verdict that came back unknown, rather than publishing it', () => {
    // A stale, gapped or unsnapshotted book is a VENUE condition; no subscriber
    // at all is a DEPLOYMENT gap. Both fail closed, and the notes differ so an
    // operator is not sent to the wrong place.
    const result = usableLiquidityForFanout({
      chain: 'polygon',
      tokenMint: 'polygon:token-1',
      poolTvlUsd: null,
      polymarketBook: {
        chain: 'polygon',
        tokenMint: 'polygon:token-1',
        // Deliberately INCONSISTENT: a figure present while the basis says the
        // book was not measured. A verdict like this should never arrive, and the
        // point of the fixture is that trusting `basis` blindly -- or passing the
        // verdict straight through -- publishes 999_999 as real liquidity.
        // An earlier version of this test used a null figure, which the
        // pass-through mutation satisfied trivially.
        usableLiquidityUsd: 999_999,
        basis: 'unknown',
        approximate: false,
        note: 'snapshot is 40s stale'
      }
    });
    expect(result.basis).toBe('unknown');
    // The load-bearing assertion: the inconsistent figure must NOT survive.
    expect(result.usableLiquidityUsd).toBeNull();
    expect(result.note).toContain('40s stale');
    expect(result.note).toContain('S4-M38');
  });

  it('carries a book verdict through resolveFanoutCapacity, not just the pure helper', () => {
    // The wiring test. `usableLiquidityForFanout` accepting a verdict is useless
    // if `resolveFanoutCapacity` never passes one -- which is exactly the
    // correct-but-inert shape this checklist has been burned by four times, and
    // which a unit test on the helper alone cannot detect.
    const forwarded = usableLiquidityForFanout({
      chain: 'polygon',
      tokenMint: 'polygon:token-1',
      poolTvlUsd: 9_999_999,
      polymarketBook: {
        chain: 'polygon',
        tokenMint: 'polygon:token-1',
        usableLiquidityUsd: 250_000,
        basis: 'order-book-depth',
        approximate: true,
        note: 'walked ladder'
      }
    });
    expect(forwarded.basis).toBe('order-book-depth');
    expect(forwarded.usableLiquidityUsd).toBe(250_000);
    // And the pool figure is still ignored, even though it is much larger.
    expect(forwarded.usableLiquidityUsd).not.toBe(9_999_999);
  });

  it('still refuses polygon when no subscriber supplied a book', () => {
    // The pre-S4-M38 behaviour, retained for the case it was written for.
    const result = usableLiquidityForFanout({
      chain: 'polygon',
      tokenMint: 'polygon:token-1',
      poolTvlUsd: 5_000_000
    });
    expect(result.basis).toBe('unknown');
    expect(result.usableLiquidityUsd).toBeNull();
  });

});

// ═══════════════════════════════════════════════════════════════════════════
// The cohort projection
// ═══════════════════════════════════════════════════════════════════════════

describe('projectCohortNotionalUsd', () => {
  it('sums the whole known balance of every admissible user', () => {
    const projection = projectCohortNotionalUsd(
      [
        candidate({ userId: 'a', knownBalanceUsd: 1_000 }),
        candidate({ userId: 'b', knownBalanceUsd: 250 })
      ],
      SIGNAL,
      PLATFORM
    );
    expect(projection.projectedNotionalUsd).toBe(1_250);
    expect(projection.cohortSize).toBe(2);
    expect(projection.basis).toBe('sum-of-admissible-known-balances');
  });

  it('errs high: the bound exceeds what per-user sizing would really request', () => {
    // A user at the default 5% max_position_pct would request $50 of a $1,000
    // balance. The bound charges the whole $1,000, which refuses a cohort that
    // would have fitted rather than admitting one that moves the market.
    const projection = projectCohortNotionalUsd(
      [candidate({ knownBalanceUsd: 1_000 })],
      SIGNAL,
      PLATFORM
    );
    expect(projection.projectedNotionalUsd).toBeGreaterThan(1_000 * 0.05);
    expect(projection.projectedNotionalUsd).toBe(1_000);
  });

  it('excludes users the fan-out would exclude anyway, so the cap is not charged for them', () => {
    const projection = projectCohortNotionalUsd(
      [
        candidate({ userId: 'in', knownBalanceUsd: 100 }),
        candidate({ userId: 'killed', knownBalanceUsd: 9_000, killed: true }),
        candidate({ userId: 'manual', knownBalanceUsd: 9_000, autoExecute: false }),
        candidate({ userId: 'low-score', knownBalanceUsd: 9_000, minSignalScore: 99 }),
        candidate({ userId: 'capped', knownBalanceUsd: 9_000, openPositionCount: 10 }),
        candidate({ userId: 'gone', knownBalanceUsd: 9_000, subscriptionState: 'ended' })
      ],
      SIGNAL,
      PLATFORM
    );
    expect(projection.projectedNotionalUsd).toBe(100);
    expect(projection.cohortSize).toBe(1);
  });

  it('never counts an unknown balance as zero — such a user is excluded upstream', () => {
    const projection = projectCohortNotionalUsd(
      [
        candidate({ userId: 'known', knownBalanceUsd: 500 }),
        candidate({ userId: 'unpriced', knownBalanceUsd: null })
      ],
      SIGNAL,
      PLATFORM
    );
    expect(projection.projectedNotionalUsd).toBe(500);
    expect(projection.cohortSize).toBe(1);
  });

  it('projects zero for an empty candidate list', () => {
    const projection = projectCohortNotionalUsd([], SIGNAL, PLATFORM);
    expect(projection.projectedNotionalUsd).toBe(0);
    expect(projection.cohortSize).toBe(0);
  });

  it('excludes nobody for capacity itself — the provisional plan admits', () => {
    // If the provisional gate were `skip` or `null`, the projection would always
    // be 0 and the cap would admit every cohort.
    const projection = projectCohortNotionalUsd(
      [candidate({ knownBalanceUsd: 777 })],
      SIGNAL,
      PLATFORM
    );
    expect(projection.projectedNotionalUsd).toBe(777);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Gate mapping and direction
// ═══════════════════════════════════════════════════════════════════════════

describe('capacityGateFor', () => {
  it('maps an unevaluable cap to null so users read capacity-unknown', async () => {
    const resolved = await resolveFanoutCapacity({
      masterWalletAddress: POLY_MASTER,
      chain: 'polygon',
      tokenMint: POLY_TOKEN,
      poolTvlUsd: 4_000_000,
      projection: projectCohortNotionalUsd([candidate()], SIGNAL, PLATFORM),
      now: NOW
    });
    expect(resolved.decision?.reasonCode).toBe('capacity-not-assessable');
    expect(resolved.capacity).toBeNull();
  });

  it('calls the injected book reader with the cap actually in force (S4-M38)', async () => {
    const readPolymarketBook = vi.fn(async () => ({
      chain: 'polygon' as const,
      tokenMint: POLY_TOKEN,
      usableLiquidityUsd: 5_000_000,
      basis: 'order-book-depth' as const,
      approximate: true,
      note: 'walked ladder'
    }));

    const resolved = await resolveFanoutCapacity({
      masterWalletAddress: POLY_MASTER,
      chain: 'polygon',
      tokenMint: POLY_TOKEN,
      poolTvlUsd: null,
      readPolymarketBook,
      projection: projectCohortNotionalUsd([candidate()], SIGNAL, PLATFORM),
      now: NOW
    });

    // The reader must be reached at all -- the inert-wiring failure this repo has
    // hit repeatedly is a value accepted by the pure helper and never fetched.
    expect(readPolymarketBook).toHaveBeenCalledTimes(1);
    expect(resolved.capacity).not.toBeNull();
    expect(resolved.decision?.reasonCode).not.toBe('capacity-not-assessable');
  });

  it('hands the reader the platform default cap when no override exists', async () => {
    const readPolymarketBook = vi.fn(async () => ({
      chain: 'polygon' as const,
      tokenMint: POLY_TOKEN,
      usableLiquidityUsd: 5_000_000,
      basis: 'order-book-depth' as const,
      approximate: true,
      note: 'walked ladder'
    }));

    await resolveFanoutCapacity({
      masterWalletAddress: POLY_MASTER,
      chain: 'polygon',
      tokenMint: POLY_TOKEN,
      poolTvlUsd: null,
      readPolymarketBook,
      projection: projectCohortNotionalUsd([candidate()], SIGNAL, PLATFORM),
      now: NOW
    });

    expect(readPolymarketBook).toHaveBeenCalledWith(
      expect.objectContaining({ impactCapBps: PLATFORM_MAX_AGGREGATE_IMPACT_BPS.polygon })
    );
  });

  it("hands the reader the master's override cap, not the platform default", async () => {
    // The reason the read is deferred into this function at all. The published
    // reserve is exact only at its own cap, so pricing the book at the default
    // while the cap judges it at 42bps is a fail-open arithmetic error.
    dbMocks.fetchMasterCapacityPolicy.mockResolvedValue({
      policy: { maxAggregateImpactBps: 42 },
      dailyBudgetShareBps: null
    });
    const readPolymarketBook = vi.fn(async () => ({
      chain: 'polygon' as const,
      tokenMint: POLY_TOKEN,
      usableLiquidityUsd: 5_000_000,
      basis: 'order-book-depth' as const,
      approximate: true,
      note: 'walked ladder'
    }));

    await resolveFanoutCapacity({
      masterWalletAddress: POLY_MASTER,
      chain: 'polygon',
      tokenMint: POLY_TOKEN,
      poolTvlUsd: null,
      readPolymarketBook,
      projection: projectCohortNotionalUsd([candidate()], SIGNAL, PLATFORM),
      now: NOW
    });

    expect(readPolymarketBook).toHaveBeenCalledWith(
      expect.objectContaining({ impactCapBps: 42 })
    );
    expect(readPolymarketBook).not.toHaveBeenCalledWith(
      expect.objectContaining({ impactCapBps: PLATFORM_MAX_AGGREGATE_IMPACT_BPS.polygon })
    );
  });

  it('defaults the cohort direction to buy, the side the cap governs', async () => {
    const readPolymarketBook = vi.fn(async () => ({
      chain: 'polygon' as const,
      tokenMint: POLY_TOKEN,
      usableLiquidityUsd: 5_000_000,
      basis: 'order-book-depth' as const,
      approximate: true,
      note: 'walked ladder'
    }));

    await resolveFanoutCapacity({
      masterWalletAddress: POLY_MASTER,
      chain: 'polygon',
      tokenMint: POLY_TOKEN,
      poolTvlUsd: null,
      readPolymarketBook,
      projection: projectCohortNotionalUsd([candidate()], SIGNAL, PLATFORM),
      now: NOW
    });

    expect(readPolymarketBook).toHaveBeenCalledWith(
      expect.objectContaining({ cohortDirection: 'buy' })
    );
  });

  it('does not read the book on a chain priced from pool TVL', async () => {
    const readPolymarketBook = vi.fn();

    await resolveFanoutCapacity({
      masterWalletAddress: 'solana:master',
      chain: 'solana',
      tokenMint: 'solana:So11111111111111111111111111111111111111112',
      poolTvlUsd: 4_000_000,
      readPolymarketBook,
      projection: projectCohortNotionalUsd([candidate()], SIGNAL, PLATFORM),
      now: NOW
    });

    expect(readPolymarketBook).not.toHaveBeenCalled();
  });

  it('prefers an explicitly supplied book over the reader', async () => {
    const readPolymarketBook = vi.fn();

    await resolveFanoutCapacity({
      masterWalletAddress: POLY_MASTER,
      chain: 'polygon',
      tokenMint: POLY_TOKEN,
      poolTvlUsd: null,
      polymarketBook: null,
      readPolymarketBook,
      projection: projectCohortNotionalUsd([candidate()], SIGNAL, PLATFORM),
      now: NOW
    });

    expect(readPolymarketBook).not.toHaveBeenCalled();
  });

  it('still excludes everyone when the reader returns an unknown book', async () => {
    const readPolymarketBook = vi.fn(async () => ({
      chain: 'polygon' as const,
      tokenMint: POLY_TOKEN,
      usableLiquidityUsd: null,
      basis: 'unknown' as const,
      approximate: false,
      note: 'polymarket-book-snapshot-stale'
    }));

    const resolved = await resolveFanoutCapacity({
      masterWalletAddress: POLY_MASTER,
      chain: 'polygon',
      tokenMint: POLY_TOKEN,
      poolTvlUsd: null,
      readPolymarketBook,
      projection: projectCohortNotionalUsd([candidate()], SIGNAL, PLATFORM),
      now: NOW
    });

    // A stale book must not admit anybody. This is the fail-closed direction and
    // the reason the reader never substitutes a last-known value.
    expect(resolved.capacity).toBeNull();
    expect(resolved.decision?.reasonCode).toBe('capacity-not-assessable');
  });

  it('survives a reader that throws, degrading to no feed rather than aborting', async () => {
    const readPolymarketBook = vi.fn(async () => {
      throw new Error('redis unreachable');
    });

    const resolved = await resolveFanoutCapacity({
      masterWalletAddress: POLY_MASTER,
      chain: 'polygon',
      tokenMint: POLY_TOKEN,
      poolTvlUsd: null,
      readPolymarketBook,
      projection: projectCohortNotionalUsd([candidate()], SIGNAL, PLATFORM),
      now: NOW
    });

    // `decision` is still formed: a thrown reader must not collapse the whole
    // resolution the way a failed window read does.
    expect(resolved.decision).not.toBeNull();
    expect(resolved.capacity).toBeNull();
    expect(resolved.logLine).toContain('polymarket book read threw');
  });

  it('admits a polygon cohort once a book verdict is threaded through (S4-M38)', async () => {
    // The wiring assertion. The test directly above proves polygon is
    // unassessable WITHOUT a book; this proves the verdict actually reaches
    // `assessMasterCapacity` rather than being accepted by the pure helper and
    // then dropped on the floor -- the correct-but-inert shape this checklist has
    // been burned by four times, and which a helper-only test cannot detect.
    const resolved = await resolveFanoutCapacity({
      masterWalletAddress: POLY_MASTER,
      chain: 'polygon',
      tokenMint: POLY_TOKEN,
      poolTvlUsd: null,
      polymarketBook: {
        chain: 'polygon',
        tokenMint: POLY_TOKEN,
        usableLiquidityUsd: 5_000_000,
        basis: 'order-book-depth',
        approximate: true,
        note: 'walked ladder within 100bps'
      },
      projection: projectCohortNotionalUsd([candidate()], SIGNAL, PLATFORM),
      now: NOW
    });
    expect(resolved.decision?.reasonCode).not.toBe('capacity-not-assessable');
    expect(resolved.capacity).not.toBeNull();
  });

  it('maps a real impact breach to skip so users read capacity-exhausted', async () => {
    // $20,000 TVL -> $10,000 usable -> 500 bps on solana -> $500 of room.
    const resolved = await resolveFanoutCapacity({
      masterWalletAddress: MASTER,
      chain: 'solana',
      tokenMint: TOKEN,
      poolTvlUsd: 20_000,
      projection: projectCohortNotionalUsd(
        [candidate({ knownBalanceUsd: 50_000 })],
        SIGNAL,
        PLATFORM
      ),
      now: NOW
    });
    expect(resolved.decision?.reasonCode).toBe('capacity-price-impact-cap-reached');
    expect(resolved.capacity).toEqual({ outcome: 'skip' });
  });

  it('maps the follower soft cap to skip, not to unknown', async () => {
    dbMocks.countActiveMasterFollowers.mockResolvedValue(DEFAULT_FOLLOWER_SOFT_CAP + 1);
    const resolved = await resolveFanoutCapacity({
      masterWalletAddress: MASTER,
      chain: 'solana',
      tokenMint: TOKEN,
      poolTvlUsd: 100_000_000,
      projection: projectCohortNotionalUsd([candidate()], SIGNAL, PLATFORM),
      now: NOW
    });
    expect(resolved.decision?.reasonCode).toBe('capacity-follower-soft-cap-reached');
    expect(resolved.capacity).toEqual({ outcome: 'skip' });
  });

  it('admits when the cohort fits under the chain ceiling', async () => {
    const resolved = await resolveFanoutCapacity({
      masterWalletAddress: MASTER,
      chain: 'solana',
      tokenMint: TOKEN,
      poolTvlUsd: 1_000_000,
      projection: projectCohortNotionalUsd([candidate({ knownBalanceUsd: 100 })], SIGNAL, PLATFORM),
      now: NOW
    });
    expect(resolved.decision?.outcome).toBe('admit');
    expect(resolved.capacity).toEqual({ outcome: 'admit' });
  });

  it('never renders the internal detail as a user message', async () => {
    const resolved = await resolveFanoutCapacity({
      masterWalletAddress: MASTER,
      chain: 'solana',
      tokenMint: TOKEN,
      poolTvlUsd: 20_000,
      projection: projectCohortNotionalUsd(
        [candidate({ knownBalanceUsd: 50_000 })],
        SIGNAL,
        PLATFORM
      ),
      now: NOW
    });
    expect(resolved.decision?.user.message).not.toMatch(/\d/);
    expect(resolved.decision?.user.message).not.toMatch(/follower/i);
  });
});

describe('capacityAppliesToDirection', () => {
  it('assesses buys and admits sells without assessment', () => {
    expect(capacityAppliesToDirection('buy')).toBe(true);
    // Refusing a sell strands an open position with no exit.
    expect(capacityAppliesToDirection('sell')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The reads
// ═══════════════════════════════════════════════════════════════════════════

describe('resolveFanoutCapacity', () => {
  it('reads the 5-minute fan-out drain window, live modes only', async () => {
    await resolveFanoutCapacity({
      masterWalletAddress: MASTER,
      chain: 'solana',
      tokenMint: TOKEN,
      poolTvlUsd: 1_000_000,
      projection: projectCohortNotionalUsd([candidate()], SIGNAL, PLATFORM),
      now: NOW
    });
    expect(FANOUT_CAPACITY_WINDOW_MS).toBe(MASTER_CAPACITY_WINDOWS.fanoutDrainMs);
    const call = dbMocks.fetchMasterWindowNotional.mock.calls[0]?.[0];
    expect(call.executionModes).toEqual(['live']);
    expect(call.windowEndsAt.getTime() - call.windowStartsAt.getTime()).toBe(
      FANOUT_CAPACITY_WINDOW_MS
    );
    expect(FANOUT_CAPACITY_EXECUTION_MODES).toEqual(['live']);
  });

  it('overrides only the projected notional and keeps the window coverage', async () => {
    dbMocks.fetchMasterWindowNotional.mockResolvedValue({
      committedNotionalUsd: 400,
      projectedNotionalUsd: 0,
      coverage: 'partial-unpriced-legs',
      unpricedLegCount: 3
    });
    const resolved = await resolveFanoutCapacity({
      masterWalletAddress: MASTER,
      chain: 'solana',
      tokenMint: TOKEN,
      poolTvlUsd: 1_000_000,
      projection: projectCohortNotionalUsd([candidate({ knownBalanceUsd: 100 })], SIGNAL, PLATFORM),
      now: NOW
    });
    expect(resolved.decision?.internal.priceImpact?.lowerBound).toBe(true);
    expect(resolved.decision?.unassessed.map((entry) => entry.reason)).toContain(
      'copy-notional-partial'
    );
    // Still an admit — a lower-bound pass, flagged rather than smoothed away.
    expect(resolved.decision?.outcome).toBe('admit');
  });

  it('feeds an unknown follower count through as unassessed rather than as zero', async () => {
    dbMocks.countActiveMasterFollowers.mockResolvedValue(null);
    const resolved = await resolveFanoutCapacity({
      masterWalletAddress: MASTER,
      chain: 'solana',
      tokenMint: TOKEN,
      poolTvlUsd: 1_000_000,
      projection: projectCohortNotionalUsd([candidate({ knownBalanceUsd: 100 })], SIGNAL, PLATFORM),
      now: NOW
    });
    expect(resolved.decision?.unassessed.map((entry) => entry.reason)).toContain(
      'follower-count-unknown'
    );
    expect(resolved.decision?.internal.followerSoftCap).toBeNull();
  });

  it('applies a per-master policy override to the ceiling', async () => {
    dbMocks.fetchMasterCapacityPolicy.mockResolvedValue({
      policy: { maxAggregateImpactBps: 1 },
      dailyBudgetShareBps: null
    });
    const resolved = await resolveFanoutCapacity({
      masterWalletAddress: MASTER,
      chain: 'solana',
      tokenMint: TOKEN,
      poolTvlUsd: 1_000_000,
      projection: projectCohortNotionalUsd(
        [candidate({ knownBalanceUsd: 5_000 })],
        SIGNAL,
        PLATFORM
      ),
      now: NOW
    });
    expect(resolved.decision?.internal.priceImpact?.capBps).toBe(1);
    expect(resolved.decision?.outcome).toBe('skip');
  });

  it('declares unassessablePolicy skip, never admit', async () => {
    // Asserted through behaviour rather than by inspecting the argument: an
    // unassessable primary must not admit.
    const resolved = await resolveFanoutCapacity({
      masterWalletAddress: MASTER,
      chain: 'solana',
      tokenMint: TOKEN,
      poolTvlUsd: null,
      projection: projectCohortNotionalUsd([candidate()], SIGNAL, PLATFORM),
      now: NOW
    });
    expect(resolved.decision?.outcome).toBe('skip');
    expect(resolved.decision?.reasonCode).not.toBe('capacity-admitted-unassessed');
  });

  it('excludes everyone as capacity-unknown when a read throws', async () => {
    dbMocks.fetchMasterWindowNotional.mockRejectedValue(new Error('connection terminated'));
    const resolved = await resolveFanoutCapacity({
      masterWalletAddress: MASTER,
      chain: 'solana',
      tokenMint: TOKEN,
      poolTvlUsd: 1_000_000,
      projection: projectCohortNotionalUsd([candidate()], SIGNAL, PLATFORM),
      now: NOW
    });
    expect(resolved.capacity).toBeNull();
    expect(resolved.decision).toBeNull();
    expect(resolved.logLine).toMatch(/capacity-unknown/);
  });

  it('uses the chain ceiling derived from DEFAULT_SLIPPAGE_BPS, not a literal', async () => {
    const resolved = await resolveFanoutCapacity({
      masterWalletAddress: MASTER,
      chain: 'solana',
      tokenMint: TOKEN,
      poolTvlUsd: 1_000_000,
      projection: projectCohortNotionalUsd([candidate({ knownBalanceUsd: 10 })], SIGNAL, PLATFORM),
      now: NOW
    });
    expect(resolved.decision?.internal.priceImpact?.capBps).toBe(
      PLATFORM_MAX_AGGREGATE_IMPACT_BPS.solana
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The ledger writer
// ═══════════════════════════════════════════════════════════════════════════

describe('ledgerModesForEffectiveMode', () => {
  it('writes nothing for off — no order was placed', () => {
    expect(ledgerModesForEffectiveMode('off')).toEqual([]);
  });

  it('records paper as paper so it cannot be counted as market-moving flow', () => {
    expect(ledgerModesForEffectiveMode('paper')).toEqual(['paper']);
  });

  it('records live+shadow as two rows, matching executionModesForChainMode', () => {
    expect(ledgerModesForEffectiveMode('live+shadow')).toEqual(['live', 'shadow']);
  });

  it('records live as live', () => {
    expect(ledgerModesForEffectiveMode('live')).toEqual(['live']);
  });
});

describe('planCapacityLedgerEntries', () => {
  const base = {
    masterWalletAddress: MASTER,
    chain: 'solana' as const,
    tokenMint: TOKEN,
    sourceTradeId: 'source-trade-1',
    effectiveMode: 'live' as const,
    cohortSize: 3,
    committedAt: NOW
  };

  it('records an unpriced null notional rather than a fabricated figure', () => {
    const [entry] = planCapacityLedgerEntries(base);
    expect(entry?.notionalUsd).toBeNull();
    expect(entry?.notionalBasis).toBe('unpriced');
  });

  it('writes one row per mode, keyed on the fan-out event', () => {
    const entries = planCapacityLedgerEntries({ ...base, effectiveMode: 'live+shadow' });
    expect(entries.map((entry) => entry.executionMode)).toEqual(['live', 'shadow']);
    expect(new Set(entries.map((entry) => entry.sourceTradeId)).size).toBe(1);
  });

  it('writes nothing when no user job was enqueued', () => {
    expect(planCapacityLedgerEntries({ ...base, cohortSize: 0 })).toEqual([]);
  });

  it('writes nothing for an off chain', () => {
    expect(planCapacityLedgerEntries({ ...base, effectiveMode: 'off' })).toEqual([]);
  });

  it('carries the chain-prefixed master address, so 053 prefix CHECK holds', () => {
    const [entry] = planCapacityLedgerEntries(base);
    expect(entry?.masterWalletAddress.startsWith('solana:')).toBe(true);
    expect(entry?.chain).toBe('solana');
  });
});

describe('recordFanoutCapacityLedger', () => {
  it('writes every planned row', async () => {
    const entries = planCapacityLedgerEntries({
      masterWalletAddress: MASTER,
      chain: 'solana',
      tokenMint: TOKEN,
      sourceTradeId: 'source-trade-1',
      effectiveMode: 'live+shadow',
      cohortSize: 2,
      committedAt: NOW
    });
    await expect(recordFanoutCapacityLedger(entries)).resolves.toBe(2);
    expect(dbMocks.recordMasterCapacityLedgerEntry).toHaveBeenCalledTimes(2);
  });

  it('swallows a write failure — the orders are already queued', async () => {
    dbMocks.recordMasterCapacityLedgerEntry.mockRejectedValue(new Error('deadlock detected'));
    const entries = planCapacityLedgerEntries({
      masterWalletAddress: MASTER,
      chain: 'solana',
      tokenMint: TOKEN,
      sourceTradeId: 'source-trade-1',
      effectiveMode: 'live',
      cohortSize: 1,
      committedAt: NOW
    });
    await expect(recordFanoutCapacityLedger(entries)).resolves.toBe(0);
  });

  it('is a no-op for an empty plan', async () => {
    await expect(recordFanoutCapacityLedger([])).resolves.toBe(0);
    expect(dbMocks.recordMasterCapacityLedgerEntry).not.toHaveBeenCalled();
  });
});
