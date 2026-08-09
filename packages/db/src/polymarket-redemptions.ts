import { query } from './client.js';

/**
 * Redemption ledger for resolved Polymarket positions (checklist S3-18).
 *
 * A resolved market stops accepting orders, so a winning position cannot be
 * sold — redemption is the only exit. `redeemPositions()` converts each winning
 * outcome token into 1 pUSD and each losing token into 0, with no deadline.
 *
 * The claim/confirm split matters because `redeemPositions()` takes no amount
 * and redeems the wallet's entire balance for both outcomes. A second call after
 * a successful first is an on-chain no-op that still burns gas and still returns
 * a transaction hash, which a naive reconciler would read as a fresh fill. The
 * partial unique index on `(user_id, condition_id) WHERE status IN
 * ('claimed','confirmed')` is what makes the sweep safe to run on a timer.
 */

export interface RedemptionClaim {
  readonly id: string;
  readonly conditionId: string;
  readonly userId: string | null;
}

export interface RedeemableMarket {
  readonly conditionId: string;
  readonly winningTokenId: string | null;
  readonly resolvedOutcome: string | null;
}

/**
 * Markets that have resolved and hold a confirmed position, minus any already
 * claimed or confirmed.
 *
 * Scoped to *confirmed* fills on purpose: a pending or reconciliation-required
 * execution has no proven token balance, and redeeming against a position we
 * cannot yet prove we hold would produce a redemption row with no basis.
 */
export async function listRedeemablePolymarketMarkets(
  limit = 50
): Promise<RedeemableMarket[]> {
  return query<RedeemableMarket>(
    `SELECT DISTINCT
       m.condition_id   AS "conditionId",
       m.winning_token_id AS "winningTokenId",
       m.resolved_outcome AS "resolvedOutcome"
     FROM polymarket_markets m
     JOIN polymarket_trades t ON t.condition_id = m.condition_id
     WHERE m.resolution_status = 'resolved'
       AND NOT EXISTS (
         SELECT 1 FROM polymarket_redemptions r
         WHERE r.condition_id = m.condition_id
           AND r.status IN ('claimed', 'confirmed')
       )
     ORDER BY m.condition_id
     LIMIT $1`,
    [limit]
  );
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
export async function claimPolymarketRedemption(input: {
  conditionId: string;
  userId?: string | null;
}): Promise<RedemptionClaim | null> {
  const rows = await query<RedemptionClaim>(
    `INSERT INTO polymarket_redemptions (condition_id, user_id, status)
     VALUES ($1, $2, 'claimed')
     ON CONFLICT (user_id, condition_id)
       WHERE status IN ('claimed', 'confirmed')
       DO NOTHING
     RETURNING id, condition_id AS "conditionId", user_id AS "userId"`,
    [input.conditionId, input.userId ?? null]
  );
  return rows[0] ?? null;
}

/**
 * Records a settled redemption.
 *
 * The transaction hash is required by a table constraint, not merely by
 * convention: a confirmed row without evidence reads as settled money that
 * cannot be verified against the chain.
 */
export async function confirmPolymarketRedemption(input: {
  id: string;
  transactionHash: string;
  redeemedCollateral: string;
  winningTokenId?: string | null;
}): Promise<void> {
  await query(
    `UPDATE polymarket_redemptions
       SET status = 'confirmed',
           transaction_hash = $2,
           redeemed_collateral = $3,
           winning_token_id = $4,
           confirmed_at = now()
     WHERE id = $1 AND status = 'claimed'`,
    [input.id, input.transactionHash, input.redeemedCollateral, input.winningTokenId ?? null]
  );
}

/**
 * Releases a claim as failed so a later sweep can retry.
 *
 * Deliberately distinct from deleting the row: the failure reason is the only
 * record of *why* a market went unredeemed, and losing it turns a recurring
 * venue problem into an invisible one.
 */
export async function failPolymarketRedemption(input: {
  id: string;
  reason: string;
}): Promise<void> {
  await query(
    `UPDATE polymarket_redemptions
       SET status = 'failed', failure_reason = $2
     WHERE id = $1 AND status = 'claimed'`,
    [input.id, input.reason.slice(0, 500)]
  );
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
export async function releaseStalePolymarketRedemptionClaims(
  olderThanMs: number
): Promise<number> {
  const rows = await query<{ id: string }>(
    `UPDATE polymarket_redemptions
       SET status = 'failed',
           failure_reason = 'claim expired before confirmation'
     WHERE status = 'claimed'
       AND claimed_at < now() - ($1::bigint * interval '1 millisecond')
     RETURNING id`,
    [olderThanMs]
  );
  return rows.length;
}
