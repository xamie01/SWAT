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
function assertNonNegative(name, value) {
    if (!Number.isFinite(value) || value < 0) {
        throw new Error(`${name} must be a non-negative finite number, got ${value}`);
    }
}
export function evaluatePoolExposureCap(input) {
    assertNonNegative('deployedUsd', input.deployedUsd);
    assertNonNegative('poolExposureUsd', input.poolExposureUsd);
    assertNonNegative('requestedUsd', input.requestedUsd);
    if (!Number.isFinite(input.maxPoolAllocationPct)
        || input.maxPoolAllocationPct <= 0
        || input.maxPoolAllocationPct > 100) {
        throw new Error(`maxPoolAllocationPct must be a percent in (0..100], got ${input.maxPoolAllocationPct}`);
    }
    // deployedUsd already includes poolExposureUsd (every open deposit is part
    // of the deployed base), but the *requested* deposit is not yet in either.
    // Degenerate case: with nothing else deployed there is no base to be a share
    // of — the first deposit defines it, so it always passes.
    if (input.deployedUsd === 0) {
        return {
            allowed: true,
            allowedAmountUsd: input.requestedUsd,
            projectedPoolShare: 1,
            reasons: []
        };
    }
    const deployedAfter = input.deployedUsd + input.requestedUsd;
    const poolAfter = input.poolExposureUsd + input.requestedUsd;
    const capFraction = input.maxPoolAllocationPct / 100;
    const projectedPoolShare = deployedAfter > 0 ? poolAfter / deployedAfter : 0;
    const allowed = projectedPoolShare <= capFraction + 1e-9;
    if (allowed) {
        return { allowed, allowedAmountUsd: input.requestedUsd, projectedPoolShare, reasons: [] };
    }
    // Largest top-up t solving (poolExposure + t) / (deployed + t) = cap.
    // Derived from the cap equation directly; negative or NaN solutions clamp to 0.
    const allowedAmountUsd = Math.max(0, (capFraction * input.deployedUsd - input.poolExposureUsd) / (1 - capFraction));
    return {
        allowed: false,
        allowedAmountUsd,
        projectedPoolShare,
        reasons: [
            `pool-exposure-cap: request would put ${(projectedPoolShare * 100).toFixed(1)}% of deployed capital in one pool, cap is ${input.maxPoolAllocationPct}%`,
            ...(allowedAmountUsd > 0
                ? [`max allowed top-up for this pool: ${allowedAmountUsd.toFixed(2)} USD`]
                : ['no further allocation to this pool is possible under the cap'])
        ]
    };
}
//# sourceMappingURL=exposure-cap.js.map