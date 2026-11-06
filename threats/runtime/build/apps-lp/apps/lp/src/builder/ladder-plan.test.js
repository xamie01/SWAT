import { describe, expect, it } from 'vitest';
import { buildLadderPlan, computeRungPriceBounds, computeRungWeights, priceToBinId, priceToTick } from './ladder-plan.js';
describe('computeRungWeights', () => {
    const bounds = computeRungPriceBounds(100, 200, 4);
    it('spot weights are equal', () => {
        const weights = computeRungWeights('spot', 4);
        expect(weights).toHaveLength(4);
        weights.forEach((weight) => expect(weight).toBeCloseTo(0.25, 12));
    });
    it('curve weights front-load toward the rung nearest the current price', () => {
        // Price near the top of the range: the top rung is heaviest (dump-capture
        // over a down-tilted range), decaying toward the bottom.
        const topAnchored = computeRungWeights('curve', 4, { currentPrice: 190, bounds });
        expect(topAnchored[3]).toBeGreaterThan(topAnchored[0]);
        expect(topAnchored.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
        // Price near the bottom: the shape flips, it does not stay index-anchored.
        const bottomAnchored = computeRungWeights('curve', 4, { currentPrice: 110, bounds });
        expect(bottomAnchored[0]).toBeGreaterThan(bottomAnchored[3]);
        // The same price outside the range still loads the nearest rung most.
        const below = computeRungWeights('curve', 4, { currentPrice: 50, bounds });
        expect(below[0]).toBeGreaterThan(below[1]);
    });
    it('curve weights demand the anchor', () => {
        expect(() => computeRungWeights('curve', 4)).toThrow('anchor');
    });
    it('bidask weights load both edges and dip in the middle', () => {
        const weights = computeRungWeights('bidask', 4);
        expect(weights[0]).toBeGreaterThan(weights[1]);
        expect(weights[3]).toBeGreaterThan(weights[2]);
        // Symmetric shape: the two edges are (within float error) equal.
        expect(weights[0]).toBeCloseTo(weights[3], 12);
        const sum = weights.reduce((a, b) => a + b, 0);
        expect(sum).toBeCloseTo(1, 9);
    });
    it('rejects a nonsense rung count', () => {
        expect(() => computeRungWeights('spot', 0)).toThrow('rungCount');
        expect(() => computeRungWeights('spot', 1.5)).toThrow('rungCount');
    });
});
describe('computeRungPriceBounds', () => {
    it('divides the range into contiguous geometric bands', () => {
        const bounds = computeRungPriceBounds(100, 200, 4);
        expect(bounds).toHaveLength(4);
        expect(bounds[0]?.priceLower).toBeCloseTo(100, 9);
        expect(bounds[3]?.priceUpper).toBeCloseTo(200, 9);
        for (let index = 1; index < bounds.length; index += 1) {
            expect(bounds[index]?.priceLower).toBeCloseTo(bounds[index - 1]?.priceUpper ?? 0, 9);
        }
        // Geometric: equal log widths, so the first band is narrower in absolute terms.
        const firstWidth = bounds[0].priceUpper - bounds[0].priceLower;
        const lastWidth = bounds[3].priceUpper - bounds[3].priceLower;
        expect(firstWidth).toBeLessThan(lastWidth);
    });
    it('rejects an inverted range', () => {
        expect(() => computeRungPriceBounds(200, 100, 2)).toThrow('rangeLower < rangeUpper');
    });
});
describe('chain snapping', () => {
    it('priceToBinId inverts the DLMM bin price curve', () => {
        // binStep 10 bps: id 100 ≈ (1.001)^100
        const price = 1.001 ** 100;
        expect(priceToBinId(price, 10)).toBe(100);
    });
    it('priceToTick floors to the tick spacing', () => {
        // tick for price 1.001 is ~10; with spacing 60 the result floored to spacing.
        const tick = priceToTick(1.001, 60);
        expect(tick % 60).toBe(0);
        expect(tick).toBeLessThanOrEqual(Math.log(1.001) / Math.log(1.0001));
    });
});
describe('buildLadderPlan', () => {
    it('a meteora plan snaps rungs to contiguous non-overlapping bin ranges', () => {
        const plan = buildLadderPlan({
            protocol: 'meteora-dlmm',
            rangeLower: 100,
            rangeUpper: 200,
            rungCount: 3,
            distribution: 'spot',
            currentPrice: 150,
            binStep: 50,
            depositAmount: 3_000
        });
        expect(plan.rungs).toHaveLength(3);
        for (let index = 1; index < plan.rungs.length; index += 1) {
            const previous = plan.rungs[index - 1];
            const current = plan.rungs[index];
            expect(current.binLower).toBeGreaterThan(previous.binUpper - 1);
            expect(current.binLower).toBe(previous.binUpper + 1);
        }
        // Spot: equal allocations.
        plan.rungs.forEach((rung) => expect(rung.allocation).toBeCloseTo(1_000, 9));
    });
    it('a uniswap plan snaps to spaced ticks and assigns per-rung allocations', () => {
        const plan = buildLadderPlan({
            protocol: 'uniswap-v3',
            rangeLower: 0.95,
            rangeUpper: 1.05,
            rungCount: 2,
            distribution: 'bidask',
            currentPrice: 1,
            tickSpacing: 60,
            depositAmount: 1_000
        });
        expect(plan.rungs).toHaveLength(2);
        plan.rungs.forEach((rung) => {
            // Negative ticks modulo spacing can be -0 in JS; compare magnitude.
            expect(Math.abs(rung.tickLower % 60)).toBe(0);
            expect(Math.abs(rung.tickUpper % 60)).toBe(0);
            expect(rung.tickUpper).toBeGreaterThan(rung.tickLower);
            expect(rung.tickUpper - rung.tickLower).toBeGreaterThanOrEqual(60);
        });
        const total = plan.rungs.reduce((sum, rung) => sum + rung.allocation, 0);
        expect(total).toBeCloseTo(1_000, 9);
    });
    it('demands the right granularity param per protocol', () => {
        expect(() => buildLadderPlan({
            protocol: 'meteora-dlmm',
            rangeLower: 1,
            rangeUpper: 2,
            rungCount: 2,
            distribution: 'spot',
            currentPrice: 1.5,
            depositAmount: 100
        })).toThrow('binStep');
        expect(() => buildLadderPlan({
            protocol: 'uniswap-v3',
            rangeLower: 1,
            rangeUpper: 2,
            rungCount: 2,
            distribution: 'spot',
            currentPrice: 1.5,
            depositAmount: 100
        })).toThrow('tickSpacing');
    });
});
//# sourceMappingURL=ladder-plan.test.js.map