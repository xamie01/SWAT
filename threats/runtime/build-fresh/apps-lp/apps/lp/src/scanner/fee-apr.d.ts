/**
 * Realized fee APR (Track B4) — a shared pure function over normalized pool
 * data, so Solana and Robinhood Chain pools are scored identically.
 *
 * The build plan defines it as *trailing fees ÷ TVL* for the 24h and 7d
 * windows. The result is a period yield fraction (0.004 = 0.4% of TVL earned
 * in that window) — it is NOT annualized; annualizing a trailing window hides
 * how thin the observation is, and a pool two days old would print a made-up
 * ×365 number.
 *
 * `null` is a real answer, not a zero: with unknown fees or zero TVL the APR
 * is *unknown*, and ranking must treat unknown as bottom rather than as "no
 * fees", or a dead pool would outrank an unmeasured one.
 */
export interface RealizedFeeAprInput {
    readonly fees24h: number;
    readonly fees7d: number | null;
    readonly tvl: number;
}
export interface RealizedFeeApr {
    /** Fraction of TVL earned as fees in the trailing 24h. */
    readonly feeApr24h: number | null;
    /** Fraction of TVL earned as fees in the trailing 7d, when the window exists. */
    readonly feeApr7d: number | null;
}
export declare function realizedFeeApr(input: RealizedFeeAprInput): RealizedFeeApr;
//# sourceMappingURL=fee-apr.d.ts.map