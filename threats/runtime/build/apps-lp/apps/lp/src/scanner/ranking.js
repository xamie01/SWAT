export function volumeToActiveLiquidityRatio(pool) {
    if (pool.volume24h === null || pool.activeTvl === null
        || !Number.isFinite(pool.volume24h) || !Number.isFinite(pool.activeTvl)) {
        return null;
    }
    if (pool.activeTvl <= 0) {
        return null;
    }
    return pool.volume24h / pool.activeTvl;
}
/** Sorts highest ratio first. Returns a new array; never mutates the input. */
export function rankPoolsByVolumeToActiveLiquidity(pools) {
    return [...pools].sort((left, right) => {
        const leftRatio = volumeToActiveLiquidityRatio(left);
        const rightRatio = volumeToActiveLiquidityRatio(right);
        // null (unmeasurable) loses to every number; two nulls keep scan order.
        if (leftRatio === null && rightRatio === null)
            return 0;
        if (leftRatio === null)
            return 1;
        if (rightRatio === null)
            return -1;
        return rightRatio - leftRatio;
    });
}
//# sourceMappingURL=ranking.js.map