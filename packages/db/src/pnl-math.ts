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
export function markToMarketPnl(
  costBasisUsd: number | null | undefined,
  entryPriceUsd: number | null | undefined,
  currentPriceUsd: number | null | undefined
): number | null {
  if (costBasisUsd == null || !Number.isFinite(costBasisUsd)) return null;
  if (entryPriceUsd == null || !Number.isFinite(entryPriceUsd) || entryPriceUsd <= 0) return null;
  if (currentPriceUsd == null || !Number.isFinite(currentPriceUsd) || currentPriceUsd < 0) return null;
  return costBasisUsd * (currentPriceUsd / entryPriceUsd - 1);
}
