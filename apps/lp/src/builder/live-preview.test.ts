import { describe, expect, it } from 'vitest';

import { buildLivePreview } from './live-preview.js';

const context = {
  chain: 'solana' as const,
  protocol: 'meteora-dlmm' as const,
  poolAddress: 'solana:5hbf9JP8k5zdrZp9pokPypFQoBse5mGCmW6nqodurGcd',
  currentPrice: 0.299,
  binStep: 20,
  tickSpacing: null,
  bins: [
    { binId: 100, price: 0.29, baseAmount: 0, quoteAmount: 100 },
    { binId: 110, price: 0.2958, baseAmount: 50, quoteAmount: 0 },
    { binId: 120, price: 0.3017, baseAmount: 0, quoteAmount: 200 },
    { binId: 130, price: 0.3077, baseAmount: 0, quoteAmount: 0 }
  ],
  bands: null,
  warnings: []
};

describe('buildLivePreview (Track I2)', () => {
  it('resolves a template into params and rungs, flagged as template-sourced', () => {
    const preview = buildLivePreview({
      ...context,
      template: 'tight-spot-scalp',
      depositAmount: 1_000
    });

    expect(preview.source).toBe('template');
    // tight-spot-scalp: ±2% around 0.299 → [0.29601, 0.30199]; compare numerically
    // because expect.closeTo does not apply inside toEqual object matching.
    expect(preview.params.rangeLower).toBeCloseTo(0.29601, 8);
    expect(preview.params.rangeUpper).toBeCloseTo(0.30199, 8);
    expect(preview.params.rungCount).toBe(5);
    expect(preview.params.distribution).toBe('spot');
    expect(preview.rungs).toHaveLength(5);
    expect(preview.depositAmount).toBe(1_000);
    const allocationSum = preview.rungs.reduce((sum, rung) => sum + rung.allocation, 0);
    expect(allocationSum).toBeCloseTo(1_000, 9);
  });

  it('accepts user-edited custom params — the E5 pre-fill round trip', () => {
    const preview = buildLivePreview({
      ...context,
      custom: { rangeLower: 0.27, rangeUpper: 0.33, rungCount: 4, distribution: 'bidask' },
      depositAmount: 2_000
    });

    expect(preview.source).toBe('custom');
    expect(preview.params).toEqual({
      rangeLower: 0.27,
      rangeUpper: 0.33,
      rungCount: 4,
      distribution: 'bidask'
    });
    // bidask: far edge heaviest
    expect(preview.rungs[3]?.weight).toBeGreaterThan(preview.rungs[0]?.weight ?? 0);
  });

  it('validates user-edited params exactly as the confirm handler will', () => {
    expect(() =>
      buildLivePreview({
        ...context,
        custom: { rangeLower: 0.33, rangeUpper: 0.27, rungCount: 4, distribution: 'spot' }
      })
    ).toThrow('rangeUpper must be greater than rangeLower');

    expect(() =>
      buildLivePreview({
        ...context,
        custom: { rangeLower: 0.27, rangeUpper: 0.33, rungCount: 0, distribution: 'spot' }
      })
    ).toThrow('rungCount');

    expect(() =>
      buildLivePreview({
        ...context,
        custom: { rangeLower: 0.27, rangeUpper: 0.33, rungCount: 4, distribution: 'moonshot' as never }
      })
    ).toThrow('distribution');

    expect(() =>
      buildLivePreview({
        ...context,
        template: 'tight-spot-scalp',
        custom: { rangeLower: 0.27, rangeUpper: 0.33, rungCount: 4, distribution: 'spot' }
      })
    ).toThrow('not both');
  });

  it('annotates rungs with the share of live bin liquidity in range', () => {
    const preview = buildLivePreview({
      ...context,
      custom: { rangeLower: 0.25, rangeUpper: 0.32, rungCount: 4, distribution: 'spot' },
      depositAmount: 400
    });

    const shares = preview.rungs.map((rung) => rung.liveLiquidityShare);
    // total live value: 100 + 50*0.2958 + 200 = 314.79
    // rung 0 covers the lowest band containing bin 100 (price 0.29) — some share
    expect(shares.every((share) => share === null || (share >= 0 && share <= 1))).toBe(true);
    const sum = shares.reduce<number>((sum, share) => sum + (share ?? 0), 0);
    // rungs tile the range; every liquidity bin falls in exactly one rung
    expect(sum).toBeCloseTo(1, 6);
  });

  it('degrades to null shares with a visible warning when bins are absent', () => {
    const preview = buildLivePreview({
      ...context,
      bins: null,
      custom: { rangeLower: 0.25, rangeUpper: 0.32, rungCount: 2, distribution: 'spot' }
    });

    expect(preview.rungs.every((rung) => rung.liveLiquidityShare === null)).toBe(true);
    expect(preview.contextWarning).toContain('live bin/tick liquidity unavailable');
  });

  it('works without a deposit — weights only, allocation zeroed', () => {
    const preview = buildLivePreview({
      ...context,
      template: 'tight-spot-scalp'
    });

    expect(preview.depositAmount).toBeNull();
    const weightSum = preview.rungs.reduce((sum, rung) => sum + rung.weight, 0);
    expect(weightSum).toBeCloseTo(1, 9);
    expect(preview.rungs.every((rung) => rung.allocation === 0)).toBe(true);
  });

  it('demands the live granularity before planning', () => {
    expect(() =>
      buildLivePreview({ ...context, binStep: null, template: 'tight-spot-scalp' })
    ).toThrow('binStep');
  });
});
