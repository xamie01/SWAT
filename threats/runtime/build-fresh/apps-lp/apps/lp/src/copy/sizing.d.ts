import type { LpChain, LpProtocol } from '@swat/shared';
import type { LpCopyAction, LpCopySubscription } from '@swat/db';
export interface MasterLpEvent {
    readonly masterWalletAddress: string;
    readonly chain: LpChain;
    readonly venue: LpProtocol;
    readonly masterPositionId: string;
    readonly poolAddress: string;
    readonly action: LpCopyAction;
    readonly masterDepositUsd: number;
    readonly openedAt: Date;
    readonly rangeLower?: number;
    readonly rangeUpper?: number;
    readonly minBinId?: number;
    readonly maxBinId?: number;
    readonly tickLower?: number;
    readonly tickUpper?: number;
}
export interface CopySizingResult {
    readonly eligible: boolean;
    readonly reason?: string;
    readonly scaleRatio: number;
    readonly followerDepositUsd: number;
    readonly action: LpCopyAction;
}
/** Minimum dollar value required to execute an LP copy mint (avoids micro-dust positions) */
export declare const MIN_COPY_DEPOSIT_USD = 1;
/**
 * Pure forward-only copy-trading sizing evaluator.
 *
 * Rules enforced:
 *  1. Subscription must be in 'active' state.
 *  2. Venue and chain must match the subscription.
 *  3. Forward-Only Guarantee: The master position's opening timestamp MUST be
 *     equal to or strictly after the follower's subscription creation time.
 *     Any position opened before subscription is rejected to prevent entering
 *     at stale, out-of-range, or disadvantageous entry prices.
 *  4. Proportional Sizing:
 *     ratio = min(1.0, userBudget / masterDeposit)
 *     followerDeposit = min(ratio * masterDeposit, maxCapitalPerPosition)
 *     scaleRatio = followerDeposit / masterDeposit
 */
export declare function evaluateLpCopyEligibility(subscription: LpCopySubscription, event: MasterLpEvent): CopySizingResult;
//# sourceMappingURL=sizing.d.ts.map