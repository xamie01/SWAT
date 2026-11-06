import { query } from './client.js';
import { withTransaction } from './transaction.js';
async function inTransaction(operation) {
    return withTransaction(operation);
}
/**
 * Load the source facts for a canonical signal, or `null` when the signal is
 * not linked to a source trade. A `null` result is not "eligible by default":
 * the caller must treat an absent fact set as a rejection, because a signal
 * with no observable source is exactly the case we cannot vouch for.
 */
export async function loadCopyEligibilityFacts(input) {
    if (!Number.isSafeInteger(input.activityLookbackMs) || input.activityLookbackMs <= 0) {
        throw new Error('activityLookbackMs must be a positive safe integer');
    }
    const now = input.now ?? new Date();
    const rows = await query(`SELECT
       signal.id                                  AS signal_id,
       signal.status                              AS signal_status,
       source.chain                               AS chain,
       source.wallet_address                      AS wallet_address,
       source.event_at                            AS event_at,
       (wallet.address IS NOT NULL)               AS wallet_known,
       COALESCE(wallet.status, '')                AS wallet_status,
       COALESCE(wallet.total_trades, 0)::text     AS wallet_trade_count,
       EXISTS (
         SELECT 1
           FROM cluster_memberships membership
           JOIN wallet_clusters cluster ON cluster.id = membership.cluster_id
          WHERE membership.wallet_address = source.wallet_address
            AND cluster.status = 'active'
       )                                          AS cluster_selected,
       COALESCE((
         SELECT SUM(activity.amount_usd)
           FROM source_trades activity
          WHERE activity.wallet_address = source.wallet_address
            AND activity.chain = source.chain
            AND activity.confirmation_state IN ('confirmed', 'finalized')
            AND activity.event_at >= $2::timestamptz - ($3::bigint * INTERVAL '1 millisecond')
       ), 0)::text                                AS source_activity_usd
     FROM signals signal
     JOIN source_trades source ON source.id = signal.source_trade_id
     LEFT JOIN wallets wallet ON wallet.address = source.wallet_address
     WHERE signal.id = $1`, [input.signalId, now, input.activityLookbackMs]);
    const row = rows[0];
    if (!row)
        return null;
    return {
        signalId: row.signal_id,
        signalStatus: row.signal_status,
        chain: row.chain,
        walletAddress: row.wallet_address,
        walletKnown: row.wallet_known,
        walletStatus: row.wallet_status,
        walletTradeCount: Number(row.wallet_trade_count),
        clusterSelected: row.cluster_selected,
        sourceActivityUsd: Number(row.source_activity_usd),
        eventAt: row.event_at
    };
}
/**
 * Persist why a signal was refused and take it out of the claimable set.
 *
 * Both writes happen in one transaction. Recording the reason without marking
 * the signal would let the next queue retry re-run the same rejected policy,
 * and marking it without recording the reason would leave an operator with a
 * `rejected` row and no way to tell which gate fired.
 *
 * The status update is deliberately narrow: only a signal that is still
 * awaiting a claim is moved. A signal already `executing` or `executed` has
 * money behind it and must not be rewritten by a policy pass.
 */
export async function recordCopyEligibilityRejection(input) {
    if (input.reasons.length === 0) {
        throw new Error('recordCopyEligibilityRejection requires at least one reason');
    }
    const rejectedAt = input.rejectedAt ?? new Date();
    return inTransaction(async (client) => {
        await client.query(`INSERT INTO copy_eligibility_rejections
         (account, signal_id, chain, wallet_address, reasons, rejected_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (account, signal_id) DO UPDATE
         SET reasons = EXCLUDED.reasons,
             rejected_at = EXCLUDED.rejected_at`, [
            input.account,
            input.signalId,
            input.chain,
            input.walletAddress,
            input.reasons,
            rejectedAt
        ]);
        const updated = await client.query(`UPDATE signals
          SET status = 'rejected'
        WHERE id = $1
          AND status IN ('pending', 'eligible', 'alerted')`, [input.signalId]);
        return (updated.rowCount ?? 0) === 1;
    });
}
//# sourceMappingURL=copy-eligibility.js.map