/**
 * Per-user SOL minimum for tips and transaction fees (S4-P20).
 *
 * A user funding only tokens/USDC has zero SOL and cannot execute.
 * The threshold is strictly denominated in USD ($10 equivalent) and converted
 * live via the current SOL price, never fixed at a static SOL floor that drifts
 * with price movement.
 *
 * Fail-closed: an unreadable SOL price must not silently admit an underfunded
 * user or guess a fabricated fallback (e.g. 150). It returns an actionable
 * skip verdict with a specific reason.
 */
export const DEFAULT_SOL_MINIMUM_RESERVE_USD = 10;
export function evaluateSolReserve(opts) {
    const currentSol = opts.currentSolBalance;
    const targetUsd = opts.targetUsd ?? DEFAULT_SOL_MINIMUM_RESERVE_USD;
    if (opts.solPriceUsd == null || Number.isNaN(opts.solPriceUsd) || opts.solPriceUsd <= 0) {
        return {
            status: 'price-unavailable',
            code: 'sol-price-unavailable',
            reason: 'SOL price feed is currently unavailable; refusing trade to protect reserve gate',
            currentSol
        };
    }
    const solPriceUsd = opts.solPriceUsd;
    const requiredSol = targetUsd / solPriceUsd;
    if (currentSol >= requiredSol) {
        return {
            status: 'funded',
            currentSol,
            requiredSol,
            solPriceUsd
        };
    }
    const neededSol = Math.max(0, requiredSol - currentSol);
    return {
        status: 'underfunded',
        code: 'sol-reserve-underfunded',
        reason: `Insufficient SOL for transaction fees: hold at least ~${neededSol.toFixed(4)} more SOL ($${targetUsd} reserve required)`,
        currentSol,
        requiredSol,
        neededSol,
        solPriceUsd
    };
}
//# sourceMappingURL=sol-reserve.js.map