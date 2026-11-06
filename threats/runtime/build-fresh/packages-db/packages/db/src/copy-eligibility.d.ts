import type { Chain } from '@swat/shared';
/**
 * Facts the copy-eligibility policy needs about a canonical signal's source,
 * read once at the claim boundary.
 *
 * These are deliberately read fresh rather than carried on the trade job. The
 * signal-engine already filters on `wallets.status = 'active'` when it emits a
 * candidate, but the nightly scorer sweep can pause a wallet in between — so by
 * the time the executor claims, the emit-time snapshot may be hours stale and
 * describe a source we no longer follow.
 */
export interface CopyEligibilityFacts {
    signalId: string;
    signalStatus: string;
    chain: Chain;
    walletAddress: string;
    /** A `wallets` row exists for the source address at all. */
    walletKnown: boolean;
    /** `wallets.status`; empty string when the wallet is unknown. */
    walletStatus: string;
    walletTradeCount: number;
    /** The source wallet belongs to at least one cluster that is still active. */
    clusterSelected: boolean;
    /** Confirmed USD this wallet traded inside the activity lookback window. */
    sourceActivityUsd: number;
    eventAt: Date;
}
export interface CopyEligibilityRejection {
    account: string;
    signalId: string;
    chain: Chain;
    walletAddress: string | null;
    reasons: string[];
    rejectedAt?: Date;
}
/**
 * Load the source facts for a canonical signal, or `null` when the signal is
 * not linked to a source trade. A `null` result is not "eligible by default":
 * the caller must treat an absent fact set as a rejection, because a signal
 * with no observable source is exactly the case we cannot vouch for.
 */
export declare function loadCopyEligibilityFacts(input: {
    signalId: string;
    activityLookbackMs: number;
    now?: Date;
}): Promise<CopyEligibilityFacts | null>;
/**
 * Persist why a signal was refused and take it out of the claimable set.
 *
 * Both writes happen in one transaction. Recording the reason without marking
 * the signal would let the next queue retry re-run the same rejected policy,
 * and marking it without recording the reason would leave an operator with a
 * `rejected` row and no way to tell which gate fired.
 *
 * The status update is deliberately narrow: only a signal that is still
 * awaiting a claim is moved. A signal already `executing` or `executed` has
 * money behind it and must not be rewritten by a policy pass.
 */
export declare function recordCopyEligibilityRejection(input: CopyEligibilityRejection): Promise<boolean>;
//# sourceMappingURL=copy-eligibility.d.ts.map