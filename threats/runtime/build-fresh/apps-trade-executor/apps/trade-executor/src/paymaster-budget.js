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
export class PaymasterBudgetTracker {
    globalUsed = 0;
    currentDay = '';
    userUsage = new Map();
    globalDailyCap;
    userDailyCap;
    maxCachedUsers;
    constructor(options) {
        this.globalDailyCap = options?.globalDailyCap ?? Number(process.env.PAYMASTER_DAILY_BUDGET ?? 10_000);
        this.userDailyCap = options?.userDailyCap ?? Number(process.env.PAYMASTER_USER_DAILY_LIMIT ?? 50);
        this.maxCachedUsers = options?.maxCachedUsers ?? 5_000;
    }
    resetIfNewDay(now) {
        const today = now.toISOString().slice(0, 10);
        if (this.currentDay !== today) {
            this.currentDay = today;
            this.globalUsed = 0;
            this.userUsage.clear();
        }
    }
    evictOldestIfFull() {
        if (this.userUsage.size >= this.maxCachedUsers) {
            // Map iterator yields oldest inserted key first
            const oldestKey = this.userUsage.keys().next().value;
            if (oldestKey !== undefined) {
                this.userUsage.delete(oldestKey);
            }
        }
    }
    checkBudget(userId, now = new Date()) {
        this.resetIfNewDay(now);
        const userCount = this.userUsage.get(userId) ?? 0;
        const remainingGlobal = Math.max(0, this.globalDailyCap - this.globalUsed);
        const remainingUser = Math.max(0, this.userDailyCap - userCount);
        if (this.globalUsed >= this.globalDailyCap) {
            return {
                allowed: false,
                remainingGlobal: 0,
                remainingUser,
                code: 'paymaster-global-budget-exhausted',
                reason: `Paymaster global daily sponsored budget exhausted (${this.globalUsed}/${this.globalDailyCap} used)`
            };
        }
        if (userCount >= this.userDailyCap) {
            return {
                allowed: false,
                remainingGlobal,
                remainingUser: 0,
                code: 'paymaster-user-rate-limited',
                reason: `Paymaster user daily sponsored operation limit exceeded for ${userId} (${userCount}/${this.userDailyCap} used)`
            };
        }
        return {
            allowed: true,
            remainingGlobal,
            remainingUser
        };
    }
    recordOperation(userId, now = new Date()) {
        this.resetIfNewDay(now);
        this.globalUsed += 1;
        const currentCount = this.userUsage.get(userId) ?? 0;
        if (!this.userUsage.has(userId)) {
            this.evictOldestIfFull();
        }
        else {
            // Re-insert to refresh LRU recency
            this.userUsage.delete(userId);
        }
        this.userUsage.set(userId, currentCount + 1);
    }
    // Diagnostics / testing helpers
    getGlobalUsedToday(now = new Date()) {
        this.resetIfNewDay(now);
        return this.globalUsed;
    }
    getUserUsedToday(userId, now = new Date()) {
        this.resetIfNewDay(now);
        return this.userUsage.get(userId) ?? 0;
    }
    getCachedUserCount() {
        return this.userUsage.size;
    }
}
export const globalPaymasterBudget = new PaymasterBudgetTracker();
//# sourceMappingURL=paymaster-budget.js.map