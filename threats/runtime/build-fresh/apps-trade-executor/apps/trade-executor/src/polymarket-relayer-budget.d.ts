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
export interface RelayerBudgetStatus {
    readonly allowed: boolean;
    readonly budget: number;
    readonly usedToday: number;
    readonly remaining: number;
    readonly reason?: string;
    readonly code?: 'polymarket-relayer-capacity-exhausted';
}
export declare class PolymarketRelayerBudgetTracker {
    private usedCount;
    private currentDay;
    private readonly budget;
    constructor(budget?: number);
    private resetIfNewDay;
    checkBudget(now?: Date): RelayerBudgetStatus;
    recordExecution(now?: Date): void;
    setUsedForTest(count: number, now?: Date): void;
    reset(): void;
}
export declare const globalPolymarketRelayerBudget: PolymarketRelayerBudgetTracker;
//# sourceMappingURL=polymarket-relayer-budget.d.ts.map