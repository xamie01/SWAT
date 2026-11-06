import { netLpResult } from '../domain/net-lp-result.js';
export function computeWalletPositionPnl(series) {
    if (series.length < 2) {
        // One point is an observation, not a result — nothing has been earned or
        // lost *over time* yet.
        return null;
    }
    const ordered = [...series].sort((left, right) => left.capturedAt.getTime() - right.capturedAt.getTime());
    const first = ordered[0];
    const last = ordered[ordered.length - 1];
    const feesEarnedUsd = last.uncollectedFeesUsd - first.uncollectedFeesUsd;
    const inventoryChangeUsd = last.positionValueUsd - first.positionValueUsd;
    const netResultUsd = netLpResult({
        feesEarned: feesEarnedUsd,
        impermanentLoss: 0,
        gasCost: 0,
        rebalanceCost: 0,
        inventoryChange: inventoryChangeUsd
    });
    return {
        netResultUsd,
        feesEarnedUsd,
        inventoryChangeUsd,
        firstObservedAt: first.capturedAt,
        lastObservedAt: last.capturedAt,
        closed: last.positionValueUsd === 0 && last.uncollectedFeesUsd === 0
    };
}
//# sourceMappingURL=pnl.js.map