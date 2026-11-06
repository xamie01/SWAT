import type { UserTier } from './tiers.js';
export type BillingPlanId = 'operator_monthly' | 'ultra_monthly' | 'lifetime';
export type BillingChain = 'solana' | 'polygon';
export interface BillingPlan {
    readonly id: BillingPlanId;
    readonly name: string;
    readonly tier: UserTier;
    readonly priceUsdc: number;
    /** Duration in calendar days. `null` indicates perpetual/lifetime access. */
    readonly durationDays: number | null;
    readonly description: string;
}
export declare const BILLING_PLANS: Readonly<Record<BillingPlanId, BillingPlan>>;
export declare const USDC_MINTS: {
    readonly solana: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    readonly polygon: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
};
export declare const USDC_DECIMALS = 6;
/** Grace period window in days before an unpaid expired tier is downgraded. */
export declare const BILLING_GRACE_PERIOD_DAYS = 3;
/** Days before expiration to start surfacing renewal reminders. */
export declare const BILLING_RENEWAL_ALERT_DAYS = 7;
/** Returns the plan configuration by ID, or null if invalid. */
export declare function resolveBillingPlan(planId: string): BillingPlan | null;
/**
 * Computes the new tier and expiration date resulting from a verified payment.
 *
 * Rules:
 *  1. Lifetime pass (`durationDays === null`): returns target tier (`ultra`) with `expiresAt = null`.
 *  2. Existing lifetime user (`currentExpiry === null` and `currentTier === 'ultra'`):
 *     keeps lifetime access unchanged.
 *  3. Same tier renewal / stacking: extends from the *current* expiration date by `durationDays`.
 *  4. Upgrade from lower tier (e.g. Free or Operator -> Ultra): starts from `now + durationDays`.
 *  5. Expired user (or Free tier): starts from `now + durationDays`.
 */
export declare function calculateTierExtension(input: {
    currentTier: UserTier;
    currentExpiry: Date | null;
    targetTier: UserTier;
    durationDays: number | null;
    now?: Date;
}): {
    tier: UserTier;
    expiresAt: Date | null;
};
/**
 * Generates an 8-character human-readable deposit reference memo for a user.
 * Format: `SWAT-<6 HEX CHARS>` (e.g. `SWAT-8F3A2B`)
 */
export declare function generateBillingMemo(userId: string): string;
//# sourceMappingURL=billing.d.ts.map