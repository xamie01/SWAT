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
export const MIN_COPY_DEPOSIT_USD = 1.0;

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
export function evaluateLpCopyEligibility(
  subscription: LpCopySubscription,
  event: MasterLpEvent
): CopySizingResult {
  if (subscription.status !== 'active') {
    return {
      eligible: false,
      reason: 'subscription_not_active',
      scaleRatio: 0,
      followerDepositUsd: 0,
      action: event.action
    };
  }

  if (subscription.chain !== event.chain || subscription.venue !== event.venue) {
    return {
      eligible: false,
      reason: `venue_mismatch: subscription is ${subscription.chain}/${subscription.venue}, event is ${event.chain}/${event.venue}`,
      scaleRatio: 0,
      followerDepositUsd: 0,
      action: event.action
    };
  }

  // Forward-Only rule: Discard any position opened before subscription
  if (event.openedAt.getTime() < subscription.createdAt.getTime()) {
    return {
      eligible: false,
      reason: 'forward_only_violation: position was opened before subscription start',
      scaleRatio: 0,
      followerDepositUsd: 0,
      action: event.action
    };
  }

  if (event.action === 'mint' || event.action === 'increase') {
    if (event.masterDepositUsd <= 0) {
      return {
        eligible: false,
        reason: 'zero_master_deposit',
        scaleRatio: 0,
        followerDepositUsd: 0,
        action: event.action
      };
    }

    const proportionalRatio = Math.min(1.0, subscription.allocatedBudgetUsd / event.masterDepositUsd);
    const rawFollowerDeposit = event.masterDepositUsd * proportionalRatio;
    const clampedDeposit = Math.min(rawFollowerDeposit, subscription.maxCapitalPerPositionUsd);

    if (clampedDeposit < MIN_COPY_DEPOSIT_USD) {
      return {
        eligible: false,
        reason: `deposit_below_minimum: calculated ${clampedDeposit.toFixed(2)} USD is under ${MIN_COPY_DEPOSIT_USD} USD minimum`,
        scaleRatio: 0,
        followerDepositUsd: 0,
        action: event.action
      };
    }

    const effectiveScaleRatio = clampedDeposit / event.masterDepositUsd;

    return {
      eligible: true,
      scaleRatio: effectiveScaleRatio,
      followerDepositUsd: clampedDeposit,
      action: event.action
    };
  }

  // For decrease, burn, or collect: follower mirrors proportionally or closes position completely
  return {
    eligible: true,
    scaleRatio: 1.0,
    followerDepositUsd: 0,
    action: event.action
  };
}
