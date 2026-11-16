import { query } from './client.js';
import type { Chain } from '@swat/shared';
import type { CopyExecutionRecord } from './copy-trade-lifecycle.js';
import { assertExactExitQuantity } from './lot-allocation.js';

export interface CloseAllLotJob {
  readonly claimId?: string;
  readonly userId: string;
  readonly walletAddress: string;
  readonly lotId: string;
  readonly signalId: string;
  readonly tokenMint: string;
  readonly chain: Chain;
  readonly sellTokenAmount: number;
  readonly requestedBaseQuantity: string;
  readonly masterWalletAddress: string;
  readonly targetAccount: string;
  readonly acquisitionExecutionMode: CopyExecutionRecord['executionMode'];
  readonly jobId: string;
}

type CloseAllLotRow = {
  user_id: string;
  wallet_address: string;
  lot_id: string;
  signal_id: string;
  token_mint: string;
  chain: Chain;
  remaining_quantity: string;
  master_wallet_address: string;
  target_account: string;
  execution_mode: CopyExecutionRecord['executionMode'];
};

/**
 * Enumerate exact-quantity close-all sells without changing lifecycle state.
 *
 * The lot is the unit of work and the deterministic job id. A repeated poll
 * therefore produces the same BullMQ identity until evidence reduces the lot;
 * only confirmed reductions may make a winding-down subscription eligible for
 * `endSubscription`.
 */
export async function listCloseAllLotJobs(): Promise<CloseAllLotJob[]> {
  const rows = await query<CloseAllLotRow>(
    `SELECT
       subscription.user_id,
       subscription.wallet_address,
       lot.id AS lot_id,
       lot.signal_id,
       lot.token_mint,
       lot.chain,
       lot.master_wallet_address,
       position.target_account,
       acquisition.execution_mode,
       lot.remaining_quantity::text
       FROM user_wallet_subscriptions subscription
       JOIN copy_position_master_lots lot
         ON lot.user_id = subscription.user_id
        AND lot.master_wallet_address = subscription.wallet_address
        AND lot.remaining_quantity > 0
       JOIN copy_positions position ON position.id = lot.position_id
         AND position.user_id IS NOT DISTINCT FROM lot.user_id
         AND position.chain = lot.chain AND position.token_mint = lot.token_mint
       JOIN copy_executions acquisition ON acquisition.id = lot.acquisition_execution_id
         AND acquisition.user_id IS NOT DISTINCT FROM lot.user_id
         AND acquisition.target_account = position.target_account
         AND acquisition.chain = lot.chain AND acquisition.token_mint = lot.token_mint
         AND acquisition.direction = 'buy'
      WHERE subscription.state = 'winding_down'
        AND subscription.close_all_requested_at IS NOT NULL
      ORDER BY subscription.user_id, subscription.wallet_address,
               lot.acquired_at, lot.id`
  );

  return rows.map((row) => {
    const quantity = Number(row.remaining_quantity);
    if (typeof row.remaining_quantity !== 'string' || !/^\d+(?:\.\d+)?$/.test(row.remaining_quantity)
        || !Number.isFinite(quantity) || quantity <= 0) {
      throw new Error(`Close-all lot ${row.lot_id} has invalid remaining quantity`);
    }
    assertExactExitQuantity(row.remaining_quantity);
    return {
      userId: row.user_id,
      walletAddress: row.wallet_address,
      lotId: row.lot_id,
      signalId: row.signal_id,
      tokenMint: row.token_mint,
      chain: row.chain,
      sellTokenAmount: quantity,
      requestedBaseQuantity: row.remaining_quantity,
      masterWalletAddress: row.master_wallet_address,
      targetAccount: row.target_account,
      acquisitionExecutionMode: row.execution_mode,
      jobId: `close-all-${row.user_id}-${row.lot_id}`
    };
  });
}

/**
 * End only subscriptions whose requested close-all has no open lot left.
 *
 * The predicate is evaluated in the UPDATE itself, so a concurrent confirmed
 * reduction wins the race with this sweep rather than being stranded by an
 * in-memory read. This is intentionally separate from enumeration: enqueueing
 * a sell is not evidence that the lot was reduced.
 */
export async function endCompletedCloseAllSubscriptions(): Promise<number> {
  const rows = await query<{ user_id: string }>(
    `UPDATE user_wallet_subscriptions subscription
        SET state = 'ended',
            ended_at = NOW(),
            membership_slot = NULL,
            membership_grandfathered = FALSE
      WHERE subscription.state = 'winding_down'
        AND subscription.close_all_requested_at IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
            FROM copy_position_master_lots lot
           WHERE lot.user_id = subscription.user_id
             AND lot.master_wallet_address = subscription.wallet_address
             AND lot.remaining_quantity > 0
        )
        AND NOT EXISTS (
          SELECT 1 FROM copy_executions execution
          LEFT JOIN source_trades source ON source.id = execution.source_trade_id
          LEFT JOIN copy_position_master_lots exit_lot ON exit_lot.id = execution.exit_lot_id
          WHERE execution.user_id IS NOT DISTINCT FROM subscription.user_id
            AND execution.direction = 'sell'
            AND execution.state NOT IN ('failed', 'cancelled', 'confirmed')
            AND (execution.reserved_base_quantity > 0 OR execution.exit_lot_id IS NOT NULL)
            AND (source.wallet_address = subscription.wallet_address
              OR exit_lot.master_wallet_address = subscription.wallet_address)
        )
      RETURNING subscription.user_id`
  );
  return rows.length;
}
