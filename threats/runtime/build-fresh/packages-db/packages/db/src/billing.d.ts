import { type BillingChain, type BillingPlanId, type UserTier } from '@swat/shared';
import type { UserScope } from './tenancy.js';
export declare class DuplicatePaymentTransactionError extends Error {
    readonly chain: BillingChain;
    readonly txHash: string;
    constructor(chain: BillingChain, txHash: string);
}
export declare class InvalidBillingPlanError extends Error {
    readonly planId: string;
    constructor(planId: string);
}
export declare class UnderpaidPaymentError extends Error {
    readonly expectedUsdc: number;
    readonly receivedUsdc: number;
    constructor(expectedUsdc: number, receivedUsdc: number);
}
export interface CryptoPaymentRecord {
    readonly id: string;
    readonly userId: string;
    readonly chain: BillingChain;
    readonly txHash: string;
    readonly amountUsdc: number;
    readonly tier: UserTier;
    readonly planId: BillingPlanId;
    readonly durationDays: number | null;
    readonly payerAddress: string | null;
    readonly treasuryAddress: string;
    readonly memo: string | null;
    readonly status: 'confirmed' | 'underpaid' | 'refund_requested';
    readonly confirmedAt: Date;
}
export interface PaymentIntentRecord {
    readonly id: string;
    readonly userId: string;
    readonly referenceMemo: string;
    readonly planId: BillingPlanId;
    readonly tier: UserTier;
    readonly expectedAmountUsdc: number;
    readonly status: 'pending' | 'completed' | 'expired';
    readonly expiresAt: Date;
    readonly createdAt: Date;
}
export interface UserBillingStatus {
    readonly tier: UserTier;
    readonly effectiveTier: UserTier;
    readonly tierExpiresAt: Date | null;
    readonly isLifetime: boolean;
    readonly daysRemaining: number | null;
    readonly inGracePeriod: boolean;
    readonly renewalAlert: boolean;
}
/**
 * Creates a pending payment intent with a unique reference memo for a user.
 */
export declare function createPaymentIntent(scope: UserScope, planId: BillingPlanId): Promise<PaymentIntentRecord>;
/**
 * Confirms an on-chain crypto payment, records the payment receipt, and upgrades
 * or extends the user's tier inside an atomic database transaction.
 */
export declare function recordCryptoPaymentAndGrantTier(input: {
    scope: UserScope;
    chain: BillingChain;
    txHash: string;
    amountUsdc: number;
    planId: BillingPlanId;
    payerAddress?: string | null;
    treasuryAddress: string;
    memo?: string | null;
    now?: Date;
}): Promise<{
    payment: CryptoPaymentRecord;
    updatedTier: UserTier;
    updatedExpiresAt: Date | null;
}>;
/**
 * Returns a user's current billing and subscription state.
 */
export declare function getUserBillingStatus(scope: UserScope, now?: Date): Promise<UserBillingStatus>;
/**
 * Lists past payments for a user.
 */
export declare function listUserCryptoPayments(scope: UserScope): Promise<CryptoPaymentRecord[]>;
/**
 * Nightly downgrade sweep.
 *
 * Scans users whose subscriptions have expired beyond the 3-day grace period,
 * downgrades their tier back to 'free', and writes strict audit logs.
 */
export declare function runTierDowngradeSweep(now?: Date): Promise<{
    downgradedCount: number;
    downgradedUserIds: string[];
}>;
//# sourceMappingURL=billing.d.ts.map