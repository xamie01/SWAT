import { query } from './client.js';
/**
 * Claim one position for exit, or return null when the other trigger already has
 * it.
 *
 * The conflict target is stated explicitly — `(user_id, position_key) WHERE
 * status IN ('claimed','confirmed')` — because a bare `ON CONFLICT DO NOTHING`
 * does not engage a *partial* index, and the predicate must match the index's
 * exactly or Postgres raises "no unique or exclusion constraint matching".
 *
 * Returning null rather than throwing is what makes the losing trigger a no-op:
 * a mirrored sell arriving after redemption has claimed the position is not an
 * error, it is the race resolving.
 */
export async function claimPolymarketPositionExit(input) {
    const rows = await query(`INSERT INTO polymarket_position_exits
       (user_id, position_key, condition_id, outcome_token_id, exit_trigger, status)
     VALUES ($1, $2, $3, $4, $5, 'claimed')
     ON CONFLICT (user_id, position_key)
       WHERE status IN ('claimed', 'confirmed')
       DO NOTHING
     RETURNING id,
               position_key AS "positionKey",
               condition_id AS "conditionId",
               user_id      AS "userId",
               exit_trigger AS "exitTrigger"`, [
        input.userId ?? null,
        input.positionKey,
        input.conditionId,
        input.outcomeTokenId,
        input.exitTrigger
    ]);
    return rows[0] ?? null;
}
/**
 * The live exit claims for a set of positions, so a caller can see which trigger
 * won before it tries to claim.
 *
 * Advisory only: the claim insert is still the authority, because anything read
 * here can be superseded between the read and the write. It exists so a sweep can
 * report "already exiting via mirrored-sell" instead of an unexplained skip.
 */
export async function getPolymarketPositionExits(positionKeys, userId) {
    if (positionKeys.length === 0)
        return [];
    return query(`SELECT id,
            position_key AS "positionKey",
            exit_trigger AS "exitTrigger",
            status
       FROM polymarket_position_exits
      WHERE position_key = ANY($1::text[])
        AND user_id IS NOT DISTINCT FROM $2
        AND status IN ('claimed', 'confirmed')`, [[...positionKeys], userId ?? null]);
}
/**
 * Record an exit that settled.
 *
 * Requires evidence — a settlement hash for a redemption, a copy execution id for
 * a mirrored sell — because a table constraint refuses a confirmed row without
 * one. A confirmed exit with nothing to verify against reads as a closed position
 * that may still be held.
 */
export async function confirmPolymarketPositionExit(input) {
    await query(`UPDATE polymarket_position_exits
        SET status = 'confirmed',
            transaction_hash = $2,
            copy_execution_id = $3,
            confirmed_at = now()
      WHERE id = $1 AND status = 'claimed'`, [input.id, input.transactionHash ?? null, input.copyExecutionId ?? null]);
}
/**
 * Release a claim as failed so the race can be re-run.
 *
 * Distinct from deleting the row on purpose: the failure reason is the only
 * record of *why* a position went unexited, and losing it turns a recurring venue
 * problem into an invisible one. The partial unique index excludes 'failed', so a
 * released position is immediately eligible for either trigger again — safe
 * because redemption has no deadline.
 */
export async function releasePolymarketPositionExit(input) {
    await query(`UPDATE polymarket_position_exits
        SET status = 'failed', failure_reason = $2
      WHERE id = $1 AND status = 'claimed'`, [input.id, input.reason.slice(0, 500)]);
}
/**
 * Recover claims stranded by a crash between claim and confirm.
 *
 * Marked `failed` rather than retried silently, for the same reason as the
 * redemption ledger: the exit may or may not have happened, and a stuck 'claimed'
 * row would block the position forever while a silent retry could double-exit it.
 * A human-visible failure is the only honest state.
 */
export async function releaseStalePolymarketPositionExits(olderThanMs) {
    const rows = await query(`UPDATE polymarket_position_exits
        SET status = 'failed',
            failure_reason = 'exit claim expired before confirmation'
      WHERE status = 'claimed'
        AND claimed_at < now() - ($1::bigint * interval '1 millisecond')
      RETURNING id`, [olderThanMs]);
    return rows.length;
}
//# sourceMappingURL=polymarket-exit-queries.js.map