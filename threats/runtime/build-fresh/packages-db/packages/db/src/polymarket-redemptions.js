import { query } from './client.js';
/**
 * Resolved markets in which **we hold a confirmed position**, minus any already
 * claimed or confirmed for redemption (checklist `S4-M37`).
 *
 * **What was wrong before.** This joined `polymarket_markets` to
 * `polymarket_trades` — *observed master* trades — with no status filter and no
 * join to `copy_executions` or `copy_positions`, while its own doc comment
 * claimed it was "scoped to confirmed fills". It was not. A redemption sweep
 * acting on it would try to redeem markets we never entered, and every wallet we
 * merely watch would have produced a redemption attempt.
 *
 * **The decided inversion.** Redemption is driven by our own open positions —
 * close only what we actually hold. The master's holdings remain a
 * *cross-reference* for deciding whether an exit is due (`S4-M19`), never the
 * source of what to redeem. So the driving join is `copy_positions` with
 * `confirmed_quantity > 0`, and `polymarket_trades` does not appear at all.
 *
 * **Why `copy_positions` and also `copy_executions`.** `confirmed_quantity` is
 * the net holding rebuilt from confirmed evidence, which is the "do we hold it"
 * test. The `copy_executions` existence check is the "did we ever enter" test,
 * and it is kept separate because a position row can in principle survive its
 * evidence being reclassified. A pending or reconciliation-required execution has
 * no proven token balance, so neither test passes on one.
 *
 * **Tenancy.** `IS NOT DISTINCT FROM` rather than `=` because `user_id` is NULL
 * for the pre-multi-tenant operator account, and `= NULL` is never true. This
 * matches the NULLS NOT DISTINCT semantics of the redemption claim index in
 * `046`; without it the operator's own positions would be invisible to the sweep.
 *
 * The token join is on the chain-prefixed form on both sides:
 * `polymarket_outcomes.token_id` and `copy_positions.token_mint` both store
 * `polygon:<tokenId>`, per the repo's prefixed-address invariant.
 */
export async function listRedeemablePolymarketMarkets(input = {}) {
    return query(`SELECT
       m.condition_id     AS "conditionId",
       m.winning_token_id AS "winningTokenId",
       m.resolved_outcome AS "resolvedOutcome",
       COALESCE(m.neg_risk, FALSE) AS "negRisk",
       json_agg(
         json_build_object(
           'positionId', p.id,
           'conditionId', o.condition_id,
           'userId', p.user_id,
           'targetAccount', p.target_account,
           'tokenMint', p.token_mint,
           'tokenId', o.token_id,
           'outcome', o.outcome,
           'outcomeIndex', o.outcome_index,
           'heldShares', p.confirmed_quantity::text,
           'reservedSellShares', p.reserved_sell_quantity::text
         )
         ORDER BY o.outcome_index
       ) AS positions
     FROM polymarket_markets m
     JOIN polymarket_outcomes o
       ON o.condition_id = m.condition_id
     JOIN copy_positions p
       ON p.chain = 'polygon'
      AND p.token_mint = o.token_id
     WHERE m.resolution_status = 'resolved'
       AND p.confirmed_quantity > 0
       AND p.user_id IS NOT DISTINCT FROM $1
       AND EXISTS (
         SELECT 1 FROM copy_executions e
         WHERE e.chain = 'polygon'
           AND e.token_mint = p.token_mint
           AND e.target_account = p.target_account
           AND e.user_id IS NOT DISTINCT FROM p.user_id
           AND e.state = 'confirmed'
           AND e.confirmed_base_quantity > 0
       )
       AND NOT EXISTS (
         SELECT 1 FROM polymarket_redemptions r
         WHERE r.condition_id = m.condition_id
           AND r.user_id IS NOT DISTINCT FROM $1
           AND r.status IN ('claimed', 'confirmed')
       )
     GROUP BY m.condition_id, m.winning_token_id, m.resolved_outcome, m.neg_risk
     ORDER BY m.condition_id
     LIMIT $2`, [input.userId ?? null, input.limit ?? 50]);
}
/**
 * Claims a market for redemption, or returns null when another sweep holds it.
 *
 * The conflict target is stated explicitly — `(user_id, condition_id) WHERE
 * status IN ('claimed','confirmed')` — because a bare `ON CONFLICT DO NOTHING`
 * does not engage a *partial* index. It must also match the index predicate
 * exactly or Postgres raises "no unique or exclusion constraint matching".
 *
 * Returning null rather than throwing lets the caller treat contention as
 * "someone else has it" instead of an error, which is the normal case when two
 * workers sweep concurrently.
 */
export async function claimPolymarketRedemption(input) {
    const rows = await query(`INSERT INTO polymarket_redemptions (condition_id, user_id, status)
     VALUES ($1, $2, 'claimed')
     ON CONFLICT (user_id, condition_id)
       WHERE status IN ('claimed', 'confirmed')
       DO NOTHING
     RETURNING id, condition_id AS "conditionId", user_id AS "userId"`, [input.conditionId, input.userId ?? null]);
    return rows[0] ?? null;
}
/**
 * Records a settled redemption.
 *
 * The transaction hash is required by a table constraint, not merely by
 * convention: a confirmed row without evidence reads as settled money that
 * cannot be verified against the chain.
 */
export async function confirmPolymarketRedemption(input) {
    await query(`UPDATE polymarket_redemptions
       SET status = 'confirmed',
           transaction_hash = $2,
           redeemed_collateral = $3,
           winning_token_id = $4,
           confirmed_at = now()
     WHERE id = $1 AND status = 'claimed'`, [input.id, input.transactionHash, input.redeemedCollateral, input.winningTokenId ?? null]);
}
/**
 * Releases a claim as failed so a later sweep can retry.
 *
 * Deliberately distinct from deleting the row: the failure reason is the only
 * record of *why* a market went unredeemed, and losing it turns a recurring
 * venue problem into an invisible one.
 */
export async function failPolymarketRedemption(input) {
    await query(`UPDATE polymarket_redemptions
       SET status = 'failed', failure_reason = $2
     WHERE id = $1 AND status = 'claimed'`, [input.id, input.reason.slice(0, 500)]);
}
/**
 * Recovers claims stranded by a crash between claim and confirm.
 *
 * These are genuinely ambiguous — the on-chain call may or may not have landed —
 * so they are marked `failed` rather than retried silently. `redeemPositions` is
 * idempotent in effect (a second call on an already-redeemed market moves no
 * tokens), so a later retry is safe; what must not happen is a stuck `claimed`
 * row blocking the market forever.
 */
export async function releaseStalePolymarketRedemptionClaims(olderThanMs) {
    const rows = await query(`UPDATE polymarket_redemptions
       SET status = 'failed',
           failure_reason = 'claim expired before confirmation'
     WHERE status = 'claimed'
       AND claimed_at < now() - ($1::bigint * interval '1 millisecond')
     RETURNING id`, [olderThanMs]);
    return rows.length;
}
//# sourceMappingURL=polymarket-redemptions.js.map