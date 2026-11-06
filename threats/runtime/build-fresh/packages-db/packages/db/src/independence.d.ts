/**
 * Funder independence — is a funding hub a coordination signal, or plumbing?
 *
 * `generateFundingClusters` groups every wallet a funder ever funded into one
 * "Funding Group". With a floor (`>= 2`) and no ceiling, a centralised-exchange
 * hot wallet that funded millions of addresses collapses into a single cluster
 * containing a large slice of the chain. Such a cluster satisfies any
 * co-movement test for anything trending, because at that size *someone* in it
 * is always buying — the cluster stops being evidence of anything.
 *
 * This module is the pure half of the fix: a predicate over one candidate
 * funder. It is deliberately dependency-free (no `./client.js`, no clock) so it
 * is testable with no database, which is the only way any of this logic gets
 * tested at all.
 *
 * The result is a verdict plus a stable reason code, never a boolean, and it
 * keeps three cases apart that a boolean would fuse:
 *
 *   - `independent`   — positively cleared: degree counted, inside the bound,
 *                       and checked against the hub-label list.
 *   - `hub`           — positively rejected.
 *   - `below-minimum` — not a hub, but too small to be a group.
 *   - `unassessed`    — we cannot tell. **Not** a non-hub. Callers that admit
 *                       an `unassessed` funder are choosing to, in the open.
 */
/**
 * Minimum distinct funded wallets before a funder is a "group" at all.
 *
 * Unchanged from the original `HAVING COUNT(DISTINCT wr.wallet_b) >= 2`; named
 * here so the floor and the new ceiling live in one place.
 */
export declare const MIN_FUNDED_WALLETS = 2;
/**
 * Maximum distinct funded wallets a funder may have and still be read as a
 * person-scale funder rather than infrastructure.
 *
 * Chosen from the shape of the two populations, not from a preference:
 *
 *  - The thing being excluded is off by orders of magnitude. An exchange hot
 *    wallet, bridge, or faucet funds 1e4-1e7 distinct addresses. A person who
 *    funded some friends' wallets, or a Sybil operator spinning up a ring,
 *    funds single to low double digits. Any ceiling between ~10 and ~1e3
 *    classifies both populations identically, so the exact value inside that
 *    band cannot change an outcome — which is why the band, not the number, is
 *    the claim being made.
 *
 *  - Inside that band, the confidence formula in `generateFundingClusters`
 *    picks the low end. It is
 *    `LEAST(0.95, AVG(confidence) + 0.05 * (fundedCount - 1))`, which saturates
 *    at 0.95 once `fundedCount` reaches roughly 3 (at a typical edge
 *    confidence of 0.85) to 10 (at 0.5). Past saturation an extra funded wallet
 *    changes nothing the model can express, so the model itself already treats
 *    ~10 as "as coordinated as it gets". A ceiling of 25 sits comfortably above
 *    that — it cannot clip a ring the confidence formula still distinguishes —
 *    while staying three to five orders of magnitude below any exchange.
 *
 *  - Cluster members are the unit the signal engine counts when it looks for
 *    co-movement. 25 wallets is already a large cluster by that standard;
 *    a genuine ring that big is not being missed by a cap set higher.
 *
 * The value is a policy dial, not a measurement, and is overridable per call.
 */
export declare const MAX_FUNDER_DEGREE = 25;
/**
 * What we know about a funder's role, from whatever labelling the pipeline has.
 *
 * `null` means a lookup happened and found nothing. `undefined` (an absent
 * field) means no lookup happened — a different thing, and it is kept different
 * all the way to the verdict.
 */
export type FunderLabel = 
/** CEX hot / deposit / withdrawal wallet. */
'exchange'
/** Cross-chain bridge or its custodian. */
 | 'bridge'
/** Faucet, airdrop distributor, or payroll-style disperser. */
 | 'disperser'
/** Mixer / privacy pool. */
 | 'mixer'
/** Market maker or professional desk. */
 | 'market-maker'
/** A program/contract rather than a user-controlled account. */
 | 'contract'
/** Reviewed and affirmatively believed to be an ordinary wallet. */
 | 'individual';
/**
 * Labels that disqualify a funder outright, whatever its observed degree.
 *
 * This list is why a degree cap alone is not enough. The count available to the
 * cap is degree *as observed in our index* — the wallets SWAT happens to track
 * — not true on-chain degree. If four tracked wallets all withdrew from the
 * same exchange, that exchange's observed degree is 4 and it passes any
 * ceiling. Only the label catches it.
 */
export declare const HUB_FUNDER_LABELS: readonly FunderLabel[];
export type FunderIndependenceVerdict = 
/** Counted, inside the bound, label-checked, not a hub. Safe to cluster. */
'independent'
/** Infrastructure. Must not form a funding cluster. */
 | 'hub'
/** Not a hub, but below the floor at which a funder is a group. */
 | 'below-minimum'
/** Insufficient evidence. Says nothing either way. */
 | 'unassessed';
/** Stable, machine-readable reason. Never reuse a code for a different cause. */
export type FunderIndependenceCode = 
/** Degree counted and within `[min, cap]`, and the label list was checked. */
'degree-within-cap'
/** Observed degree exceeds the ceiling: infrastructure by size. */
 | 'degree-exceeds-cap'
/** Carries a hub label. Beats any observed degree, including a small one. */
 | 'labelled-hub'
/** Fewer funded wallets than `minFundedWallets`. */
 | 'degree-below-minimum'
/** No degree available (never counted, or not a finite non-negative count). */
 | 'degree-unknown'
/** Degree is fine, but the hub-label list was never consulted. */
 | 'hub-label-unchecked';
export interface FunderIndependenceInput {
    /** Chain-prefixed funder address, carried through onto the result. */
    readonly funder: string;
    /**
     * Distinct wallets this funder funded, **as observed in our index**.
     *
     * `null`/`undefined` means not counted. It is not zero, and it is not small:
     * an uncounted funder is `unassessed`, never `independent`.
     */
    readonly observedFundedWalletCount?: number | null;
    /**
     * The funder's role label. Omit the field when no lookup was performed;
     * pass `null` when a lookup returned nothing.
     */
    readonly label?: FunderLabel | null;
}
export interface FunderIndependencePolicy {
    readonly minFundedWallets?: number;
    readonly maxFunderDegree?: number;
    /** Override the disqualifying set (tests, or a chain-specific policy). */
    readonly hubLabels?: readonly FunderLabel[];
}
export interface FunderIndependenceAssessment {
    readonly funder: string;
    readonly verdict: FunderIndependenceVerdict;
    readonly code: FunderIndependenceCode;
    /** Echoed back, normalised to `null` when unusable. */
    readonly observedFundedWalletCount: number | null;
    /** `false` when the caller supplied no `label` field at all. */
    readonly labelChecked: boolean;
    readonly label: FunderLabel | null;
    /** The bound actually applied, so a log line is self-describing. */
    readonly minFundedWallets: number;
    readonly maxFunderDegree: number;
    /** One sentence, for an operator. */
    readonly message: string;
}
export declare class InvalidFunderIndependencePolicyError extends Error {
    constructor(message: string);
}
/**
 * Assess one funder.
 *
 * Precedence is deliberate, strongest evidence first:
 *   1. a hub label — beats a small observed degree, because observed degree
 *      undercounts a hub whose other recipients we do not track;
 *   2. an unusable degree — `unassessed`, never a pass;
 *   3. the ceiling;
 *   4. the floor;
 *   5. an unchecked label — degree is fine but the clearance is incomplete, so
 *      the verdict is `unassessed`, not `independent`.
 *
 * Pure: no database, no clock, no I/O.
 */
export declare function assessFunderIndependence(input: FunderIndependenceInput, policy?: FunderIndependencePolicy): FunderIndependenceAssessment;
/**
 * The only admission rule. A funder forms a funding cluster iff it is
 * positively `independent` — `unassessed` does not qualify.
 */
export declare function admitsFundingCluster(assessment: FunderIndependenceAssessment): boolean;
export interface FunderIndependencePartition {
    readonly independent: readonly FunderIndependenceAssessment[];
    readonly hubs: readonly FunderIndependenceAssessment[];
    readonly belowMinimum: readonly FunderIndependenceAssessment[];
    /**
     * Funders this partition says **nothing** about. Present so an empty `hubs`
     * list cannot be read as "checked everything, all clean".
     */
    readonly unassessed: readonly FunderIndependenceAssessment[];
}
/** Batch form, shaped so a caller cannot lose the `unassessed` bucket. */
export declare function partitionFundersByIndependence(inputs: readonly FunderIndependenceInput[], policy?: FunderIndependencePolicy): FunderIndependencePartition;
//# sourceMappingURL=independence.d.ts.map