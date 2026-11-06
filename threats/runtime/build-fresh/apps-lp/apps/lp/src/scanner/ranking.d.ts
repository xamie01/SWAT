/**
 * Volume-to-active-liquidity ranking (Track B5) — shared across chains because
 * it consumes only the normalized pool shape from Track A.
 *
 * Volume ÷ active TVL is the standard "is capital actually being traded
 * against here" signal: a pool can hold enormous total TVL while almost all of
 * it sits out of range, so total TVL alone ranks dead pools highly. Ratio is
 * deliberately not stored on `lp_pools` — it is a pure function of two stored
 * columns, and the Discover feed applies it at request time so the formula can
 * evolve without a backfill.
 *
 * Unmeasurable inputs (null active TVL or volume) sort to the bottom, after
 * every pool that could be ranked — a pool that cannot be measured must never
 * beat one that measurably performed. A measured volume against a zero active
 * TVL is unmeasurable too, not an infinite ratio: trades require liquidity,
 * so volume > 0 with activeTvl = 0 means the active-TVL observation failed,
 * and an `Infinity` would put the least-verified pool at the very top.
 */
export interface RankablePool {
    readonly poolAddress: string;
    readonly volume24h: number | null;
    readonly activeTvl: number | null;
}
export declare function volumeToActiveLiquidityRatio(pool: RankablePool): number | null;
/** Sorts highest ratio first. Returns a new array; never mutates the input. */
export declare function rankPoolsByVolumeToActiveLiquidity<T extends RankablePool>(pools: readonly T[]): T[];
//# sourceMappingURL=ranking.d.ts.map