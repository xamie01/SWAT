import { query } from './client.js';

/**
 * Position-scoped exit claims for the Polymarket exit race (checklist `S4-M19`).
 *
 * Two independent triggers can exit one Polymarket position: the master closing
 * their position, which mirrors as a sell, and the market resolving, which
 * redeems. Both are tracked and the earlier one acts. Because a master selling
 * moments before resolution is the ordinary case rather than the edge, the race
 * needs an exactly-once guard, and it has to be keyed on the **position**.
 *
 * **Why not reuse `claimPolymarketRedemption`.** That claim is keyed
 * `(user_id, condition_id)`, which is right for the on-chain call —
 * `redeemPositions({conditionId})` takes no amount and redeems both outcomes of
 * the condition. But a condition holds two outcome positions. A condition-keyed
 * guard would let a mirrored sell of YES suppress the exit of NO on the same
 * condition, which is the outcome-collapsing mistake `S4-M20` forbids. So the two
 * claims coexist and mean different things: `polymarket_redemptions` guards the
 * on-chain redemption once per condition, `polymarket_position_exits` guards the
 * race once per position.
 *
 * Lives in its own file rather than in `polymarket-redemptions.ts` because the
 * exit race is not redemption — redemption is one of its two outcomes.
 */

/**
 * Which entrant won a position's exit race.
 *
 * `manual` added by `S4-M45`: a user exiting their own position is a third
 * entrant in the SAME race as the master's sell and the market's resolution, not
 * a separate path -- a user tapping exit moments before the master sells is the
 * ordinary case, and a second path would sell the position twice. Widened in
 * migration `057` on the `exit_trigger` CHECK.
 */
export type PolymarketExitTriggerName = 'mirrored-sell' | 'redemption' | 'manual';

export interface PolymarketPositionExitClaim {
  readonly id: string;
  readonly positionKey: string;
  readonly conditionId: string;
  readonly userId: string | null;
  readonly exitTrigger: PolymarketExitTriggerName;
}

export interface PolymarketPositionExitState {
  readonly id: string;
  readonly positionKey: string;
  readonly exitTrigger: PolymarketExitTriggerName;
  readonly status: 'claimed' | 'confirmed' | 'failed';
}

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
export async function claimPolymarketPositionExit(input: {
  positionKey: string;
  conditionId: string;
  outcomeTokenId: string;
  exitTrigger: PolymarketExitTriggerName;
  userId?: string | null;
}): Promise<PolymarketPositionExitClaim | null> {
  const rows = await query<PolymarketPositionExitClaim>(
    `INSERT INTO polymarket_position_exits
       (user_id, position_key, condition_id, outcome_token_id, exit_trigger, status)
     VALUES ($1, $2, $3, $4, $5, 'claimed')
     ON CONFLICT (user_id, position_key)
       WHERE status IN ('claimed', 'confirmed')
       DO NOTHING
     RETURNING id,
               position_key AS "positionKey",
               condition_id AS "conditionId",
               user_id      AS "userId",
               exit_trigger AS "exitTrigger"`,
    [
      input.userId ?? null,
      input.positionKey,
      input.conditionId,
      input.outcomeTokenId,
      input.exitTrigger
    ]
  );
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
export async function getPolymarketPositionExits(
  positionKeys: readonly string[],
  userId?: string | null
): Promise<PolymarketPositionExitState[]> {
  if (positionKeys.length === 0) return [];
  return query<PolymarketPositionExitState>(
    `SELECT id,
            position_key AS "positionKey",
            exit_trigger AS "exitTrigger",
            status
       FROM polymarket_position_exits
      WHERE position_key = ANY($1::text[])
        AND user_id IS NOT DISTINCT FROM $2
        AND status IN ('claimed', 'confirmed')`,
    [[...positionKeys], userId ?? null]
  );
}

/**
 * Record an exit that settled.
 *
 * Requires evidence — a settlement hash for a redemption, a copy execution id for
 * a mirrored sell — because a table constraint refuses a confirmed row without
 * one. A confirmed exit with nothing to verify against reads as a closed position
 * that may still be held.
 */
export async function confirmPolymarketPositionExit(input: {
  id: string;
  transactionHash?: string | null;
  copyExecutionId?: string | null;
}): Promise<void> {
  await query(
    `UPDATE polymarket_position_exits
        SET status = 'confirmed',
            transaction_hash = $2,
            copy_execution_id = $3,
            confirmed_at = now()
      WHERE id = $1 AND status = 'claimed'`,
    [input.id, input.transactionHash ?? null, input.copyExecutionId ?? null]
  );
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
export async function releasePolymarketPositionExit(input: {
  id: string;
  reason: string;
}): Promise<void> {
  await query(
    `UPDATE polymarket_position_exits
        SET status = 'failed', failure_reason = $2
      WHERE id = $1 AND status = 'claimed'`,
    [input.id, input.reason.slice(0, 500)]
  );
}

/**
 * Recover claims stranded by a crash between claim and confirm.
 *
 * Marked `failed` rather than retried silently, for the same reason as the
 * redemption ledger: the exit may or may not have happened, and a stuck 'claimed'
 * row would block the position forever while a silent retry could double-exit it.
 * A human-visible failure is the only honest state.
 */
export async function releaseStalePolymarketPositionExits(
  olderThanMs: number
): Promise<number> {
  const rows = await query<{ id: string }>(
    `UPDATE polymarket_position_exits
        SET status = 'failed',
            failure_reason = 'exit claim expired before confirmation'
      WHERE status = 'claimed'
        AND claimed_at < now() - ($1::bigint * interval '1 millisecond')
      RETURNING id`,
    [olderThanMs]
  );
  return rows.length;
}
