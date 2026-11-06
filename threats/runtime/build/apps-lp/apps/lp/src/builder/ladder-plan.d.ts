import type { LpStrategyType } from '@swat/db';
import type { LpProtocol } from '../scanner/types.js';
/**
 * Ladder planning math (Track E2/E4) — the pure core both chain builders share.
 *
 * A ladder splits a deposit across `rungCount` contiguous price bands inside
 * one range, with per-rung weights shaped by the strategy distribution:
 *
 *   - `spot`    — equal weights. Tight ranges; classic market-making shape.
 *   - `curve`   — weights decay from the rung nearest the CURRENT PRICE (in log
 *                 space), decaying outward in both directions. Where the price
 *                 sits inside the range decides which end is loaded: a
 *                 down-tilted range loads its top rung (catching dumps), an
 *                 up-tilted one its bottom (catching pumps).
 *   - `bidask`  — weights concentrate at BOTH edges of the range (the bid and
 *                 the ask), dipping in the middle — the accumulation shape:
 *                 heavy where price would have to travel far to reach you.
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
/** The context curve weights need: where the price sits across the rung bounds. */
export interface RungWeightAnchor {
    /** Current quote-per-base price the curve tilts toward. */
    readonly currentPrice: number;
    /** The rung bounds (from `computeRungPriceBounds`), in order. */
    readonly bounds: readonly {
        readonly priceLower: number;
        readonly priceUpper: number;
    }[];
}
/**
 * Weights per rung by distribution; sums to 1 within float error.
 *
 * `curve` requires the anchor (price + bounds) because "nearest the current
 * price" is meaningless without them; `spot` and `bidask` are anchor-free
 * shapes. `bidask` loads both edges symmetrically — one exponential anchored
 * at each edge, summed — so the shape is a dip in the middle, not a ramp.
 */
export declare function computeRungWeights(distribution: LpStrategyType, rungCount: number, anchor?: RungWeightAnchor): number[];
/** Contiguous price bounds dividing [rangeLower, rangeUpper] into rungCount bands. */
export declare function computeRungPriceBounds(rangeLower: number, rangeUpper: number, rungCount: number): {
    priceLower: number;
    priceUpper: number;
}[];
/** Meteora bin id at a price: id = ln(price) / ln(1 + binStep). */
export declare function priceToBinId(price: number, binStepBps: number): number;
/** Uniswap tick at a price: tick = ln(price) / ln(1.0001), floored to spacing. */
export declare function priceToTick(price: number, tickSpacing: number): number;
/** Builds the whole plan: bounds, weights, allocations, and chain snapping. */
export declare function buildLadderPlan(input: LadderPlanInput): LadderPlan;
//# sourceMappingURL=ladder-plan.d.ts.map