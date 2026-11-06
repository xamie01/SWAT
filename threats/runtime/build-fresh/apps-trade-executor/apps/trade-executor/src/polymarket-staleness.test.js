import { describe, expect, it } from 'vitest';
import { evaluatePolymarketSignalStaleness, evaluatePolymarketStaleness, isPolymarketSignalStale, POLYMARKET_DEFAULT_STALENESS_CEILING_MS, POLYMARKET_DEFAULT_STALENESS_FLOOR_MS, polymarketStalenessBudgetMs, resolvePolymarketStalenessPolicy } from './polymarket-staleness.js';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
describe('Polymarket staleness as a fraction of time-to-resolution (S4-M18)', () => {
    describe('the rule is a fraction, not a constant', () => {
        it('accepts six hours late on a two-day market and refuses it on an eight-hour one', () => {
            // The checklist case, stated directly. Same age, same policy, two markets;
            // a constant cannot separate them and a fraction must.
            const policy = { maxResolutionFraction: 0.2, maxBudgetMs: 12 * HOUR };
            const twoDays = evaluatePolymarketStaleness({
                signalAgeMs: 6 * HOUR,
                msToResolution: 2 * DAY,
                policy
            });
            const eightHours = evaluatePolymarketStaleness({
                signalAgeMs: 6 * HOUR,
                msToResolution: 8 * HOUR,
                policy
            });
            expect(twoDays.kind).toBe('fresh');
            expect(eightHours.kind).toBe('stale');
            expect(eightHours).toMatchObject({ code: 'signal-age-exceeds-resolution-fraction' });
            // 6h of 48h is 12.5% consumed; 6h of 8h is 75%. The rule is reading the
            // ratio, which is the whole point of the item.
            expect(twoDays.consumedFraction).toBeCloseTo(0.125);
            expect(eightHours.consumedFraction).toBeCloseTo(0.75);
        });
        it('tightens the budget monotonically as resolution approaches', () => {
            const budgets = [30 * DAY, 2 * DAY, 6 * HOUR, HOUR, 10 * MINUTE, MINUTE]
                .map((ms) => polymarketStalenessBudgetMs(ms));
            for (let index = 1; index < budgets.length; index += 1) {
                expect(budgets[index]).toBeLessThanOrEqual(budgets[index - 1]);
            }
            // Long-dated markets sit on the flat ceiling; near-resolution markets are
            // pulled down to the floor.
            expect(budgets[0]).toBe(POLYMARKET_DEFAULT_STALENESS_CEILING_MS);
            expect(budgets.at(-1)).toBe(POLYMARKET_DEFAULT_STALENESS_FLOOR_MS);
        });
        it('never loosens beyond the flat ceiling it refines', () => {
            // The safety property. A control added to reduce risk must not become
            // permission to accept a signal today's constant would have refused, so a
            // market resolving in a century still tops out at the ceiling.
            expect(polymarketStalenessBudgetMs(100 * 365 * DAY))
                .toBe(POLYMARKET_DEFAULT_STALENESS_CEILING_MS);
            const ancient = evaluatePolymarketStaleness({
                signalAgeMs: POLYMARKET_DEFAULT_STALENESS_CEILING_MS + 1,
                msToResolution: 100 * 365 * DAY
            });
            expect(ancient).toMatchObject({
                kind: 'stale',
                code: 'signal-age-exceeds-absolute-ceiling'
            });
        });
        it('never tightens below the order-book age allowance', () => {
            // A budget under `POLYMARKET_MAX_BOOK_AGE_MS` would refuse a signal younger
            // than the book we are about to trade against, which is incoherent.
            expect(polymarketStalenessBudgetMs(1)).toBe(POLYMARKET_DEFAULT_STALENESS_FLOOR_MS);
            expect(evaluatePolymarketStaleness({
                signalAgeMs: POLYMARKET_DEFAULT_STALENESS_FLOOR_MS,
                msToResolution: 30_000
            }).kind).toBe('fresh');
        });
    });
    describe('fail-closed branches', () => {
        it('refuses a market with no readable resolution time', () => {
            // Docs type Gamma's `endDate` and `endDateIso` as nullable and say nothing
            // about what a null means, so the denominator is genuinely unknown.
            // Falling back to the flat constant would reinstate exactly the behaviour
            // this item replaces, on the markets where risk is least measurable.
            for (const msToResolution of [null, undefined, Number.NaN]) {
                expect(evaluatePolymarketStaleness({ signalAgeMs: 1_000, msToResolution })).toMatchObject({
                    kind: 'stale',
                    code: 'resolution-time-unknown'
                });
            }
        });
        it('refuses a market already eligible for resolution', () => {
            expect(evaluatePolymarketStaleness({ signalAgeMs: 1_000, msToResolution: 0 }))
                .toMatchObject({ kind: 'stale', code: 'market-already-resolved' });
            expect(evaluatePolymarketStaleness({ signalAgeMs: 1_000, msToResolution: -1 }))
                .toMatchObject({ kind: 'stale', code: 'market-already-resolved' });
        });
        it('refuses an unmeasurable age rather than treating it as zero', () => {
            // A negative age means our clock and the indexer's disagree. Clamping it to
            // zero would read a skewed signal as maximally fresh.
            for (const signalAgeMs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
                expect(evaluatePolymarketStaleness({ signalAgeMs, msToResolution: DAY })).toMatchObject({
                    kind: 'stale',
                    code: 'signal-age-invalid'
                });
            }
        });
        it('raises on a misconfigured policy instead of silently coercing it', () => {
            // An operator threshold that cannot be honoured is a bug, not a datum about
            // this trade, so it must not resolve to a quiet skip.
            expect(() => evaluatePolymarketStaleness({
                signalAgeMs: 0, msToResolution: DAY, policy: { maxResolutionFraction: 0 }
            })).toThrow('greater than 0 and at most 1');
            expect(() => evaluatePolymarketStaleness({
                signalAgeMs: 0, msToResolution: DAY, policy: { maxResolutionFraction: 1.5 }
            })).toThrow('greater than 0 and at most 1');
            expect(() => evaluatePolymarketStaleness({
                signalAgeMs: 0, msToResolution: DAY, policy: { minBudgetMs: 2, maxBudgetMs: 1 }
            })).toThrow('must not exceed');
        });
    });
    describe('the venue matching delay is charged against the budget', () => {
        it('counts secondsDelay as latency, because an order cannot match until it elapses', () => {
            // `/market-data/market-details` documents `secondsDelay` as the delay before
            // a newly placed marketable order can match, and `/trading/place-orders`
            // returns a `delayed` status for it. Ignoring it would measure freshness at
            // submission when the fill happens later.
            const policy = { maxResolutionFraction: 1, minBudgetMs: 0, maxBudgetMs: 60_000 };
            expect(evaluatePolymarketStaleness({
                signalAgeMs: 55_000, msToResolution: DAY, policy
            }).kind).toBe('fresh');
            expect(evaluatePolymarketStaleness({
                signalAgeMs: 55_000, msToResolution: DAY, matchingDelayMs: 10_000, policy
            })).toMatchObject({ kind: 'stale', effectiveAgeMs: 65_000 });
        });
        it('refuses a negative or non-finite delay rather than ignoring it', () => {
            expect(evaluatePolymarketStaleness({
                signalAgeMs: 0, msToResolution: DAY, matchingDelayMs: -1
            })).toMatchObject({ kind: 'stale', code: 'signal-age-invalid' });
        });
    });
    describe('timestamp adapter', () => {
        it('derives both durations from an injected clock, never Date.now()', () => {
            const now = Date.UTC(2026, 7, 20, 12, 0, 0);
            const decision = evaluatePolymarketSignalStaleness({
                signalAt: new Date(now - 2 * MINUTE),
                resolutionAt: new Date(now + 2 * DAY),
                now,
                matchingDelaySeconds: 30
            });
            expect(decision).toMatchObject({
                kind: 'fresh',
                effectiveAgeMs: 2 * MINUTE + 30_000,
                msToResolution: 2 * DAY
            });
        });
        it('treats a null end date as an unknown resolution time', () => {
            const now = Date.UTC(2026, 7, 20, 12, 0, 0);
            expect(evaluatePolymarketSignalStaleness({
                signalAt: now, resolutionAt: null, now
            })).toMatchObject({ kind: 'stale', code: 'resolution-time-unknown' });
        });
        it('is a boolean through the predicate helper', () => {
            const now = Date.UTC(2026, 7, 20, 12, 0, 0);
            expect(isPolymarketSignalStale({ signalAgeMs: 0, msToResolution: 2 * DAY })).toBe(false);
            expect(isPolymarketSignalStale({ signalAgeMs: 0, msToResolution: null })).toBe(true);
            expect(evaluatePolymarketSignalStaleness({
                signalAt: now - 12 * HOUR, resolutionAt: now + 4 * HOUR, now
            }).kind).toBe('stale');
        });
    });
    describe('environment policy', () => {
        it('defaults to the shipped policy and reads overrides', () => {
            expect(resolvePolymarketStalenessPolicy({})).toEqual({
                maxResolutionFraction: 0.05,
                minBudgetMs: POLYMARKET_DEFAULT_STALENESS_FLOOR_MS,
                maxBudgetMs: POLYMARKET_DEFAULT_STALENESS_CEILING_MS
            });
            expect(resolvePolymarketStalenessPolicy({
                POLYMARKET_STALENESS_RESOLUTION_FRACTION: '0.1',
                POLYMARKET_STALENESS_FLOOR_MS: '5000',
                POLYMARKET_STALENESS_CEILING_MS: '120000'
            })).toEqual({ maxResolutionFraction: 0.1, minBudgetMs: 5_000, maxBudgetMs: 120_000 });
        });
        it('fails at boot on an out-of-range fraction rather than on the first signal', () => {
            expect(() => resolvePolymarketStalenessPolicy({
                POLYMARKET_STALENESS_RESOLUTION_FRACTION: '2'
            })).toThrow('greater than 0 and at most 1');
            expect(() => resolvePolymarketStalenessPolicy({
                POLYMARKET_STALENESS_CEILING_MS: '1000',
                POLYMARKET_STALENESS_FLOOR_MS: '5000'
            })).toThrow('must not exceed');
        });
    });
});
//# sourceMappingURL=polymarket-staleness.test.js.map