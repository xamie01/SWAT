/**
 * Pool exposure cap (Track G1) — the pure decision the deploy guard runs
 * before any ladder build commits.
 *
 * Semantics: a user's open LP positions may not put more than
 * `maxPoolAllocationPct` percent of their deployed LP capital into one pool.
 * The check runs on the *post-deploy* totals — the requested deposit counts
 * toward the pool's exposure — and returns the largest allowed top-up when the
 * request must be capped, so the caller can either refuse outright or size
 * down transparently.
 *
 * When the user has nothing else deployed, the cap degenerates gracefully:
 * the first deposit defines the base (deployed = requested), which always
 * satisfies a ≤ 100% cap.
 */
export interface PoolExposureInput {
    /** Sum of the user's open LP deposits across all pools (excludes closed). */
    readonly deployedUsd: number;
    /** The user's current open exposure to this specific pool. */
    readonly poolExposureUsd: number;
    /** The deposit being requested now. */
    readonly requestedUsd: number;
    /** Guardrail config percent, (0..100]. */
    readonly maxPoolAllocationPct: number;
}
export interface PoolExposureDecision {
    readonly allowed: boolean;
    /** The deposit that would pass, given the cap (equal to requested when allowed). */
    readonly allowedAmountUsd: number;
    /** Post-deploy share of the pool in the deployed base, as a fraction. */
    readonly projectedPoolShare: number;
    readonly reasons: readonly string[];
}
export declare function evaluatePoolExposureCap(input: PoolExposureInput): PoolExposureDecision;
//# sourceMappingURL=exposure-cap.d.ts.map