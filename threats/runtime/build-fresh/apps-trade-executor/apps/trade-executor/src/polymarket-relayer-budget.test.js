import { describe, expect, it } from 'vitest';
import { PolymarketRelayerBudgetTracker } from './polymarket-relayer-budget.js';
describe('Polymarket Relayer Daily Budget Enforcement (S4-P15)', () => {
    it('allows operations when below the configured daily limit', () => {
        const tracker = new PolymarketRelayerBudgetTracker(100);
        const status = tracker.checkBudget();
        expect(status.allowed).toBe(true);
        expect(status.budget).toBe(100);
        expect(status.usedToday).toBe(0);
        expect(status.remaining).toBe(100);
    });
    it('tracks execution counts and decrements remaining budget', () => {
        const tracker = new PolymarketRelayerBudgetTracker(10);
        tracker.recordExecution();
        tracker.recordExecution();
        const status = tracker.checkBudget();
        expect(status.allowed).toBe(true);
        expect(status.usedToday).toBe(2);
        expect(status.remaining).toBe(8);
    });
    it('refuses the N+1st operation when budget is reached with actionable code', () => {
        const tracker = new PolymarketRelayerBudgetTracker(3);
        tracker.recordExecution();
        tracker.recordExecution();
        tracker.recordExecution();
        const status = tracker.checkBudget();
        expect(status.allowed).toBe(false);
        expect(status.remaining).toBe(0);
        expect(status.code).toBe('polymarket-relayer-capacity-exhausted');
        expect(status.reason).toContain('Polymarket daily relayer capacity exhausted (3/3 used)');
    });
    it('resets budget on a new UTC calendar day', () => {
        const tracker = new PolymarketRelayerBudgetTracker(5);
        const day1 = new Date('2026-10-28T23:59:00Z');
        const day2 = new Date('2026-10-29T00:01:00Z');
        tracker.checkBudget(day1);
        tracker.recordExecution(day1);
        tracker.recordExecution(day1);
        expect(tracker.checkBudget(day1).usedToday).toBe(2);
        // On day 2, should reset to 0
        const day2Status = tracker.checkBudget(day2);
        expect(day2Status.allowed).toBe(true);
        expect(day2Status.usedToday).toBe(0);
        expect(day2Status.remaining).toBe(5);
    });
    it('defaults to 10,000 operations when no budget is specified', () => {
        const tracker = new PolymarketRelayerBudgetTracker();
        expect(tracker.checkBudget().budget).toBe(10_000);
    });
});
//# sourceMappingURL=polymarket-relayer-budget.test.js.map