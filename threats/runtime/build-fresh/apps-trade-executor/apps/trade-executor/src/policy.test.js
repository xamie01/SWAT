import { describe, expect, it } from 'vitest';
import { calculateBalanceAwareSize, calculateRiskBasedSize, capPositionToAvailableBalance, floorToPrecision, parseNonNegativeNumber, parsePositiveNumber, parseScore, parseTradingMode } from './policy.js';
describe('parseTradingMode', () => {
    it('defaults only an absent value to paper', () => {
        expect(parseTradingMode(undefined)).toBe('paper');
    });
    it('accepts exact supported values', () => {
        expect(parseTradingMode('paper')).toBe('paper');
        expect(parseTradingMode('live')).toBe('live');
    });
    it.each(['Paper', 'live ', '', 'test'])('rejects unsafe mode %j', (value) => {
        expect(() => parseTradingMode(value)).toThrow(/must be exactly/);
    });
});
describe('numeric policy validation', () => {
    it('accepts bounded scores and rejects missing or invalid scores', () => {
        expect(parseScore(0, 'score')).toBe(0);
        expect(parseScore('85', 'score')).toBe(85);
        expect(() => parseScore(undefined, 'score')).toThrow();
        expect(() => parseScore(null, 'score')).toThrow();
        expect(() => parseScore('', 'score')).toThrow();
        expect(() => parseScore(' 85', 'score')).toThrow();
        expect(() => parseScore(Number.NaN, 'score')).toThrow();
        expect(() => parseScore(101, 'score')).toThrow();
    });
    it('requires positive finite configuration numbers', () => {
        expect(parsePositiveNumber(undefined, 15_000, 'timeout')).toBe(15_000);
        expect(() => parsePositiveNumber('0', 15_000, 'timeout')).toThrow();
        expect(parseNonNegativeNumber('0', 60, 'cooldown')).toBe(0);
        expect(() => parseNonNegativeNumber('-1', 60, 'cooldown')).toThrow();
    });
});
describe('calculateRiskBasedSize', () => {
    it('sizes down for small balances instead of applying a static floor', () => {
        expect(calculateRiskBasedSize({
            balance: 20,
            riskPct: 2,
            tierMultiplier: 1,
            scoreMultiplier: 1,
            maximum: 500,
            precision: 2
        })).toBe(0.4);
    });
    it('never exceeds the configured maximum or available balance', () => {
        expect(calculateRiskBasedSize({
            balance: 100_000,
            riskPct: 100,
            tierMultiplier: 1,
            scoreMultiplier: 1,
            maximum: 500,
            precision: 2
        })).toBe(500);
        expect(calculateRiskBasedSize({
            balance: 0.001,
            riskPct: 100,
            tierMultiplier: 1,
            scoreMultiplier: 1,
            maximum: 0.5,
            precision: 6
        })).toBe(0.001);
    });
    it('floors rather than rounds above a sub-precision balance', () => {
        expect(floorToPrecision(0.0000009, 6)).toBe(0);
        expect(capPositionToAvailableBalance({
            requested: 100,
            available: 20.009,
            maximum: 500,
            precision: 2
        })).toBe(20);
    });
    it('caps static sizing to the available balance when dynamic sizing is disabled', () => {
        expect(calculateBalanceAwareSize({
            balance: 20,
            base: 100,
            maximum: 500,
            riskPct: 2,
            tierMultiplier: 1,
            scoreMultiplier: 1,
            precision: 2,
            dynamic: false
        })).toBe(20);
    });
    it('uses risk-based sizing when dynamic sizing is enabled', () => {
        expect(calculateBalanceAwareSize({
            balance: 20,
            base: 100,
            maximum: 500,
            riskPct: 2,
            tierMultiplier: 1,
            scoreMultiplier: 1,
            precision: 2,
            dynamic: true
        })).toBe(0.4);
    });
});
//# sourceMappingURL=policy.test.js.map