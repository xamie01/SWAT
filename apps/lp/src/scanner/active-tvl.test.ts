import { describe, expect, it } from 'vitest';

import { createActiveTvlCalculator, type MeteoraActiveTvlContext, type UniswapActiveTvlContext } from './active-tvl.js';

const calculator = createActiveTvlCalculator();

describe('activeTvlCalculator — meteora-dlmm', () => {
  const context: MeteoraActiveTvlContext = {
    protocol: 'meteora-dlmm',
    activeBinId: 100,
    range: 10,
    basePriceUsd: 2,
    quotePriceUsd: 1,
    bins: [
      { binId: 95, price: 2, baseAmount: 10, quoteAmount: 0 },
      { binId: 100, price: 2, baseAmount: 5, quoteAmount: 5 },
      { binId: 105, price: 2, baseAmount: 0, quoteAmount: 20 },
      { binId: 200, price: 2, baseAmount: 1000, quoteAmount: 1000 } // far outside the window
    ]
  };

  it('sums bins within range of the active bin and ignores the rest', () => {
    // 10*2*2 + 5*2*2 + 5*1 + 20*1 = 40 + 20 + 5 + 20 = 85
    expect(calculator.calculateActiveTvl(context)).toBe(85);
  });

  it('returns null, not zero, when a leg cannot be priced', () => {
    expect(
      calculator.calculateActiveTvl({ ...context, quotePriceUsd: null })
    ).toBeNull();
  });

  it('rejects a non-null negative price outright', () => {
    expect(() =>
      calculator.calculateActiveTvl({ ...context, basePriceUsd: -1 })
    ).toThrow('basePriceUsd');
  });
});

describe('activeTvlCalculator — uniswap v3/v4', () => {
  const context: UniswapActiveTvlContext = {
    protocol: 'uniswap-v3',
    currentTick: 0,
    range: 1000,
    basePriceUsd: 1,
    quotePriceUsd: 1,
    bands: [
      // Fully below the current price: all base.
      { tickLower: -200, tickUpper: -100, liquidity: 1_000 },
      // The current band: straddles tick 0.
      { tickLower: -50, tickUpper: 50, liquidity: 2_000 },
      // Fully above: all quote.
      { tickLower: 100, tickUpper: 200, liquidity: 1_000 },
      // A wide band far away — excluded by the range filter.
      { tickLower: -100_000, tickUpper: 100_000, liquidity: 9_999_999 }
    ]
  };

  it('values below bands as base, above bands as quote, and splits the current band', () => {
    const sqrt = (tick: number) => Math.sqrt(1.0001 ** tick);

    const below = 1_000 * (1 / sqrt(-200) - 1 / sqrt(-100));
    const above = 1_000 * (sqrt(200) - sqrt(100));
    const currentBase = 2_000 * (1 / sqrt(0) - 1 / sqrt(50));
    const currentQuote = 2_000 * (sqrt(50) - sqrt(0));

    expect(calculator.calculateActiveTvl(context)).toBeCloseTo(below + above + currentBase + currentQuote, 9);
  });

  it('a band exactly ending at the current tick is fully base, not straddled', () => {
    const sqrt = (tick: number) => Math.sqrt(1.0001 ** tick);
    const value = calculator.calculateActiveTvl({
      ...context,
      bands: [{ tickLower: -100, tickUpper: 0, liquidity: 5_000 }],
      currentTick: 0
    });
    expect(value).toBeCloseTo(5_000 * (1 / sqrt(-100) - 1 / sqrt(0)), 9);
  });

  it('returns null when prices are missing', () => {
    expect(calculator.calculateActiveTvl({ ...context, basePriceUsd: null })).toBeNull();
  });

  it('rejects inverted tick bands', () => {
    expect(() =>
      calculator.calculateActiveTvl({
        ...context,
        bands: [{ tickLower: 100, tickUpper: -100, liquidity: 1 }]
      })
    ).toThrow('tickLower < tickUpper');
  });
});
