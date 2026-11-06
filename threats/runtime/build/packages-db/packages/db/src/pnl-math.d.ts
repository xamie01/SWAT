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
export declare function markToMarketPnl(costBasisUsd: number | null | undefined, entryPriceUsd: number | null | undefined, currentPriceUsd: number | null | undefined): number | null;
export interface PositionLedgerTrade {
    direction: 'buy' | 'sell';
    tokenAmount: number;
    amountUsd: number;
    feeUsd?: number;
}
export interface PositionPnl {
    openQuantity: number;
    openCostBasisUsd: number;
    realizedPnlUsd: number;
    unrealizedPnlUsd: number;
    totalPnlUsd: number;
}
/** Calculate chronological average-cost P&L, including partial reductions. */
export declare function calculateAverageCostPnl(trades: PositionLedgerTrade[], currentPriceUsd: number | null): PositionPnl | null;
//# sourceMappingURL=pnl-math.d.ts.map