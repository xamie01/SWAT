import type { Chain } from '@swat/shared';
import type { CopyExecutionRecord } from './copy-trade-lifecycle.js';
import { query } from './client.js';

/**
 * Stop-loss enforcement, split into a pure decision half and a DB claim half so
 * the threshold arithmetic can be tested without infrastructure.
 *
 * Contract (single source of truth for the whole system):
 * - Price: the mark-to-market price already fetched by
 *   `markToMarketOpenPositions`, so the decision uses the same number the
 *   dashboard shows and no extra RPC call is made.
 * - Schedule: the scorer's existing 5-minute mark-to-market cron.
 * - Order: one full-position sell per breached position, queued on `swat-trades`.
 * - Threshold: `stopLossPct` from `resolveRiskPolicy`, which is the only place
 *   the value is resolved (DB `config.risk.stop_loss_pct` → env → default).
 */

/** One tenant's open position on a signal, reconstructed from its filled trade ledger. */
export interface OpenPositionSnapshot {
  signalId: string;
  /**
   * Whose position this is. `null` IS the pre-tenancy operator account -- migration
   * 050 leaves every legacy `trades` row at `user_id NULL` and backfills nothing.
   *
   * Load-bearing rather than informational (`S4-M46`): it is what the sweep turns into
   * the `signal_stop_losses.account` key. Before it existed, every user's trades on one
   * signal collapsed into one position, and because that table is
   * `PRIMARY KEY (account, signal_id)`, one user's claim blocked every other holder's
   * -- while the sweep reported success.
   */
  userId: string | null;
  /** Stable master-lot identity; absent for legacy aggregate rows. */
  positionKey?: string | null;
  /** Exact lot wire quantity and immutable acquisition scope; never inferred from a number. */
  openQuantityExact?: string;
  masterWalletAddress?: string;
  targetAccount?: string;
  acquisitionExecutionMode?: CopyExecutionRecord['executionMode'];
  tokenMint: string;
  chain: Chain;
  openQuantity: number;
  openCostBasisUsd: number;
  unrealizedPnlUsd: number;
  currentPriceUsd: number;
}

/**
 * Unrealised loss as a positive percentage of the position's cost basis.
 * Returns null when the position is closed or the basis can't support a ratio;
 * a gain yields a negative number.
 */
export function positionDrawdownPct(
  position: Pick<OpenPositionSnapshot, 'openQuantity' | 'openCostBasisUsd' | 'unrealizedPnlUsd'>
): number | null {
  if (!Number.isFinite(position.openQuantity) || position.openQuantity <= 0) return null;
  if (!Number.isFinite(position.openCostBasisUsd) || position.openCostBasisUsd <= 0) return null;
  if (!Number.isFinite(position.unrealizedPnlUsd)) return null;
  return (-position.unrealizedPnlUsd / position.openCostBasisUsd) * 100;
}

/** Whether an open position has fallen at or past its stop-loss threshold. */
export function isStopLossBreached(
  position: Pick<OpenPositionSnapshot, 'openQuantity' | 'openCostBasisUsd' | 'unrealizedPnlUsd'>,
  stopLossPct: number
): boolean {
  if (!Number.isFinite(stopLossPct) || stopLossPct <= 0) return false;
  const drawdown = positionDrawdownPct(position);
  return drawdown !== null && drawdown >= stopLossPct;
}

export interface StopLossClaimInput {
  account: string;
  signalId: string;
  chain: Chain;
  tokenMint: string;
  thresholdPct: number;
  drawdownPct: number;
  openQuantity: number;
  openCostBasisUsd: number;
  priceUsd: number | null;
  /** Master-lot identity; empty preserves the legacy aggregate/operator claim. */
  positionKey?: string | null;
}

/**
 * Atomically claim the one stop-loss exit for this (account, signal). Returns
 * true only for the caller that inserted the row, so a redelivered sweep or a
 * second scorer process cannot queue a duplicate sell.
 */
export async function claimStopLossTrigger(input: StopLossClaimInput): Promise<boolean> {
  if (input.positionKey !== undefined && input.positionKey !== null && input.positionKey !== '') {
    throw new Error('A lot stop-loss requires a canonical lot exit, not a signal trigger claim');
  }
  const rows = await query<{ signal_id: string }>(
    `INSERT INTO signal_stop_losses (
       account, signal_id, chain, token_mint,
       threshold_pct, drawdown_pct, open_quantity, open_cost_basis_usd, price_usd,
       position_key
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (account, signal_id, position_key) DO NOTHING
     RETURNING signal_id`,
    [
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
    ]
  );
  return rows.length > 0;
}

/**
 * Release a claim so the next sweep can retry. Only called when the exit could
 * not be queued at all — never after a sell has been handed to the executor.
 */
export async function releaseStopLossTrigger(
  account: string,
  signalId: string,
  positionKey?: string | null
): Promise<void> {
  await query(
    `DELETE FROM signal_stop_losses
      WHERE account = $1 AND signal_id = $2 AND position_key = $3`,
    [account, signalId, positionKey ?? '']
  );
}
