import { query } from './client.js';
/**
 * Unrealised loss as a positive percentage of the position's cost basis.
 * Returns null when the position is closed or the basis can't support a ratio;
 * a gain yields a negative number.
 */
export function positionDrawdownPct(position) {
    if (!Number.isFinite(position.openQuantity) || position.openQuantity <= 0)
        return null;
    if (!Number.isFinite(position.openCostBasisUsd) || position.openCostBasisUsd <= 0)
        return null;
    if (!Number.isFinite(position.unrealizedPnlUsd))
        return null;
    return (-position.unrealizedPnlUsd / position.openCostBasisUsd) * 100;
}
/** Whether an open position has fallen at or past its stop-loss threshold. */
export function isStopLossBreached(position, stopLossPct) {
    if (!Number.isFinite(stopLossPct) || stopLossPct <= 0)
        return false;
    const drawdown = positionDrawdownPct(position);
    return drawdown !== null && drawdown >= stopLossPct;
}
/**
 * Atomically claim the one stop-loss exit for this (account, signal). Returns
 * true only for the caller that inserted the row, so a redelivered sweep or a
 * second scorer process cannot queue a duplicate sell.
 */
export async function claimStopLossTrigger(input) {
    const rows = await query(`INSERT INTO signal_stop_losses (
       account, signal_id, chain, token_mint,
       threshold_pct, drawdown_pct, open_quantity, open_cost_basis_usd, price_usd,
       position_key
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (account, signal_id, position_key) DO NOTHING
     RETURNING signal_id`, [
        input.account,
        input.signalId,
        input.chain,
        input.tokenMint,
        input.thresholdPct,
        input.drawdownPct,
        input.openQuantity,
        input.openCostBasisUsd,
        input.priceUsd,
        input.positionKey ?? ''
    ]);
    return rows.length > 0;
}
/**
 * Release a claim so the next sweep can retry. Only called when the exit could
 * not be queued at all — never after a sell has been handed to the executor.
 */
export async function releaseStopLossTrigger(account, signalId, positionKey) {
    await query(`DELETE FROM signal_stop_losses
      WHERE account = $1 AND signal_id = $2 AND position_key = $3`, [account, signalId, positionKey ?? '']);
}
//# sourceMappingURL=stop-loss.js.map