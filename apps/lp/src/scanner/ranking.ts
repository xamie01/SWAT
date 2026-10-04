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
 * beat one that measurably performed.
 */
export interface RankablePool {
  readonly poolAddress: string;
  readonly volume24h: number | null;
  readonly activeTvl: number | null;
}

export function volumeToActiveLiquidityRatio(pool: RankablePool): number | null {
  if (
    pool.volume24h === null || pool.activeTvl === null
    || !Number.isFinite(pool.volume24h) || !Number.isFinite(pool.activeTvl)
  ) {
    return null;
  }
  if (pool.activeTvl <= 0) {
    return pool.volume24h > 0 ? Number.POSITIVE_INFINITY : null;
  }
  return pool.volume24h / pool.activeTvl;
}

/** Sorts highest ratio first. Returns a new array; never mutates the input. */
export function rankPoolsByVolumeToActiveLiquidity<T extends RankablePool>(pools: readonly T[]): T[] {
  return [...pools].sort((left, right) => {
    const leftRatio = volumeToActiveLiquidityRatio(left);
    const rightRatio = volumeToActiveLiquidityRatio(right);
    // null (unmeasurable) loses to every number; two nulls keep scan order.
    if (leftRatio === null && rightRatio === null) return 0;
    if (leftRatio === null) return 1;
    if (rightRatio === null) return -1;
    return rightRatio - leftRatio;
  });
}
