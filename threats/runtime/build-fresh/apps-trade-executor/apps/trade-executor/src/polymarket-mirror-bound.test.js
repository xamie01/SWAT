import { describe, expect, it } from 'vitest';
import { POLYMARKET_MIRROR_DEFAULT_TOLERANCE_BPS, ceilToPolymarketTick, floorToPolymarketTick, planPolymarketMirrorBound, resolvePolymarketMirrorToleranceBps } from './polymarket-mirror-bound.js';
/**
 * `S4-M16` — the mirror's price bound comes from the master's fill.
 *
 * Every case here is a branch that changes what gets submitted, or refuses to
 * submit. None restates the arithmetic: the happy-path assertions are about the
 * *direction* of the grid move and the relationship between the bound and the
 * book, which is where a regression would actually hurt.
 */
const BASE = {
    direction: 'buy',
    masterFillPrice: 0.4,
    bookLimitPrice: 0.4,
    tickSize: 0.01,
    shares: 50,
    minimumShares: 5
};
describe('polymarket mirror price bound', () => {
    it('bounds a buy at the master fill plus tolerance, not at the book level', () => {
        // The book says 0.40 is available. The bound is deliberately *looser* than
        // that so a tick of adverse movement between the walk and the submission
        // still fills — but it is anchored on the master's fill, so it can never
        // chase beyond the tolerance.
        const decision = planPolymarketMirrorBound({ ...BASE, toleranceBps: 500 });
        expect(decision.kind).toBe('submit');
        if (decision.kind !== 'submit')
            return;
        expect(decision.boundPrice).toBe(0.42); // floor(0.40 × 1.05 = 0.42) on a 0.01 grid
        expect(decision.boundPrice).toBeGreaterThan(BASE.bookLimitPrice);
        expect(Math.round(decision.trackingBps)).toBe(500);
    });
    it('bounds a sell at the master fill minus tolerance, below the book bid', () => {
        const decision = planPolymarketMirrorBound({
            ...BASE,
            direction: 'sell',
            masterFillPrice: 0.6,
            bookLimitPrice: 0.6,
            toleranceBps: 500
        });
        expect(decision.kind).toBe('submit');
        if (decision.kind !== 'submit')
            return;
        expect(decision.boundPrice).toBe(0.57); // ceil(0.60 × 0.95 = 0.57)
        expect(decision.boundPrice).toBeLessThan(0.6);
    });
    it('floors a buy bound to the grid so the tolerance can only tighten', () => {
        // 0.40 × 1.015 = 0.406. Rounding up to 0.41 would pay more than the user's
        // stated tolerance allows, so the grid move goes the other way.
        const decision = planPolymarketMirrorBound({ ...BASE, toleranceBps: 150 });
        expect(decision.kind).toBe('submit');
        if (decision.kind !== 'submit')
            return;
        expect(decision.boundPrice).toBe(0.4);
        expect(decision.trackingBps).toBeLessThanOrEqual(150);
    });
    it('raises a sell bound to the grid so the tolerance can only tighten', () => {
        // 0.60 × 0.985 = 0.591. Rounding down to 0.59 would accept less than the
        // tolerance allows.
        const decision = planPolymarketMirrorBound({
            ...BASE,
            direction: 'sell',
            masterFillPrice: 0.6,
            bookLimitPrice: 0.6,
            toleranceBps: 150
        });
        expect(decision.kind).toBe('submit');
        if (decision.kind !== 'submit')
            return;
        expect(decision.boundPrice).toBe(0.6);
    });
    it('skips rather than chasing when the book has moved past the master fill', () => {
        // The master bought at 0.40; the cheapest ask is now 0.71. A resting order
        // would "solve" this by waiting, which is the failure FAK exists to avoid.
        const decision = planPolymarketMirrorBound({ ...BASE, bookLimitPrice: 0.71 });
        expect(decision).toMatchObject({ kind: 'skip', code: 'book-moved-past-master-fill' });
        if (decision.kind !== 'skip')
            return;
        expect(decision.reason).toContain('0.71');
        expect(decision.reason).toContain('0.4');
    });
    it('skips a sell when the bid has fallen below the master fill tolerance', () => {
        const decision = planPolymarketMirrorBound({
            ...BASE,
            direction: 'sell',
            masterFillPrice: 0.6,
            bookLimitPrice: 0.3
        });
        expect(decision).toMatchObject({ kind: 'skip', code: 'book-moved-past-master-fill' });
    });
    it('fails closed when the master fill price was never recorded', () => {
        // The mirror path must not silently fall back to a book-derived bound: that
        // is the un-sanctioned price this item exists to remove.
        for (const masterFillPrice of [null, undefined]) {
            expect(planPolymarketMirrorBound({ ...BASE, masterFillPrice })).toMatchObject({
                kind: 'skip',
                code: 'master-fill-price-unavailable'
            });
        }
    });
    it.each([0, 1, 1.4, -0.2, Number.NaN])('fails closed on a master fill price of %s, which is not an outcome price', (masterFillPrice) => {
        expect(planPolymarketMirrorBound({ ...BASE, masterFillPrice })).toMatchObject({
            kind: 'skip',
            code: 'master-fill-price-invalid'
        });
    });
    it('skips a sub-minimum order with a reason instead of rounding it up', () => {
        const decision = planPolymarketMirrorBound({ ...BASE, shares: 4.99, minimumShares: 5 });
        expect(decision).toMatchObject({ kind: 'skip', code: 'below-venue-minimum-order-size' });
        if (decision.kind !== 'skip')
            return;
        // Actionable, per S4-M24: it names the shortfall and what would fix it.
        expect(decision.reason).toContain('4.99');
        expect(decision.reason).toContain('5-share minimum');
    });
    it('accepts a share count exactly at the venue minimum', () => {
        expect(planPolymarketMirrorBound({ ...BASE, shares: 5, minimumShares: 5 }).kind).toBe('submit');
    });
    it('skips when the tolerance window contains no tick, rather than rounding to one', () => {
        // A master fill of 0.005 on a 0.01-tick market: the whole tolerance window
        // sits between 0 and the first grid line. Rounding up to 0.01 would double
        // the price the user pays.
        const decision = planPolymarketMirrorBound({
            ...BASE,
            masterFillPrice: 0.005,
            bookLimitPrice: 0.01,
            toleranceBps: 100
        });
        expect(decision).toMatchObject({ kind: 'skip', code: 'no-tick-inside-mirror-tolerance' });
    });
    it('skips a sell whose tolerance window rounds up past a valid outcome price', () => {
        // The master sold at 0.99 on a finer grid; this market's grid is 0.1, so the
        // conservative SELL floor ceilings to 1.0 — not an outcome price. Reported as
        // a grid problem rather than a book problem, because widening the tolerance is
        // the operator's only lever here.
        const decision = planPolymarketMirrorBound({
            ...BASE,
            direction: 'sell',
            masterFillPrice: 0.99,
            bookLimitPrice: 0.9,
            tickSize: 0.1,
            toleranceBps: 1
        });
        expect(decision).toMatchObject({ kind: 'skip', code: 'no-tick-inside-mirror-tolerance' });
    });
    it('refuses a book level that is off the tick grid rather than bounding against it', () => {
        // Caller-contract violation: the book walk rejects off-grid levels, so this
        // can only mean the bound was derived from something that is not a validated
        // walk. Raising keeps the grid arithmetic below it honest.
        expect(() => planPolymarketMirrorBound({ ...BASE, bookLimitPrice: 0.4237 })).toThrow(/off the 0.01 tick grid/);
    });
    it('never submits a buy bound below the level the order has to reach', () => {
        // A bound under the book level cannot fill, so submitting it would burn the
        // signal's one-shot claim for nothing. Exhaustive over the documented grid.
        for (const tickSize of [0.1, 0.01, 0.005, 0.0025, 0.001, 0.0001]) {
            for (const masterFillPrice of [0.03, 0.17, 0.4237, 0.5, 0.8891]) {
                for (const toleranceBps of [0, 1, 25, 150, 500]) {
                    const bookLimitPrice = floorToPolymarketTick(masterFillPrice, tickSize);
                    if (bookLimitPrice <= 0)
                        continue;
                    const decision = planPolymarketMirrorBound({
                        ...BASE,
                        masterFillPrice,
                        bookLimitPrice,
                        tickSize,
                        toleranceBps
                    });
                    if (decision.kind !== 'submit')
                        continue;
                    expect(decision.boundPrice, `tick ${tickSize} master ${masterFillPrice} tolerance ${toleranceBps}`).toBeGreaterThanOrEqual(bookLimitPrice);
                    expect(decision.boundPrice).toBeLessThanOrEqual(masterFillPrice * (1 + toleranceBps / 10_000) + 1e-9);
                }
            }
        }
    });
    it('raises on a misconfigured tolerance instead of silently skipping every trade', () => {
        // A skip here would disable mirroring platform-wide with no operator signal.
        for (const toleranceBps of [-1, 5_001, 1.5, Number.NaN]) {
            expect(() => planPolymarketMirrorBound({ ...BASE, toleranceBps })).toThrow(/POLYMARKET_MIRROR_TOLERANCE_BPS/);
        }
    });
    it('refuses a tick size that does not divide the price range', () => {
        // 0.03 is not a documented increment and does not tile [0,1); landing a bound
        // on that grid would be a guess.
        expect(() => planPolymarketMirrorBound({ ...BASE, tickSize: 0.03 })).toThrow(/does not divide the price range/);
    });
    it('reads the tolerance from the environment and falls back to the default', () => {
        expect(resolvePolymarketMirrorToleranceBps({})).toBe(POLYMARKET_MIRROR_DEFAULT_TOLERANCE_BPS);
        expect(resolvePolymarketMirrorToleranceBps({ POLYMARKET_MIRROR_TOLERANCE_BPS: '250' })).toBe(250);
        expect(() => resolvePolymarketMirrorToleranceBps({ POLYMARKET_MIRROR_TOLERANCE_BPS: 'wide' })).toThrow(/POLYMARKET_MIRROR_TOLERANCE_BPS/);
    });
    it('lands on the documented tick grid in both directions', () => {
        expect(floorToPolymarketTick(0.4237, 0.01)).toBeCloseTo(0.42, 10);
        expect(ceilToPolymarketTick(0.4237, 0.01)).toBeCloseTo(0.43, 10);
        expect(floorToPolymarketTick(0.4975, 0.0025)).toBeCloseTo(0.4975, 10);
        expect(ceilToPolymarketTick(0.4975, 0.0025)).toBeCloseTo(0.4975, 10);
    });
});
//# sourceMappingURL=polymarket-mirror-bound.test.js.map