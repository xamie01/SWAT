/**
 * Daily relayer budget tracker for Polymarket Builder executions (S4-P15).
 *
 * Polymarket grants 10,000 builder executions/day. Relayer transactions cover
 * orders, approvals, and settlements.
 *
 * Bounded: tracks usage in a calendar day (UTC). When remaining budget drops to 0,
 * checks fail-closed with explicit code `polymarket-relayer-capacity-exhausted`
 * and skip-with-reason, rather than firing requests that burst into venue rejections.
 *
 * Configurable via `POLYMARKET_RELAYER_DAILY_BUDGET` (scales with growth, not a literal).
 */
export class PolymarketRelayerBudgetTracker {
    usedCount = 0;
    currentDay = '';
    budget;
    constructor(budget) {
        this.budget = budget ?? Number(process.env.POLYMARKET_RELAYER_DAILY_BUDGET ?? 10_000);
    }
    resetIfNewDay(now = new Date()) {
        const today = now.toISOString().slice(0, 10);
        if (this.currentDay !== today) {
            this.currentDay = today;
            this.usedCount = 0;
        }
    }
    checkBudget(now = new Date()) {
        this.resetIfNewDay(now);
        const remaining = Math.max(0, this.budget - this.usedCount);
        if (this.usedCount >= this.budget) {
            return {
                allowed: false,
                budget: this.budget,
                usedToday: this.usedCount,
                remaining: 0,
                code: 'polymarket-relayer-capacity-exhausted',
                reason: `Polymarket daily relayer capacity exhausted (${this.usedCount}/${this.budget} used)`
            };
        }
        return {
            allowed: true,
            budget: this.budget,
            usedToday: this.usedCount,
            remaining
        };
    }
    recordExecution(now = new Date()) {
        this.resetIfNewDay(now);
        this.usedCount += 1;
    }
    setUsedForTest(count, now = new Date()) {
        this.currentDay = now.toISOString().slice(0, 10);
        this.usedCount = count;
    }
    reset() {
        this.usedCount = 0;
        this.currentDay = '';
    }
}
export const globalPolymarketRelayerBudget = new PolymarketRelayerBudgetTracker();
//# sourceMappingURL=polymarket-relayer-budget.js.map