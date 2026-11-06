import { describe, expect, it } from 'vitest';
import { PaymasterBudgetTracker } from './paymaster-budget.js';
describe('PaymasterBudgetTracker (S4-P8)', () => {
    it('allows operations within both user and global budget', () => {
        const tracker = new PaymasterBudgetTracker({
            globalDailyCap: 100,
            userDailyCap: 5
        });
        const now = new Date('2026-10-29T10:00:00Z');
        const check = tracker.checkBudget('user-alice', now);
        expect(check.allowed).toBe(true);
        expect(check.remainingGlobal).toBe(100);
        expect(check.remainingUser).toBe(5);
        expect(check.code).toBeUndefined();
    });
    it('blocks the N+1st operation when user daily limit is reached (S4-P8 acceptance)', () => {
        const userLimit = 3;
        const tracker = new PaymasterBudgetTracker({
            globalDailyCap: 100,
            userDailyCap: userLimit
        });
        const now = new Date('2026-10-29T10:00:00Z');
        // Perform N allowed operations
        for (let i = 0; i < userLimit; i++) {
            const check = tracker.checkBudget('user-alice', now);
            expect(check.allowed).toBe(true);
            expect(check.remainingUser).toBe(userLimit - i);
            tracker.recordOperation('user-alice', now);
        }
        // N+1st operation must be rejected with skip reason and code
        const rejected = tracker.checkBudget('user-alice', now);
        expect(rejected.allowed).toBe(false);
        expect(rejected.code).toBe('paymaster-user-rate-limited');
        expect(rejected.remainingUser).toBe(0);
        expect(rejected.remainingGlobal).toBe(97);
        expect(rejected.reason).toContain('Paymaster user daily sponsored operation limit exceeded');
        expect(rejected.reason).toContain('user-alice');
        // Other users are not affected
        const bobCheck = tracker.checkBudget('user-bob', now);
        expect(bobCheck.allowed).toBe(true);
        expect(bobCheck.remainingUser).toBe(userLimit);
    });
    it('blocks all users when the global daily budget is exhausted', () => {
        const globalCap = 2;
        const tracker = new PaymasterBudgetTracker({
            globalDailyCap: globalCap,
            userDailyCap: 10
        });
        const now = new Date('2026-10-29T10:00:00Z');
        tracker.recordOperation('user-alice', now);
        tracker.recordOperation('user-bob', now);
        const checkAlice = tracker.checkBudget('user-alice', now);
        expect(checkAlice.allowed).toBe(false);
        expect(checkAlice.code).toBe('paymaster-global-budget-exhausted');
        expect(checkAlice.remainingGlobal).toBe(0);
        expect(checkAlice.reason).toContain('Paymaster global daily sponsored budget exhausted');
        const checkCharlie = tracker.checkBudget('user-charlie', now);
        expect(checkCharlie.allowed).toBe(false);
        expect(checkCharlie.code).toBe('paymaster-global-budget-exhausted');
    });
    it('resets usage on day boundary (UTC)', () => {
        const tracker = new PaymasterBudgetTracker({
            globalDailyCap: 5,
            userDailyCap: 2
        });
        const day1 = new Date('2026-10-29T23:59:00Z');
        tracker.recordOperation('user-alice', day1);
        tracker.recordOperation('user-alice', day1);
        expect(tracker.checkBudget('user-alice', day1).allowed).toBe(false);
        // Day transition
        const day2 = new Date('2026-10-30T00:01:00Z');
        const day2Check = tracker.checkBudget('user-alice', day2);
        expect(day2Check.allowed).toBe(true);
        expect(day2Check.remainingUser).toBe(2);
        expect(day2Check.remainingGlobal).toBe(5);
    });
    it('bounds memory by evicting oldest users when reaching maxCachedUsers (S4-P3 discipline)', () => {
        const tracker = new PaymasterBudgetTracker({
            globalDailyCap: 100,
            userDailyCap: 10,
            maxCachedUsers: 3
        });
        const now = new Date('2026-10-29T10:00:00Z');
        tracker.recordOperation('user-1', now);
        tracker.recordOperation('user-2', now);
        tracker.recordOperation('user-3', now);
        expect(tracker.getCachedUserCount()).toBe(3);
        // Adding 4th user evicts oldest (user-1)
        tracker.recordOperation('user-4', now);
        expect(tracker.getCachedUserCount()).toBe(3);
        // user-1 was evicted, so checking user-1 treats them as clean fresh count
        expect(tracker.getUserUsedToday('user-1', now)).toBe(0);
        expect(tracker.getUserUsedToday('user-2', now)).toBe(1);
        expect(tracker.getUserUsedToday('user-4', now)).toBe(1);
    });
});
//# sourceMappingURL=paymaster-budget.test.js.map