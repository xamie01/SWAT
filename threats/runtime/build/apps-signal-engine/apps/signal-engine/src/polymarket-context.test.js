import { describe, expect, it } from 'vitest';
import { isPlaceholderOrUnstableOutcome, requirePolymarketSignalContext } from './polymarket-context.js';
const TOKEN_ID = `polygon:${'1'.repeat(40)}`;
const context = {
    tokenId: TOKEN_ID,
    conditionId: `0x${'a'.repeat(64)}`,
    outcome: 'Yes',
    outcomeIndex: 0,
    question: 'Will the fixture pass?',
    slug: 'fixture-pass',
    endDate: new Date('2026-08-01T00:00:00Z'),
    marketStatus: 'active',
    tickSize: '0.01',
    negRisk: false,
    acceptingOrders: true,
    resolutionStatus: 'unresolved',
    contextComplete: true
};
describe('Polymarket signal context', () => {
    it('includes every required market field', () => {
        expect(requirePolymarketSignalContext(context, TOKEN_ID)).toEqual({
            tokenName: 'Will the fixture pass?',
            tokenSymbol: 'YES',
            triggerData: {
                pmConditionId: context.conditionId,
                pmQuestion: context.question,
                pmOutcome: context.outcome,
                pmEndDate: '2026-08-01T00:00:00.000Z',
                pmState: 'active',
                pmTickSize: '0.01',
                pmNegRisk: false,
                pmAcceptingOrders: true,
                pmResolutionStatus: 'unresolved'
            }
        });
    });
    it('fails closed for missing or incomplete context', () => {
        expect(() => requirePolymarketSignalContext(null, TOKEN_ID)).toThrow(/Missing complete/);
        expect(() => requirePolymarketSignalContext({
            ...context,
            contextComplete: false
        }, TOKEN_ID)).toThrow(/Missing complete/);
        expect(() => requirePolymarketSignalContext({
            ...context,
            question: ''
        }, TOKEN_ID)).toThrow(/Incomplete/);
    });
});
describe('Polymarket augmented neg-risk placeholder evaluation (S4-M30)', () => {
    it('allows all outcomes in standard binary or non-augmented markets', () => {
        const standardEvent = { enableNegRisk: true, negRiskAugmented: false };
        expect(isPlaceholderOrUnstableOutcome(standardEvent, { outcome: 'Other' })).toEqual({
            isPlaceholder: false
        });
        expect(isPlaceholderOrUnstableOutcome(standardEvent, { outcome: 'Person A' })).toEqual({
            isPlaceholder: false
        });
        expect(isPlaceholderOrUnstableOutcome(standardEvent, { outcome: 'Alice Smith' })).toEqual({
            isPlaceholder: false
        });
    });
    it('identifies and rejects explicit dynamic "Other" on augmented neg-risk events', () => {
        const augmentedEvent = { enableNegRisk: true, negRiskAugmented: true };
        const result = isPlaceholderOrUnstableOutcome(augmentedEvent, { outcome: 'Other' });
        expect(result.isPlaceholder).toBe(true);
        expect(result.code).toBe('polymarket-augmented-placeholder-unstable');
        expect(result.reason).toContain('legally changes definition');
    });
    it('identifies and rejects unclarified placeholder slots on augmented neg-risk events', () => {
        const augmentedEvent = { enableNegRisk: true, negRiskAugmented: true };
        const personA = isPlaceholderOrUnstableOutcome(augmentedEvent, { outcome: 'Person A' });
        expect(personA.isPlaceholder).toBe(true);
        expect(personA.code).toBe('polymarket-placeholder-unnamed');
        const candidateX = isPlaceholderOrUnstableOutcome(augmentedEvent, { outcome: 'Candidate 2' });
        expect(candidateX.isPlaceholder).toBe(true);
        expect(candidateX.code).toBe('polymarket-placeholder-unnamed');
        const genericPlaceholder = isPlaceholderOrUnstableOutcome(augmentedEvent, { outcome: 'TBD Placeholder' });
        expect(genericPlaceholder.isPlaceholder).toBe(true);
        expect(genericPlaceholder.code).toBe('polymarket-placeholder-unnamed');
    });
    it('allows established named candidates in augmented neg-risk events', () => {
        const augmentedEvent = { enableNegRisk: true, negRiskAugmented: true };
        const alice = isPlaceholderOrUnstableOutcome(augmentedEvent, { outcome: 'Alice Smith' });
        expect(alice.isPlaceholder).toBe(false);
        const bob = isPlaceholderOrUnstableOutcome(augmentedEvent, {
            outcome: 'Yes',
            groupItemTitle: 'Bob Jones'
        });
        expect(bob.isPlaceholder).toBe(false);
    });
});
//# sourceMappingURL=polymarket-context.test.js.map