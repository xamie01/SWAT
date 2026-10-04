import type { LpStrategyType } from '@swat/db';
import type { LpProtocol } from '../scanner/types.js';

/**
 * Ladder planning math (Track E2/E4) — the pure core both chain builders share.
 *
 * A ladder splits a deposit across `rungCount` contiguous price bands inside
 * one range, with per-rung weights shaped by the strategy distribution:
 *
 *   - `spot`    — equal weights. Tight ranges; classic market-making shape.
 *   - `curve`   — weights decay from the rung nearest the current price
 *                 (front-loaded), matching where fill probability concentrates.
 *   - `bidask`  — weights concentrate at the two edges of the range (the bid
 *                 and the ask), the accumulation shape: heavy where price
 *                 would have to travel far to reach you.
 *
 * Meteora rungs snap to bin ids; Uniswap rungs snap to tick boundaries. Both
 * snap from the same continuous price math here, so the two builders only
 * translate, never re-decide.
 */

export interface LadderPlanInput {
  readonly protocol: LpProtocol;
  /** Quote-per-base lower bound of the whole ladder. */
  readonly rangeLower: number;
  /** Quote-per-base upper bound of the whole ladder. */
  readonly rangeUpper: number;
  readonly rungCount: number;
  readonly distribution: LpStrategyType;
  /** Current quote-per-base price; rung weighting for curve uses it as the anchor. */
  readonly currentPrice: number;
  /** Meteora bin step in bps (e.g. 10 = 0.1% per bin). Required for DLMM plans. */
  readonly binStep?: number;
  /** Uniswap tick spacing. Required for Uniswap plans. */
  readonly tickSpacing?: number;
  /** Total deposit, in deposit-asset terms (USD used for reporting weights only). */
  readonly depositAmount: number;
}

export interface LadderRung {
  readonly priceLower: number;
  readonly priceUpper: number;
  /** Fraction of the deposit assigned to this rung; rungs sum to 1 (± rounding). */
  readonly weight: number;
  /** Absolute allocation, same unit as `depositAmount`. */
  readonly allocation: number;
  /** Meteora: inclusive bin range (bin ids are price(1+b)^(id)). */
  readonly binLower?: number;
  readonly binUpper?: number;
  /** Uniswap: inclusive tick boundaries. */
  readonly tickLower?: number;
  readonly tickUpper?: number;
}

export interface LadderPlan {
  readonly rungs: readonly LadderRung[];
}

function assertPositive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number, got ${value}`);
  }
}

/** Weights per rung by distribution; sums to 1 within float error. */
export function computeRungWeights(distribution: LpStrategyType, rungCount: number): number[] {
  if (!Number.isInteger(rungCount) || rungCount < 1 || rungCount > 64) {
    throw new Error(`rungCount must be an integer in 1..64, got ${rungCount}`);
  }
  if (rungCount === 1) return [1];

  if (distribution === 'spot') {
    return Array.from({ length: rungCount }, () => 1 / rungCount);
  }

  // Exponential shape parameter: curve front-loads toward the current price,
  // bidask does the reverse (edges heaviest). lambda = 1.2 gives a visible
  // tilt without degenerate rungs.
  const lambda = 1.2;
  const rawWeights: number[] = [];
  for (let index = 0; index < rungCount; index += 1) {
    const position = index / (rungCount - 1); // 0 .. 1 across the range
    rawWeights.push(
      distribution === 'curve'
        ? Math.exp(-lambda * position)
        : Math.exp(-lambda * (1 - position))
    );
  }
  const total = rawWeights.reduce((sum, weight) => sum + weight, 0);
  return rawWeights.map((weight) => weight / total);
}

/** Contiguous price bounds dividing [rangeLower, rangeUpper] into rungCount bands. */
export function computeRungPriceBounds(
  rangeLower: number,
  rangeUpper: number,
  rungCount: number
): { priceLower: number; priceUpper: number }[] {
  assertPositive('rangeLower', rangeLower);
  assertPositive('rangeUpper', rangeUpper);
  if (rangeUpper <= rangeLower) {
    throw new Error(`range must satisfy rangeLower < rangeUpper, got ${rangeLower}..${rangeUpper}`);
  }
  if (!Number.isInteger(rungCount) || rungCount < 1 || rungCount > 64) {
    throw new Error(`rungCount must be an integer in 1..64, got ${rungCount}`);
  }

  // Geometric division, not arithmetic: equal log-widths keeps rung exposure
  // comparable at both ends of a wide range.
  const logLower = Math.log(rangeLower);
  const logUpper = Math.log(rangeUpper);
  const logStep = (logUpper - logLower) / rungCount;
  return Array.from({ length: rungCount }, (_, index) => ({
    priceLower: Math.exp(logLower + index * logStep),
    priceUpper: Math.exp(logLower + (index + 1) * logStep)
  }));
}

/** Meteora bin id at a price: id = ln(price) / ln(1 + binStep). */
export function priceToBinId(price: number, binStepBps: number): number {
  assertPositive('price', price);
  if (!Number.isFinite(binStepBps) || binStepBps <= 0) {
    throw new Error(`binStepBps must be positive, got ${binStepBps}`);
  }
  return Math.round(Math.log(price) / Math.log(1 + binStepBps / 10_000));
}

/** Uniswap tick at a price: tick = ln(price) / ln(1.0001), floored to spacing. */
export function priceToTick(price: number, tickSpacing: number): number {
  assertPositive('price', price);
  if (!Number.isFinite(tickSpacing) || tickSpacing <= 0) {
    throw new Error(`tickSpacing must be positive, got ${tickSpacing}`);
  }
  const raw = Math.log(price) / Math.log(1.0001);
  const floored = Math.floor(raw);
  return floored - (((floored % tickSpacing) + tickSpacing) % tickSpacing);
}

/** Builds the whole plan: bounds, weights, allocations, and chain snapping. */
export function buildLadderPlan(input: LadderPlanInput): LadderPlan {
  if (input.protocol === 'meteora-dlmm' && input.binStep === undefined) {
    throw new Error('meteora ladder plans require binStep');
  }
  if (input.protocol !== 'meteora-dlmm' && input.tickSpacing === undefined) {
    throw new Error('uniswap ladder plans require tickSpacing');
  }

  const bounds = computeRungPriceBounds(input.rangeLower, input.rangeUpper, input.rungCount);
  const weights = computeRungWeights(input.distribution, input.rungCount);
  const lastIndex = bounds.length - 1;

  const rungs = bounds.map((bound, index) => {
    const rung: LadderRung = {
      priceLower: bound.priceLower,
      priceUpper: bound.priceUpper,
      weight: weights[index]!,
      allocation: weights[index]! * input.depositAmount
    };

    if (input.protocol === 'meteora-dlmm') {
      const binLower = priceToBinId(bound.priceLower, input.binStep!);
      const binUpper = priceToBinId(bound.priceUpper, input.binStep!);
      // Contiguous bin coverage: rung i ends one bin before rung i+1 starts.
      return {
        ...rung,
        binLower,
        binUpper: index === lastIndex ? binUpper : Math.max(binLower, binUpper - 1)
      };
    }

    const tickLower = priceToTick(bound.priceLower, input.tickSpacing!);
    const tickUpper = priceToTick(bound.priceUpper, input.tickSpacing!);
    // Unlike DLMM bin ids, Uniswap tick ranges may share a boundary tick with
    // the neighboring rung — positions are independent ranges, not exhaustive
    // coverage — so no −1 adjustment here.
    return {
      ...rung,
      tickLower,
      tickUpper: Math.max(tickLower + input.tickSpacing!, tickUpper)
    };
  });

  return { rungs };
}
