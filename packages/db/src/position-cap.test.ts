import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_CONCURRENT_POSITIONS,
  InvalidPositionCapError,
  MIN_CONCURRENT_POSITIONS,
  PLATFORM_MAX_CONCURRENT_POSITIONS,
  VENUE_MINIMUM_ORDER_NOTIONAL_USD,
  assessPositionCap,
  clampConcurrentPositionCap,
  perPositionNotionalUsd
} from './position-cap.js';

describe('clampConcurrentPositionCap (S4-M4 platform ceiling)', () => {
  it('passes an in-range request through untouched', () => {
    expect(clampConcurrentPositionCap(10)).toEqual({
      cap: 10,
      clampedByCeiling: false,
      clampedByFloor: false,
      ceiling: PLATFORM_MAX_CONCURRENT_POSITIONS
    });
  });

  it('clamps to the platform ceiling and says the ceiling did it', () => {
    // The UI has to be able to tell the user their number was overridden. A bare
    // clamped value would display a different number than they typed with no
    // explanation.
    const result = clampConcurrentPositionCap(PLATFORM_MAX_CONCURRENT_POSITIONS + 450);
    expect(result.cap).toBe(PLATFORM_MAX_CONCURRENT_POSITIONS);
    expect(result.clampedByCeiling).toBe(true);
    expect(result.clampedByFloor).toBe(false);
  });

  it('clamps to the floor rather than allowing a cap of zero', () => {
    // A cap of 0 means "never open a position", which is a halt, not a risk
    // setting. Storing it here would make a paused account look configured.
    const result = clampConcurrentPositionCap(0);
    expect(result.cap).toBe(MIN_CONCURRENT_POSITIONS);
    expect(result.clampedByFloor).toBe(true);
  });

  it('clamps a negative request to the floor too', () => {
    expect(clampConcurrentPositionCap(-5).cap).toBe(MIN_CONCURRENT_POSITIONS);
  });

  it('throws rather than clamping a non-integer, which is not a wish about counts', () => {
    // 500 is a coherent wish the platform declines; 2.5 is not a wish about
    // position counts at all, and rounding it would be guessing.
    expect(() => clampConcurrentPositionCap(2.5)).toThrow(InvalidPositionCapError);
    expect(() => clampConcurrentPositionCap(Number.NaN)).toThrow(InvalidPositionCapError);
    expect(() => clampConcurrentPositionCap(Number.POSITIVE_INFINITY)).toThrow(InvalidPositionCapError);
  });

  it('rejects a nonsensical ceiling instead of trusting the caller', () => {
    expect(() => clampConcurrentPositionCap(5, 0)).toThrow(InvalidPositionCapError);
    expect(() => clampConcurrentPositionCap(5, 1.5)).toThrow(InvalidPositionCapError);
  });

  it('honours a lower per-caller ceiling', () => {
    const result = clampConcurrentPositionCap(20, 8);
    expect(result).toMatchObject({ cap: 8, clampedByCeiling: true, ceiling: 8 });
  });

  it('keeps the default inside the platform range', () => {
    expect(DEFAULT_MAX_CONCURRENT_POSITIONS).toBeGreaterThanOrEqual(MIN_CONCURRENT_POSITIONS);
    expect(DEFAULT_MAX_CONCURRENT_POSITIONS).toBeLessThanOrEqual(PLATFORM_MAX_CONCURRENT_POSITIONS);
  });
});

describe('perPositionNotionalUsd', () => {
  it('takes the tighter of the percentage cap and the balance split', () => {
    // 1000 balance, cap 10 -> 100 per position by division; 5% -> 50. The
    // percentage binds.
    expect(perPositionNotionalUsd(1_000, 10, 5)).toBe(50);
    // cap 100 -> 10 by division, which is now tighter than 5% (50).
    expect(perPositionNotionalUsd(1_000, 100, 5)).toBe(10);
  });

  it('shrinks as the cap rises, which is what makes the warning necessary', () => {
    const atFive = perPositionNotionalUsd(100, 5, 100);
    const atFifty = perPositionNotionalUsd(100, 50, 100);
    expect(atFifty).toBeLessThan(atFive);
  });
});

describe('assessPositionCap (S4-M4 derived warning)', () => {
  const polygonMin = VENUE_MINIMUM_ORDER_NOTIONAL_USD.polygon.minOrderNotionalUsd;

  it('warns when the cap spreads the balance below the venue minimum', () => {
    // $20 across 50 positions is $0.40 a copy against a $5 minimum: every trade
    // would be skipped. Better said at the slider than discovered in a skip reason.
    const assessment = assessPositionCap({
      requestedCap: 50,
      balancesUsd: { polygon: 20 },
      maxPositionPct: 100
    });
    const warning = assessment.warnings.find((w) => w.chain === 'polygon');
    expect(warning?.code).toBe('cap-spreads-balance-below-venue-minimum');
    expect(warning?.minOrderNotionalUsd).toBe(polygonMin);
    // The actionable part: the highest cap that still clears the minimum.
    expect(warning?.maxCapClearingMinimum).toBe(Math.floor(20 / polygonMin));
  });

  it('does not warn when every copy clears the minimum', () => {
    const assessment = assessPositionCap({
      requestedCap: 2,
      balancesUsd: { polygon: 1_000 },
      maxPositionPct: 100
    });
    expect(assessment.warnings.filter((w) => w.chain === 'polygon')).toHaveLength(0);
  });

  it('distinguishes a percentage that is too low from a cap that is too high', () => {
    // A 0.1% slice of $1,000 is $1 at ANY cap, so lowering the cap fixes nothing.
    // Same symptom, different fix, therefore a different code.
    const assessment = assessPositionCap({
      requestedCap: 1,
      balancesUsd: { polygon: 1_000 },
      maxPositionPct: 0.1
    });
    expect(assessment.warnings.find((w) => w.chain === 'polygon')?.code)
      .toBe('position-pct-below-venue-minimum');
  });

  it('reports an unknown balance as unassessed, never as a passing check', () => {
    // The balance poller can be behind. "We have not priced your balance yet" is
    // not "your copies will be skipped", and an empty warnings array must not be
    // readable as "checked everywhere and fine".
    const assessment = assessPositionCap({
      requestedCap: 50,
      balancesUsd: { polygon: null },
      maxPositionPct: 100
    });
    expect(assessment.warnings).toHaveLength(0);
    expect(assessment.unassessed).toContainEqual({ chain: 'polygon', reason: 'balance-unknown' });
  });

  it('treats an absent chain as unknown rather than zero', () => {
    const assessment = assessPositionCap({
      requestedCap: 50,
      balancesUsd: {},
      maxPositionPct: 100
    });
    expect(assessment.unassessed.some((u) => u.chain === 'polygon' && u.reason === 'balance-unknown'))
      .toBe(true);
  });

  it('lists the two venues with no minimum as unassessed, not as passing', () => {
    // Solana and Robinhood are AMMs that quote any size. There is nothing to
    // check, and inventing a threshold would be fabricating a venue rule.
    const assessment = assessPositionCap({
      requestedCap: 50,
      balancesUsd: { solana: 1, 'robinhood-chain': 1, polygon: 1_000 },
      maxPositionPct: 100
    });
    for (const chain of ['solana', 'robinhood-chain'] as const) {
      expect(assessment.unassessed).toContainEqual({ chain, reason: 'no-venue-minimum' });
      expect(assessment.warnings.some((w) => w.chain === chain)).toBe(false);
    }
  });

  it('flags the Polymarket minimum as approximate, because it is per market', () => {
    // The binding value is read from the order book at submission. A caller that
    // renders this as the venue's truth is misleading the user.
    const assessment = assessPositionCap({
      requestedCap: 50,
      balancesUsd: { polygon: 20 },
      maxPositionPct: 100
    });
    const warning = assessment.warnings.find((w) => w.chain === 'polygon');
    expect(warning?.approximate).toBe(true);
    expect(warning?.message.toLowerCase()).toMatch(/approx|typical|per market|may be/);
  });

  it('reports the clamped cap it actually assessed, not the raw request', () => {
    // Assessing the requested 500 rather than the stored 50 would warn about a
    // cap that can never exist.
    const assessment = assessPositionCap({
      requestedCap: 500,
      balancesUsd: { polygon: 1_000 },
      maxPositionPct: 100
    });
    expect(assessment.requestedCap).toBe(500);
    expect(assessment.effectiveCap).toBe(PLATFORM_MAX_CONCURRENT_POSITIONS);
    expect(assessment.clampedByCeiling).toBe(true);
  });

  it('says no cap works when the balance cannot fund even one order', () => {
    const assessment = assessPositionCap({
      requestedCap: 5,
      balancesUsd: { polygon: 1 },
      maxPositionPct: 100
    });
    expect(assessment.warnings.find((w) => w.chain === 'polygon')?.maxCapClearingMinimum).toBe(0);
  });

  it('covers exactly the supported chains in the minimum table', () => {
    // Typed Record<Chain, ...> so a new chain cannot compile without a decision;
    // this pins the runtime shape too, since a silent undefined reads as
    // "no minimum" and quietly stops warning.
    expect(Object.keys(VENUE_MINIMUM_ORDER_NOTIONAL_USD).sort())
      .toEqual(['base', 'bsc', 'ethereum', 'polygon', 'robinhood-chain', 'solana']);
  });
});
