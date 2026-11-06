import { query } from './client.js';
/**
 * Enumerate exact-quantity close-all sells without changing lifecycle state.
 *
 * The lot is the unit of work and the deterministic job id. A repeated poll
 * therefore produces the same BullMQ identity until evidence reduces the lot;
 * only confirmed reductions may make a winding-down subscription eligible for
 * `endSubscription`.
 */
export async function listCloseAllLotJobs() {
    const rows = await query(`SELECT
       subscription.user_id,
       subscription.wallet_address,
       lot.id AS lot_id,
       lot.signal_id,
       lot.token_mint,
       lot.chain,
       lot.remaining_quantity::text
       FROM user_wallet_subscriptions subscription
       JOIN copy_position_master_lots lot
         ON lot.user_id = subscription.user_id
        AND lot.master_wallet_address = subscription.wallet_address
        AND lot.remaining_quantity > 0
      WHERE subscription.state = 'winding_down'
        AND subscription.close_all_requested_at IS NOT NULL
      ORDER BY subscription.user_id, subscription.wallet_address,
               lot.acquired_at, lot.id`);
    return rows.map((row) => {
        const quantity = Number(row.remaining_quantity);
        if (!Number.isFinite(quantity) || quantity <= 0) {
            throw new Error(`Close-all lot ${row.lot_id} has invalid remaining quantity`);
        }
        return {
            userId: row.user_id,
            walletAddress: row.wallet_address,
            lotId: row.lot_id,
            signalId: row.signal_id,
            tokenMint: row.token_mint,
            chain: row.chain,
            sellTokenAmount: quantity,
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
export async function endCompletedCloseAllSubscriptions() {
    const rows = await query(`UPDATE user_wallet_subscriptions subscription
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
      RETURNING subscription.user_id`);
    return rows.length;
}
//# sourceMappingURL=close-all.js.map