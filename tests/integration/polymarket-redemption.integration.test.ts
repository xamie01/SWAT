import { randomUUID } from 'node:crypto';
import { describe, it, expect, afterAll } from 'vitest';
import { pool } from '../../packages/db/src/client.js';
import {
  claimPolymarketRedemption,
  confirmPolymarketRedemption,
  failPolymarketRedemption,
  releaseStalePolymarketRedemptionClaims
} from '../../packages/db/src/polymarket-redemptions.js';

/**
 * Exactly-once redemption of resolved Polymarket positions (checklist S3-18).
 *
 * A resolved market stops accepting orders, so a winning position cannot be
 * sold — redemption is the only exit. `redeemPositions()` takes no amount and
 * redeems the wallet's whole balance for both outcomes, so a second call after a
 * successful first is an on-chain no-op that still burns gas and still returns a
 * transaction hash a reconciler would read as a fresh fill.
 *
 * These tests exist because the first version of the guard was **inert**. The
 * partial unique index was on `(user_id, condition_id)`, but `user_id` is NULL
 * for the whole of Stage 3, and by default NULL never conflicts with NULL — so
 * two concurrent sweeps both claimed the same market. A direct SQL probe caught
 * it; nothing in the type system or the test suite would have.
 */

const conditionIds: string[] = [];

function conditionId(label: string): string {
  const id = `it-redeem-${label}-${randomUUID().slice(0, 8)}`;
  conditionIds.push(id);
  return id;
}

afterAll(async () => {
  if (conditionIds.length > 0) {
    await pool.query('DELETE FROM polymarket_redemptions WHERE condition_id = ANY($1)', [
      conditionIds
    ]);
  }
});

describe('polymarket redemption claims', () => {
  it('grants a claim to exactly one of two concurrent sweeps', async () => {
    const condition = conditionId('concurrent');

    // Fired together rather than sequentially: sequential calls would pass even
    // with a broken guard, because the second would see the first's committed row.
    const [first, second] = await Promise.all([
      claimPolymarketRedemption({ conditionId: condition }),
      claimPolymarketRedemption({ conditionId: condition })
    ]);

    const granted = [first, second].filter(Boolean);
    expect(granted).toHaveLength(1);

    const live = await pool.query(
      `SELECT count(*)::int AS n FROM polymarket_redemptions
        WHERE condition_id = $1 AND status IN ('claimed','confirmed')`,
      [condition]
    );
    expect(live.rows[0].n).toBe(1);
  });

  it('refuses a re-claim while a claim is still open', async () => {
    const condition = conditionId('open');
    expect(await claimPolymarketRedemption({ conditionId: condition })).not.toBe(null);
    expect(await claimPolymarketRedemption({ conditionId: condition })).toBe(null);
  });

  it('refuses a re-claim after the redemption is confirmed', async () => {
    // The important one: a confirmed redemption already moved the money. A
    // second claim would redeem again for zero gain and non-zero gas.
    const condition = conditionId('confirmed');
    const claim = await claimPolymarketRedemption({ conditionId: condition });
    expect(claim).not.toBe(null);

    await confirmPolymarketRedemption({
      id: claim!.id,
      transactionHash: '0xdeadbeef',
      redeemedCollateral: '100.000000',
      winningTokenId: 'token-yes'
    });

    expect(await claimPolymarketRedemption({ conditionId: condition })).toBe(null);
  });

  it('allows a retry after a failed attempt', async () => {
    // A venue error must not poison the market forever — the position is still
    // redeemable and the collateral is still owed.
    const condition = conditionId('retry');
    const claim = await claimPolymarketRedemption({ conditionId: condition });
    await failPolymarketRedemption({ id: claim!.id, reason: 'venue 500' });

    expect(await claimPolymarketRedemption({ conditionId: condition })).not.toBe(null);
  });

  it('rejects a confirmed row that carries no evidence', async () => {
    // Enforced by a CHECK constraint, not by convention: a confirmed row with no
    // transaction hash reads as settled money that cannot be verified on chain.
    const condition = conditionId('no-evidence');
    await expect(
      pool.query(
        `INSERT INTO polymarket_redemptions (condition_id, status) VALUES ($1, 'confirmed')`,
        [condition]
      )
    ).rejects.toThrow(/chk_polymarket_redemption_confirmed_evidence/);
  });

  it('releases a stale claim so a crashed sweep cannot block the market forever', async () => {
    const condition = conditionId('stale');
    const claim = await claimPolymarketRedemption({ conditionId: condition });
    expect(claim).not.toBe(null);

    // Backdate the claim past the recovery window.
    await pool.query(
      `UPDATE polymarket_redemptions SET claimed_at = now() - interval '2 hours' WHERE id = $1`,
      [claim!.id]
    );

    const released = await releaseStalePolymarketRedemptionClaims(60 * 60 * 1000);
    expect(released).toBeGreaterThanOrEqual(1);

    // Marked failed rather than retried silently: the on-chain call may or may
    // not have landed, and only a fresh claim should decide to try again.
    const row = await pool.query(
      'SELECT status, failure_reason FROM polymarket_redemptions WHERE id = $1',
      [claim!.id]
    );
    expect(row.rows[0].status).toBe('failed');
    expect(await claimPolymarketRedemption({ conditionId: condition })).not.toBe(null);
  });
});
