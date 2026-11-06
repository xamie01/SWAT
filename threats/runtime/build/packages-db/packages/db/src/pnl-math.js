/**
 * Pure mark-to-market math — no DB or network dependencies so it can be unit
 * tested in isolation.
 *
 * Given the USD cost basis of an open position, the token price at entry, and
 * the current token price, return the unrealised P&L in USD.
 *
 * Uses the price ratio rather than a stored token amount so it is robust to
 * decimals/rounding: pnl = costBasisUsd * (currentPrice / entryPrice - 1).
 *
 * Returns null when the inputs can't produce a meaningful number.
 */
export function markToMarketPnl(costBasisUsd, entryPriceUsd, currentPriceUsd) {
    if (costBasisUsd == null || !Number.isFinite(costBasisUsd))
        return null;
    if (entryPriceUsd == null || !Number.isFinite(entryPriceUsd) || entryPriceUsd <= 0)
        return null;
    if (currentPriceUsd == null || !Number.isFinite(currentPriceUsd) || currentPriceUsd < 0)
        return null;
    return costBasisUsd * (currentPriceUsd / entryPriceUsd - 1);
}
/** Calculate chronological average-cost P&L, including partial reductions. */
export function calculateAverageCostPnl(trades, currentPriceUsd) {
    let openQuantity = 0;
    let openCostBasisUsd = 0;
    let realizedPnlUsd = 0;
    for (const trade of trades) {
        const feeUsd = trade.feeUsd ?? 0;
        if (!Number.isFinite(trade.tokenAmount)
            || trade.tokenAmount <= 0
            || !Number.isFinite(trade.amountUsd)
            || trade.amountUsd < 0
            || !Number.isFinite(feeUsd)
            || feeUsd < 0) {
            return null;
        }
        if (trade.direction === 'buy') {
            openQuantity += trade.tokenAmount;
            openCostBasisUsd += trade.amountUsd + feeUsd;
            continue;
        }
        if (trade.tokenAmount > openQuantity)
            return null;
        const averageUnitCost = openCostBasisUsd / openQuantity;
        const removedCostBasis = averageUnitCost * trade.tokenAmount;
        realizedPnlUsd += trade.amountUsd - feeUsd - removedCostBasis;
        openQuantity -= trade.tokenAmount;
        openCostBasisUsd -= removedCostBasis;
        if (openQuantity < 1e-12) {
            openQuantity = 0;
            openCostBasisUsd = 0;
        }
    }
    let unrealizedPnlUsd = 0;
    if (openQuantity > 0) {
        if (currentPriceUsd === null || !Number.isFinite(currentPriceUsd) || currentPriceUsd < 0) {
            return null;
        }
        unrealizedPnlUsd = openQuantity * currentPriceUsd - openCostBasisUsd;
    }
    return {
        openQuantity,
        openCostBasisUsd,
        realizedPnlUsd,
        unrealizedPnlUsd,
        totalPnlUsd: realizedPnlUsd + unrealizedPnlUsd
    };
}
//# sourceMappingURL=pnl-math.js.map