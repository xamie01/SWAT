import { describe, expect, it } from 'vitest';
import { TRADE_ELIGIBLE_PATTERNS, mayPatternTrade } from './trade-eligibility.js';
/**
 * These tests exist to make ADR-0005 §6.1 hard to undo by accident.
 *
 * The previous shape of this decision was `suppressTrade: true` passed by each
 * cluster detector — four independent literals, none of which any test could
 * reach, because the detectors query the database directly and `index.ts` starts
 * timers at import. Deleting one would have silently resumed trading on a signal
 * whose own definition guarantees it fires.
 */
describe('trade eligibility by signal pattern', () => {
    it('lets a master trade be copied', () => {
        // `source_trade` is the whole product: one wallet a user chose, mirrored.
        expect(mayPatternTrade('source_trade')).toBe(true);
    });
    it.each(['snipe', 'accumulation', 'rotation', 'exit'])('refuses to trade the %s cluster pattern', (pattern) => {
        expect(mayPatternTrade(pattern)).toBe(false);
    });
    it('is exactly one pattern, so widening it cannot pass unnoticed', () => {
        // Asserting the whole list rather than individual members. A new pattern that
        // may trade has to change this line, which puts the decision in a diff a
        // reviewer will see, next to a test name explaining why it matters.
        expect([...TRADE_ELIGIBLE_PATTERNS]).toEqual(['source_trade']);
    });
    it('fails closed on a pattern it does not recognise', () => {
        // `enqueueSignal` types `patternType` as `string`, so an unrecognised value
        // reaches this function without a compile error. Alerting on something we
        // cannot classify is fine; trading on it is not.
        expect(mayPatternTrade('cluster_consensus')).toBe(false);
        expect(mayPatternTrade('')).toBe(false);
        expect(mayPatternTrade('SOURCE_TRADE')).toBe(false); // case-sensitive by design
    });
    it('cannot be widened at runtime', () => {
        // `readonly` is a compile-time claim and types vanish at runtime, but this
        // gate decides whether money moves. Two independent protections, both checked
        // here: the exported list is frozen, and the internal lookup is a copy — so
        // even a caster who defeats the first cannot reach the second.
        const escaped = TRADE_ELIGIBLE_PATTERNS;
        expect(() => escaped.push('snipe')).toThrow(TypeError);
        expect(Object.isFrozen(TRADE_ELIGIBLE_PATTERNS)).toBe(true);
        expect(mayPatternTrade('snipe')).toBe(false);
    });
});
//# sourceMappingURL=trade-eligibility.test.js.map