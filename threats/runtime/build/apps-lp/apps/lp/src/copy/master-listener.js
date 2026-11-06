/**
 * Compares two snapshots of a master wallet's open positions and emits
 * discrete MasterLpEvent notifications (mint, increase, decrease, burn, collect).
 */
export function diffMasterPositions(masterWalletAddress, chain, venue, previousPositions, currentPositions, now = new Date()) {
    const events = [];
    const nextState = new Map();
    const currentMap = new Map();
    for (const pos of currentPositions) {
        currentMap.set(pos.positionAddress, pos);
    }
    // 1. Detect new positions (mint) or updates (increase, decrease, collect)
    for (const pos of currentPositions) {
        const prev = previousPositions.get(pos.positionAddress);
        if (!prev) {
            // Newly opened position!
            const openedAt = now;
            nextState.set(pos.positionAddress, {
                positionAddress: pos.positionAddress,
                poolAddress: pos.poolAddress,
                positionValueUsd: pos.positionValueUsd,
                uncollectedFeesUsd: pos.uncollectedFeesUsd,
                inRange: pos.inRange,
                firstObservedAt: openedAt
            });
            events.push({
                masterWalletAddress,
                chain,
                venue,
                masterPositionId: pos.positionAddress,
                poolAddress: pos.poolAddress,
                action: 'mint',
                masterDepositUsd: pos.positionValueUsd,
                openedAt
            });
        }
        else {
            // Position existed before - check for adjustments
            const openedAt = prev.firstObservedAt;
            const valueDiff = pos.positionValueUsd - prev.positionValueUsd;
            const feeDiff = pos.uncollectedFeesUsd - prev.uncollectedFeesUsd;
            // Significant deposit increase (> 5% and > $5)
            if (valueDiff > 5 && valueDiff > prev.positionValueUsd * 0.05) {
                events.push({
                    masterWalletAddress,
                    chain,
                    venue,
                    masterPositionId: pos.positionAddress,
                    poolAddress: pos.poolAddress,
                    action: 'increase',
                    masterDepositUsd: valueDiff,
                    openedAt
                });
            }
            // Significant position decrease (> 5% and > $5)
            else if (valueDiff < -5 && Math.abs(valueDiff) > prev.positionValueUsd * 0.05) {
                events.push({
                    masterWalletAddress,
                    chain,
                    venue,
                    masterPositionId: pos.positionAddress,
                    poolAddress: pos.poolAddress,
                    action: 'decrease',
                    masterDepositUsd: Math.abs(valueDiff),
                    openedAt
                });
            }
            // Fee collection detected (fees dropped by > $2 without value decrease)
            if (feeDiff < -2.0) {
                events.push({
                    masterWalletAddress,
                    chain,
                    venue,
                    masterPositionId: pos.positionAddress,
                    poolAddress: pos.poolAddress,
                    action: 'collect',
                    masterDepositUsd: Math.abs(feeDiff),
                    openedAt
                });
            }
            nextState.set(pos.positionAddress, {
                positionAddress: pos.positionAddress,
                poolAddress: pos.poolAddress,
                positionValueUsd: pos.positionValueUsd,
                uncollectedFeesUsd: pos.uncollectedFeesUsd,
                inRange: pos.inRange,
                firstObservedAt: openedAt
            });
        }
    }
    // 2. Detect closed positions (burn)
    for (const [posAddress, prev] of previousPositions.entries()) {
        if (!currentMap.has(posAddress)) {
            events.push({
                masterWalletAddress,
                chain,
                venue,
                masterPositionId: posAddress,
                poolAddress: prev.poolAddress,
                action: 'burn',
                masterDepositUsd: prev.positionValueUsd,
                openedAt: prev.firstObservedAt
            });
        }
    }
    return { events, nextState };
}
//# sourceMappingURL=master-listener.js.map