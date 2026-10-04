import { describe, expect, it, vi } from 'vitest';

import { resolveStrategyTemplate, listStrategyTemplates } from './templates.js';
import { splitRungAmounts, createMeteoraLadderBuilder, type MeteoraLiquidityPort } from './meteora-ladder.js';
import { splitRungLegs, createEvmLadderBuilder, type EvmPositionPort } from './evm-ladder.js';
import { buildLadderPlan, type LadderRung } from './ladder-plan.js';

const rung = (overrides: Partial<LadderRung> = {}): LadderRung => ({
  priceLower: 90,
  priceUpper: 110,
  weight: 0.5,
  allocation: 1_000,
  binLower: 90,
  binUpper: 110,
  ...overrides
});

describe('strategy templates', () => {
  it('lists exactly the four build-plan presets', () => {
    expect(listStrategyTemplates().map((template) => template.name)).toEqual([
      'tight-spot-scalp',
      'deep-bidask-accumulation',
      'wide-range-dump-capture',
      'passive-majors-auto-compound'
    ]);
  });

  it('tight-spot-scalp anchors a narrow symmetric range at the current price', () => {
    const params = resolveStrategyTemplate('tight-spot-scalp', 100);
    expect(params.rangeLower).toBeCloseTo(99, 9);
    expect(params.rangeUpper).toBeCloseTo(101, 9);
    expect(params.distribution).toBe('spot');
    expect(params.rungCount).toBe(5);
  });

  it('wide-range-dump-capture tilts the range below price', () => {
    const params = resolveStrategyTemplate('wide-range-dump-capture', 100);
    const midpoint = (params.rangeLower + params.rangeUpper) / 2;
    expect(midpoint).toBeLessThan(100);
  });

  it('rejects unknown templates and non-positive prices', () => {
    expect(() => resolveStrategyTemplate('moonshot' as never, 100)).toThrow('unknown strategy template');
    expect(() => resolveStrategyTemplate('tight-spot-scalp', 0)).toThrow('currentPrice');
  });
});

describe('meteora splitRungAmounts', () => {
  it('a rung fully below price takes the whole deposit in base', () => {
    const amounts = splitRungAmounts(rung({ priceLower: 90, priceUpper: 99 }), 100);
    expect(amounts.totalXAmount).toBe(1_000);
    expect(amounts.totalYAmount).toBe(0);
  });

  it('a rung fully above price takes the whole deposit in quote', () => {
    const amounts = splitRungAmounts(rung({ priceLower: 101, priceUpper: 110 }), 100);
    expect(amounts.totalXAmount).toBe(0);
    expect(amounts.totalYAmount).toBe(1_000);
  });

  it('a straddling rung splits by log share below price', () => {
    const amounts = splitRungAmounts(rung({ priceLower: 50, priceUpper: 200 }), 100);
    expect(amounts.totalXAmount).toBeCloseTo(500, 9);
    expect(amounts.totalYAmount).toBeCloseTo(500, 9);
  });
});

describe('createMeteoraLadderBuilder', () => {
  it('builds one step per rung with the plan distribution', async () => {
    const buildRungStep = vi.fn(async (step) => step);
    const port: MeteoraLiquidityPort = { buildRungStep };
    const plan = buildLadderPlan({
      protocol: 'meteora-dlmm',
      rangeLower: 100,
      rangeUpper: 200,
      rungCount: 3,
      distribution: 'bidask',
      currentPrice: 100,
      binStep: 100,
      depositAmount: 3_000
    });

    const builder = createMeteoraLadderBuilder(port);
    const steps = await builder.buildLadder({
      plan,
      pairAddress: 'solana:pair',
      userAddress: 'user',
      currentPrice: 150,
      distribution: 'bidask'
    });

    expect(steps).toHaveLength(3);
    expect(buildRungStep).toHaveBeenCalledTimes(3);
    expect(steps.every((step) => step.strategy === 'bidask')).toBe(true);
  });
});

describe('evm splitRungLegs', () => {
  it('splits straddling rungs by log share', () => {
    const legs = splitRungLegs({ priceLower: 50, priceUpper: 200, allocation: 1_000 }, 100);
    expect(legs.amountBase).toBeCloseTo(500, 9);
    expect(legs.amountQuote).toBeCloseTo(500, 9);
  });

  it('a rung above price needs no base swap', () => {
    const legs = splitRungLegs({ priceLower: 150, priceUpper: 200, allocation: 1_000 }, 100);
    expect(legs.amountBase).toBe(0);
    expect(legs.amountQuote).toBe(1_000);
  });
});

describe('createEvmLadderBuilder', () => {
  it('emits swap-then-mint for base-needing rungs and mint-only above price', async () => {
    const buildSwapStep = vi.fn(async (step) => step);
    const buildMintStep = vi.fn(async (step) => step);
    const port: EvmPositionPort = { buildSwapStep, buildMintStep };
    const plan = buildLadderPlan({
      protocol: 'uniswap-v3',
      rangeLower: 0.5,
      rangeUpper: 2,
      rungCount: 2,
      distribution: 'spot',
      currentPrice: 1,
      tickSpacing: 10,
      depositAmount: 2_000
    });

    const builder = createEvmLadderBuilder(port);
    const steps = await builder.buildLadder({
      plan,
      poolAddress: 'robinhood-chain:0xpool',
      recipient: '0xuser',
      currentPrice: 1,
      distribution: 'spot'
    });

    const swaps = steps.filter((step) => step.kind === 'swap');
    const mints = steps.filter((step) => step.kind === 'mint-position');
    expect(swaps).toHaveLength(1); // only the below-price rung needs base
    expect(mints).toHaveLength(2);
    // Swap comes before its rung's mint.
    expect(steps[0]?.kind).toBe('swap');
    expect(steps[1]?.kind).toBe('mint-position');
  });
});
