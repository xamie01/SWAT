/**
 * Paymaster spend cap and per-user rate limit (S4-P8).
 *
 * Sponsoring gas for 4337 UserOperations turns every copied trade into an
 * operating cost we pay. Without caps, an untrusted user subscribing to a
 * hyperactive master wallet can drain the Gas Manager policy.
 *
 * Implements two tiers of bounds:
 *  1. Per-user daily limit (default 50 ops/day, PAYMASTER_USER_DAILY_LIMIT).
 *  2. Global daily policy ceiling (default 10,000 ops/day, PAYMASTER_DAILY_BUDGET).
 *
 * Memory-bounded:
 *  Uses an LRU-evicting Map with a max entries limit (default 5,000,
 *  matching S4-P3 bounded risk-policy cache) to prevent unbounded memory growth
 *  keyed by user ID within the executor process.
 */
export type PaymasterExhaustionCode = 'paymaster-user-rate-limited' | 'paymaster-global-budget-exhausted';
export interface PaymasterBudgetCheckResult {
    readonly allowed: boolean;
    readonly remainingGlobal: number;
    readonly remainingUser: number;
    readonly code?: PaymasterExhaustionCode;
    readonly reason?: string;
}
export interface PaymasterBudgetOptions {
    readonly globalDailyCap?: number;
    readonly userDailyCap?: number;
    readonly maxCachedUsers?: number;
}
export declare class PaymasterBudgetTracker {
    private globalUsed;
    private currentDay;
    private readonly userUsage;
    private readonly globalDailyCap;
    private readonly userDailyCap;
    private readonly maxCachedUsers;
    constructor(options?: PaymasterBudgetOptions);
    private resetIfNewDay;
    private evictOldestIfFull;
    checkBudget(userId: string, now?: Date): PaymasterBudgetCheckResult;
    recordOperation(userId: string, now?: Date): void;
    getGlobalUsedToday(now?: Date): number;
    getUserUsedToday(userId: string, now?: Date): number;
    getCachedUserCount(): number;
}
export declare const globalPaymasterBudget: PaymasterBudgetTracker;
//# sourceMappingURL=paymaster-budget.d.ts.map