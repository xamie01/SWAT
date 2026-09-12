import { describe, expect, it } from 'vitest';
import {
  assertPolymarketBookLiquidityCalibration,
  assessPolymarketBookDepth,
  createInMemoryPolymarketBookCache,
  polymarketBookAverageImpactBps,
  polymarketBookDepthFullyAssessed,
  PolymarketBookDepthInputError,
  POLYMARKET_BOOK_CLOCK_SKEW_ALLOWANCE_MS,
  POLYMARKET_BOOK_DEFAULT_BOUND_BPS,
  POLYMARKET_BOOK_MAX_AGE_MS,
  POLYMARKET_BOOK_MAX_BOUND_BPS,
  POLYMARKET_BOOK_RESYNC_INTERVAL_MS,
  type PolymarketBookDepthRequest,
  type PolymarketBookEntry,
  type PolymarketBookLevel
} from './polymarket-book-depth.js';

/** A real-shaped CLOB token id: the `asset_id` on the market channel. */
const TOKEN_ID = '107505882767731489358349912513945399560393482969656700824895970500493757150417';
const PREFIXED = `polygon:${TOKEN_ID}`;

const NOW = 1_782_753_400_000;

/**
 * Polygon's aggregate-impact ceiling today: `DEFAULT_SLIPPAGE_BPS.polygon` (300)
 * times `AGGREGATE_IMPACT_SHARE_OF_SLIPPAGE` (1/3), floored.
 */
const POLYGON_CAP_BPS = 100;

function book(over: Partial<Extract<PolymarketBookEntry, { status: 'book' }>> = {}) {
  const entry: PolymarketBookEntry = {
    status: 'book',
    tokenId: TOKEN_ID,
    observedAt: NOW - 1_000,
    ladders: {
      bids: [{ price: 0.4, size: 1_000 }],
      asks: [{ price: 0.5, size: 1_000 }]
    },
    ...over
  };
  return entry;
}

function assess(
  entry: PolymarketBookEntry | undefined,
  over: Partial<PolymarketBookDepthRequest> = {}
) {
  const cache = createInMemoryPolymarketBookCache(entry === undefined ? [] : [entry]);
  return assessPolymarketBookDepth(cache, {
    tokenMint: PREFIXED,
    cohortDirection: 'buy',
    impactCapBps: POLYGON_CAP_BPS,
    now: NOW,
    ...over
  });
}

describe('assessPolymarketBookDepth (S4-M38)', () => {
  it('prices a fresh book and reports it as fully assessed', () => {
    const verdict = assess(book());
    expect(verdict.outcome).toBe('assessed');
    expect(verdict.reasonCode).toBe('polymarket-book-depth-assessed');
    expect(verdict.unassessed).toEqual([]);
    expect(verdict.unknownCode).toBeNull();
    expect(polymarketBookDepthFullyAssessed(verdict)).toBe(true);
    expect(verdict.tokenMint).toBe(PREFIXED);
  });

  it('accepts a bare CLOB asset_id and still reports a chain-prefixed tokenMint', () => {
    const verdict = assess(book(), { tokenMint: TOKEN_ID });
    expect(verdict.tokenMint).toBe(PREFIXED);
    expect(verdict.outcome).toBe('assessed');
  });

  it('refuses a token prefixed for another chain rather than assessing it', () => {
    expect(() => assess(book(), { tokenMint: `solana:${TOKEN_ID}` }))
      .toThrow(PolymarketBookDepthInputError);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Staleness. The rule S4-M6 records: a stale entry keeps reading unknown.
  // ─────────────────────────────────────────────────────────────────────────

  describe('staleness — a stale entry must read unknown, never its last value', () => {
    it('a stale snapshot returns unknown and NOT the last observed depth', () => {
      const stale = book({ observedAt: NOW - (POLYMARKET_BOOK_MAX_AGE_MS + 1) });
      const verdict = assess(stale);
      expect(verdict.outcome).toBe('unknown');
      expect(verdict.unknownCode).toBe('book-snapshot-stale');
      expect(verdict.reasonCode).toBe('polymarket-book-snapshot-stale');
      // The load-bearing assertions: no figure of any kind survives.
      expect(verdict.depth).toBeNull();
      expect(verdict.capacity).toBeNull();
      expect(verdict.liquidity.usableLiquidityUsd).toBeNull();
      expect(verdict.liquidity.basis).toBe('unknown');
      expect(polymarketBookDepthFullyAssessed(verdict)).toBe(false);
    });

    it('a book exactly at the age budget is still assessed', () => {
      const verdict = assess(book({ observedAt: NOW - POLYMARKET_BOOK_MAX_AGE_MS }));
      expect(verdict.outcome).toBe('assessed');
      expect(verdict.ageMs).toBe(POLYMARKET_BOOK_MAX_AGE_MS);
    });

    it('the age budget is two resync periods, so exactly one missed resync is tolerated', () => {
      expect(POLYMARKET_BOOK_MAX_AGE_MS).toBe(POLYMARKET_BOOK_RESYNC_INTERVAL_MS * 2);
      // One missed resync: assessed. Two: unknown.
      expect(assess(book({ observedAt: NOW - POLYMARKET_BOOK_RESYNC_INTERVAL_MS * 2 })).outcome)
        .toBe('assessed');
      expect(assess(book({ observedAt: NOW - POLYMARKET_BOOK_RESYNC_INTERVAL_MS * 3 })).outcome)
        .toBe('unknown');
    });

    it('honours an explicit maxAgeMs override in the tightening direction', () => {
      const verdict = assess(book({ observedAt: NOW - 5_000 }), { maxAgeMs: 1_000 });
      expect(verdict.unknownCode).toBe('book-snapshot-stale');
    });

    it('refuses a book observed further in the future than the skew allowance', () => {
      const verdict = assess(book({
        observedAt: NOW + POLYMARKET_BOOK_CLOCK_SKEW_ALLOWANCE_MS + 1
      }));
      expect(verdict.unknownCode).toBe('book-clock-implausible');
      expect(verdict.liquidity.usableLiquidityUsd).toBeNull();
    });

    it('refuses a venue timestamp beyond the skew allowance, but tolerates a null one', () => {
      expect(assess(book({ venueTimestamp: NOW + 60_000 })).unknownCode)
        .toBe('book-clock-implausible');
      // Documented nullable on both `book` and `price_change`.
      expect(assess(book({ venueTimestamp: null })).outcome).toBe('assessed');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Unknown is never zero and never "fine".
  // ─────────────────────────────────────────────────────────────────────────

  describe('an empty cache is its own code, never zero', () => {
    it('an empty cache returns book-not-cached with no numeric figure', () => {
      const verdict = assess(undefined);
      expect(verdict.outcome).toBe('unknown');
      expect(verdict.unknownCode).toBe('book-not-cached');
      expect(verdict.reasonCode).toBe('polymarket-book-not-cached');
      expect(verdict.depth).toBeNull();
      expect(verdict.capacity).toBeNull();
      expect(verdict.liquidity.usableLiquidityUsd).toBeNull();
      expect(verdict.liquidity.usableLiquidityUsd).not.toBe(0);
      expect(verdict.ageMs).toBeNull();
    });

    it('a missing entry is distinguishable from an observed zero', () => {
      const missing = assess(undefined);
      const observedZero = assess(book({
        ladders: { bids: [{ price: 0.4, size: 1_000 }], asks: [] }
      }));
      expect(missing.outcome).toBe('unknown');
      expect(observedZero.outcome).toBe('no-depth-within-bound');
      expect(missing.reasonCode).not.toBe(observedZero.reasonCode);
    });
  });

  it('a post-reconnect entry reads unknown even though top-of-book survived', () => {
    const verdict = assess({
      status: 'awaiting-snapshot',
      tokenId: TOKEN_ID,
      since: NOW - 500,
      bestBid: 0.4,
      bestAsk: 0.5
    });
    expect(verdict.unknownCode).toBe('book-awaiting-snapshot');
    expect(verdict.depth).toBeNull();
    expect(verdict.liquidity.usableLiquidityUsd).toBeNull();
  });

  it('a crossed book reads unknown — that is also a transposed bids/asks mapping', () => {
    const verdict = assess(book({
      ladders: {
        bids: [{ price: 0.6, size: 100 }],
        asks: [{ price: 0.5, size: 100 }]
      }
    }));
    expect(verdict.unknownCode).toBe('book-crossed');
  });

  it('a malformed level is refused for the whole entry rather than filtered out', () => {
    const verdict = assess(book({
      ladders: {
        bids: [{ price: 0.4, size: 100 }],
        asks: [{ price: 0.5, size: 100 }, { price: 1.4, size: 100 }]
      }
    }));
    expect(verdict.unknownCode).toBe('book-level-invalid');
  });

  it('a zero-size level is a price_change deletion, dropped rather than refused', () => {
    const verdict = assess(book({
      ladders: {
        bids: [{ price: 0.4, size: 1_000 }],
        asks: [{ price: 0.5, size: 1_000 }, { price: 0.51, size: 0 }]
      }
    }));
    expect(verdict.outcome).toBe('assessed');
    expect(verdict.depth?.levelsWithinBound).toBe(1);
  });

  it('both sides empty reads unknown, because that is what a failed snapshot looks like', () => {
    const verdict = assess(book({ ladders: { bids: [], asks: [] } }));
    expect(verdict.unknownCode).toBe('book-empty');
    expect(verdict.liquidity.usableLiquidityUsd).toBeNull();
  });

  it('one side empty against a populated other side is a known zero, not unknown', () => {
    const verdict = assess(book({
      ladders: { bids: [{ price: 0.4, size: 1_000 }], asks: [] }
    }));
    expect(verdict.outcome).toBe('no-depth-within-bound');
    expect(verdict.reasonCode).toBe('polymarket-book-depth-empty-within-bound');
    expect(verdict.unknownCode).toBeNull();
    // Known zero still publishes no number, because UsableLiquidity cannot
    // express one — but it is a distinct outcome from unknown.
    expect(verdict.liquidity.usableLiquidityUsd).toBeNull();
    expect(polymarketBookDepthFullyAssessed(verdict)).toBe(false);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Depth within a bound, not a scalar.
  // ─────────────────────────────────────────────────────────────────────────

  describe('depth is measured within a price bound, never as a total', () => {
    /**
     * Best ask 0.50; 200 bps takes prices up to 0.51. The 0.60 level is 2000 bps
     * away and must not be counted at all — that is the wall a "total depth"
     * figure would admit a cohort against.
     */
    const wallOutsideBound: readonly PolymarketBookLevel[] = [
      { price: 0.5, size: 100 },
      { price: 0.51, size: 100 },
      { price: 0.6, size: 1_000_000 }
    ];

    it('excludes size resting outside the bound, so a far wall is invisible', () => {
      const verdict = assess(book({
        ladders: { bids: [{ price: 0.4, size: 10 }], asks: [...wallOutsideBound] },
        observedAt: NOW
      }), { boundBps: 200, impactCapBps: 5_000 });
      expect(verdict.outcome).toBe('assessed');
      // 100*0.50 + 100*0.51 = 101, and NOT 101 + 600_000.
      expect(verdict.depth?.notionalWithinBoundUsd).toBeCloseTo(101, 9);
      expect(verdict.depth?.worstPriceWithinBound).toBe(0.51);
      expect(verdict.capacity?.boundedBy).toBe('price-bound');
      expect(verdict.depth?.ladderExhausted).toBe(false);
    });

    it('a wider bound reaches more size, so the bound is doing the work', () => {
      const narrow = assess(book({
        ladders: { bids: [{ price: 0.4, size: 10 }], asks: [...wallOutsideBound] }
      }), { boundBps: 200, impactCapBps: 5_000 });
      const wide = assess(book({
        ladders: { bids: [{ price: 0.4, size: 10 }], asks: [...wallOutsideBound] }
      }), { boundBps: 2_000, impactCapBps: 5_000 });
      expect(wide.depth!.notionalWithinBoundUsd)
        .toBeGreaterThan(narrow.depth!.notionalWithinBoundUsd);
    });

    it('reports ladderExhausted when every visible level qualified, so depth is a lower bound', () => {
      const verdict = assess(book(), { impactCapBps: 5_000 });
      expect(verdict.depth?.ladderExhausted).toBe(true);
      expect(verdict.capacity?.boundedBy).toBe('book-exhausted');
    });

    it('defaults the bound to the executor own book-walk slippage cap', () => {
      expect(POLYMARKET_BOOK_DEFAULT_BOUND_BPS).toBe(200);
      const verdict = assess(book());
      expect(verdict.boundBps).toBe(POLYMARKET_BOOK_DEFAULT_BOUND_BPS);
    });

    it('refuses a bound wide enough to swallow the ladder', () => {
      expect(() => assess(book(), { boundBps: POLYMARKET_BOOK_MAX_BOUND_BPS + 1 }))
        .toThrow(PolymarketBookDepthInputError);
      expect(() => assess(book(), { boundBps: 0 })).toThrow(PolymarketBookDepthInputError);
    });

    it('walks asks for a cohort buy and bids for a cohort sell', () => {
      const asymmetric = book({
        ladders: {
          bids: [{ price: 0.4, size: 1_000 }],
          asks: [{ price: 0.5, size: 10 }]
        }
      });
      const buy = assess(asymmetric, { cohortDirection: 'buy', impactCapBps: 5_000 });
      const sell = assess(asymmetric, { cohortDirection: 'sell', impactCapBps: 5_000 });
      expect(buy.depth?.bestPrice).toBe(0.5);
      expect(sell.depth?.bestPrice).toBe(0.4);
      expect(buy.depth?.notionalWithinBoundUsd).toBeCloseTo(5, 9);
      expect(sell.depth?.notionalWithinBoundUsd).toBeCloseTo(400, 9);
    });

    it('bounds a sell downward from the best bid, not upward', () => {
      // Best bid 0.50, 200 bps down is 0.49. A 0.45 bid is outside.
      const verdict = assess(book({
        ladders: {
          bids: [{ price: 0.5, size: 100 }, { price: 0.49, size: 100 }, { price: 0.45, size: 1_000 }],
          asks: [{ price: 0.6, size: 10 }]
        }
      }), { cohortDirection: 'sell', boundBps: 200, impactCapBps: 5_000 });
      expect(verdict.depth?.worstPriceWithinBound).toBe(0.49);
      expect(verdict.depth?.notionalWithinBoundUsd).toBeCloseTo(99, 9);
    });

    it('sorts unsorted ladders rather than trusting the filler order', () => {
      const verdict = assess(book({
        ladders: {
          bids: [{ price: 0.3, size: 10 }, { price: 0.4, size: 10 }],
          asks: [{ price: 0.51, size: 100 }, { price: 0.5, size: 100 }]
        }
      }), { impactCapBps: 5_000 });
      expect(verdict.depth?.bestPrice).toBe(0.5);
      expect(verdict.depth?.worstPriceWithinBound).toBe(0.51);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // The book's own impact model, and the calibrated reserve.
  // ─────────────────────────────────────────────────────────────────────────

  describe('the impact model is the book walk, not constant product', () => {
    it('computes average execution impact from the ladder itself', () => {
      // 100 shares at 0.50 then 100 at 0.55. Taking $105 buys 200 shares at an
      // average of 0.525, i.e. 500 bps above best.
      const impact = polymarketBookAverageImpactBps({
        ladders: {
          bids: [],
          asks: [{ price: 0.5, size: 100 }, { price: 0.55, size: 100 }]
        },
        cohortDirection: 'buy',
        notionalUsd: 105
      });
      expect(impact).toBeCloseTo(500, 6);
    });

    it('returns null for a size the ladder cannot absorb rather than a large number', () => {
      expect(polymarketBookAverageImpactBps({
        ladders: { bids: [], asks: [{ price: 0.5, size: 10 }] },
        cohortDirection: 'buy',
        notionalUsd: 1_000
      })).toBeNull();
    });

    it('caps capacity at the average-impact ceiling, solving the partial level exactly', () => {
      // Best 0.50, cap 100 bps -> target average 0.505. Taking all 100 shares at
      // 0.50 then x at 0.60: (50 + 0.6x) / (100 + x) = 0.505 -> x = 100*0.005/0.095.
      const verdict = assess(book({
        ladders: {
          bids: [{ price: 0.4, size: 10 }],
          asks: [{ price: 0.5, size: 100 }, { price: 0.6, size: 10_000 }]
        }
      }), { impactCapBps: 100, boundBps: 2_000 });
      expect(verdict.capacity?.boundedBy).toBe('impact-cap');
      const expectedShares = 100 + (100 * 0.005) / 0.095;
      expect(verdict.capacity?.capacityShares).toBeCloseTo(expectedShares, 6);
      expect(verdict.capacity?.capacityImpactBps).toBeCloseTo(100, 6);
    });

    it('never reports a capacity whose own average impact exceeds the cap', () => {
      const verdict = assess(book({
        ladders: {
          bids: [{ price: 0.4, size: 10 }],
          asks: [
            { price: 0.5, size: 1 },
            { price: 0.505, size: 10 },
            { price: 0.51, size: 10_000 }
          ]
        }
      }), { impactCapBps: 100, boundBps: 2_000 });
      expect(verdict.capacity!.capacityImpactBps).toBeLessThanOrEqual(100 + 1e-6);
    });

    it('publishes a reserve calibrated so the consumer threshold reproduces the book walk', () => {
      const verdict = assess(book({
        ladders: {
          bids: [{ price: 0.4, size: 10 }],
          asks: [{ price: 0.5, size: 100 }, { price: 0.6, size: 10_000 }]
        }
      }), { impactCapBps: POLYGON_CAP_BPS, boundBps: 2_000 });
      const capacity = verdict.capacity!;
      const reserve = verdict.liquidity.usableLiquidityUsd!;

      // The two identities that make the substitution honest, restated as the
      // consumer computes them: priceImpactBps(N, reserve) = N/reserve*10_000, and
      // capacityNotionalUsd(reserve, cap) = reserve*cap/10_000.
      const impactOfCapacity = (capacity.capacityNotionalUsd / reserve) * 10_000;
      expect(impactOfCapacity).toBeCloseTo(POLYGON_CAP_BPS, 9);
      expect((reserve * POLYGON_CAP_BPS) / 10_000).toBeCloseTo(capacity.capacityNotionalUsd, 9);

      // And a notional past capacity breaches the cap in the consumer's arithmetic.
      const over = capacity.capacityNotionalUsd * 1.01;
      expect((over / reserve) * 10_000).toBeGreaterThan(POLYGON_CAP_BPS);
    });

    it('publishes the reserve rather than the raw depth, and says so', () => {
      const verdict = assess(book({
        ladders: {
          bids: [{ price: 0.4, size: 10 }],
          asks: [{ price: 0.5, size: 100 }, { price: 0.6, size: 10_000 }]
        }
      }), { impactCapBps: POLYGON_CAP_BPS, boundBps: 2_000 });
      expect(verdict.liquidity.usableLiquidityUsd)
        .not.toBeCloseTo(verdict.depth!.notionalWithinBoundUsd, 6);
      expect(verdict.liquidity.usableLiquidityUsd)
        .toBeCloseTo(verdict.capacity!.equivalentReserveUsd, 9);
      expect(verdict.liquidity.note).toMatch(/equivalent one-sided reserve/);
      expect(verdict.liquidity.note).toMatch(/not a constant-product pool/);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // The UsableLiquidity contract S4-M6 consumes.
  // ─────────────────────────────────────────────────────────────────────────

  describe('the UsableLiquidity-shaped output', () => {
    it('uses the existing order-book-depth basis and needs no new basis value', () => {
      const verdict = assess(book());
      expect(verdict.liquidity.basis).toBe('order-book-depth');
      expect(verdict.liquidity.chain).toBe('polygon');
      expect(verdict.liquidity.tokenMint).toBe(PREFIXED);
      // Resting size is an option the maker holds, and the ladder is up to
      // maxAgeMs old, so this is never an exact figure.
      expect(verdict.liquidity.approximate).toBe(true);
    });

    it('every non-assessed outcome publishes basis unknown and a null figure', () => {
      const cases = [
        assess(undefined),
        assess(book({ observedAt: NOW - 120_000 })),
        assess({ status: 'awaiting-snapshot', tokenId: TOKEN_ID, since: NOW }),
        assess(book({ ladders: { bids: [], asks: [] } })),
        assess(book({ ladders: { bids: [{ price: 0.4, size: 10 }], asks: [] } }))
      ];
      for (const verdict of cases) {
        expect(verdict.liquidity.basis).toBe('unknown');
        expect(verdict.liquidity.usableLiquidityUsd).toBeNull();
        expect(verdict.liquidity.calibratedForImpactCapBps).toBeNull();
        expect(polymarketBookDepthFullyAssessed(verdict)).toBe(false);
      }
    });

    it('requires an impact cap and refuses a non-positive one', () => {
      expect(() => assess(book(), { impactCapBps: 0 })).toThrow(PolymarketBookDepthInputError);
      expect(() => assess(book(), { impactCapBps: Number.NaN }))
        .toThrow(PolymarketBookDepthInputError);
    });

    it('detects a figure judged against a cap it was not calibrated for', () => {
      const verdict = assess(book(), { impactCapBps: POLYGON_CAP_BPS });
      expect(() => assertPolymarketBookLiquidityCalibration(verdict.liquidity, POLYGON_CAP_BPS))
        .not.toThrow();
      expect(() => assertPolymarketBookLiquidityCalibration(verdict.liquidity, 500))
        .toThrow(PolymarketBookDepthInputError);
      // An unknown figure carries no calibration to mismatch.
      expect(() => assertPolymarketBookLiquidityCalibration(assess(undefined).liquidity, 500))
        .not.toThrow();
    });

    it('reads a clock only from its argument', () => {
      const entry = book({ observedAt: NOW - 1_000 });
      const cache = createInMemoryPolymarketBookCache([entry]);
      const early = assessPolymarketBookDepth(cache, {
        tokenMint: PREFIXED,
        cohortDirection: 'buy',
        impactCapBps: POLYGON_CAP_BPS,
        now: NOW
      });
      const late = assessPolymarketBookDepth(cache, {
        tokenMint: PREFIXED,
        cohortDirection: 'buy',
        impactCapBps: POLYGON_CAP_BPS,
        now: NOW + 120_000
      });
      expect(early.outcome).toBe('assessed');
      expect(late.outcome).toBe('unknown');
      expect(() => assessPolymarketBookDepth(cache, {
        tokenMint: PREFIXED,
        cohortDirection: 'buy',
        impactCapBps: POLYGON_CAP_BPS,
        now: Number.NaN
      })).toThrow(PolymarketBookDepthInputError);
    });
  });

  it('every unknown outcome carries exactly one unassessed code, and assessed carries none', () => {
    expect(assess(undefined).unassessed).toEqual(['book-not-cached']);
    expect(assess(book({ observedAt: NOW - 120_000 })).unassessed).toEqual(['book-snapshot-stale']);
    expect(assess(book()).unassessed).toEqual([]);
  });
});
