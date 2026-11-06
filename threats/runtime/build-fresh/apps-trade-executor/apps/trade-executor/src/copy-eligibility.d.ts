import type { CopyEligibilityFacts, CopyEligibilityRejection } from '@swat/db';
import type { Chain } from '@swat/shared';
/**
 * The copy-eligibility policy for the canonical claim boundary.
 *
 * Everything else in `handleJob` asks "can this trade be executed safely?" —
 * balances, exposure caps, chain readiness, token safety. Nothing asked the
 * prior question: "do we still follow the wallet that produced this signal, and
 * has it done enough for us to have an opinion about it?" The signal-engine
 * checks selection when it *emits* a candidate, but the nightly scorer sweep
 * pauses underperforming wallets, and a signal that sat in the queue across
 * that sweep would still be copied from a source we have since dropped.
 *
 * This runs before the claim rather than after it on purpose. Claiming first
 * and rejecting after would burn the signal's one-shot canonical claim and
 * leave a `requested` execution row that has to be cancelled — extra lifecycle
 * state for a trade we were never going to place.
 */
/** Operator account this policy runs for (Standing Rule 2). */
export declare const COPY_ELIGIBILITY_ACCOUNT = "operator";
export interface CopyEligibilityThresholds {
    /** Reject a source event older than this — the price it implies is gone. */
    maxEventAgeMs: number;
    /** Tolerance for an indexer clock running ahead of ours. */
    maxClockSkewMs: number;
    /** Confirmed USD the source wallet must have traded in the lookback window. */
    minimumSourceActivityUsd: number;
    /** Lifetime recorded trades the source wallet must have. */
    minimumSourceTradeCount: number;
    /** How far back `minimumSourceActivityUsd` is measured. */
    activityLookbackMs: number;
}
export type CopyEligibilityDecision = {
    allowed: true;
    facts: CopyEligibilityFacts;
} | {
    allowed: false;
    reasons: string[];
};
export interface CopyEligibilityDependencies {
    loadFacts: (input: {
        signalId: string;
        activityLookbackMs: number;
        now: Date;
    }) => Promise<CopyEligibilityFacts | null>;
    recordRejection: (input: CopyEligibilityRejection) => Promise<unknown>;
    thresholds: CopyEligibilityThresholds;
    now?: () => Date;
}
export declare function enforceCopyEligibility(input: {
    account: string;
    signalId: string;
    chain: Chain;
}, dependencies: CopyEligibilityDependencies): Promise<CopyEligibilityDecision>;
//# sourceMappingURL=copy-eligibility.d.ts.map