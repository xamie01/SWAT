import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../../packages/db/src/client.js';
import { forUser } from '../../packages/db/src/tenancy.js';
import { createUser, type UserRecord } from '../../packages/db/src/users.js';
import {
  beginWindDown,
  endSubscription,
  getSubscriptionState,
  IllegalSubscriptionTransitionError,
  isSubscribed,
  listWalletSubscriptions,
  QuotaExceededError,
  requestCloseAll,
  subscribeToWallet
} from '../../packages/db/src/subscriptions.js';

/**
 * Subscription lifecycle states (`S4-M3`, ADR-0005 §3.7, migration `051`).
 *
 * `packages/db/src/subscriptions.test.ts` covers the state machine with no
 * database. What only PostgreSQL can prove is here:
 *
 *  1. The CHECK constraints genuinely reject an incoherent row. A state column
 *     whose invariant lives only in TypeScript is one manual UPDATE away from a
 *     `winding_down` row with no `wound_down_at`, and then "how long has this
 *     been winding down?" has no answer for exactly the rows that need it.
 *  2. A re-subscribe after `ended` is representable under the primary key
 *     `(user_id, wallet_address)`. If it were not, a user who ended a
 *     subscription could never restart it, and the failure would arrive as a
 *     duplicate-key error at the worst possible moment.
 *  3. `active_since` moves forward on revival while `created_at` does not —
 *     the forward-only boundary S4-M2 filters on.
 *  4. The quota counts `winding_down` and ignores `ended`.
 */

const runId = randomUUID().replace(/-/g, '').slice(0, 12);
const userIds: string[] = [];
const walletAddresses: string[] = [];

function walletFor(suffix: string): string {
  const address = `solana:SWATm3${runId}${suffix}`.slice(0, 100);
  walletAddresses.push(address);
  return address;
}

async function makeUser(tier: 'free' | 'operator' | 'ultra' = 'free') {
  const user = await createUser({
    email: `s4m3-${randomUUID()}@example.com`,
    password: 'a-very-long-password',
    tier
  });
  userIds.push(user.id);
  return user;
}

async function subscribe(user: UserRecord, address: string) {
  return subscribeToWallet(forUser(user.id), {
    walletAddress: address,
    chain: 'solana',
    tier: user.tier,
    tierExpiresAt: user.tierExpiresAt
  });
}

async function readRow(userId: string, address: string) {
  const result = await pool.query<{
    state: string;
    created_at: Date;
    active_since: Date;
    wound_down_at: Date | null;
    ended_at: Date | null;
    close_all_requested_at: Date | null;
  }>(
    `SELECT state, created_at, active_since, wound_down_at, ended_at, close_all_requested_at
       FROM user_wallet_subscriptions
      WHERE user_id = $1 AND wallet_address = $2`,
    [userId, address]
  );
  return result.rows[0];
}

afterAll(async () => {
  if (walletAddresses.length > 0) {
    await pool.query('DELETE FROM user_wallet_subscriptions WHERE wallet_address = ANY($1)', [
      walletAddresses
    ]);
    await pool.query('DELETE FROM wallets WHERE address = ANY($1)', [walletAddresses]);
  }
  if (userIds.length > 0) {
    await pool.query('DELETE FROM audit_log WHERE actor_id = ANY($1)', [userIds]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [userIds]);
  }
});

describe('migration 051 schema', () => {
  it('defaults an existing-shape insert to active with active_since set', async () => {
    const user = await makeUser();
    const address = walletFor('def');
    await subscribe(user, address);

    const row = await readRow(user.id, address);
    expect(row?.state).toBe('active');
    expect(row?.active_since).toBeInstanceOf(Date);
    expect(row?.wound_down_at).toBeNull();
    expect(row?.ended_at).toBeNull();
  });

  it('rejects a state the CHECK does not know', async () => {
    const user = await makeUser();
    const address = walletFor('badst');
    await subscribe(user, address);

    await expect(
      pool.query(
        `UPDATE user_wallet_subscriptions SET state = 'paused'
          WHERE user_id = $1 AND wallet_address = $2`,
        [user.id, address]
      )
    ).rejects.toThrow(/chk_subscription_state/);
  });

  it('rejects winding_down with no wound_down_at', async () => {
    const user = await makeUser();
    const address = walletFor('nostamp');
    await subscribe(user, address);

    await expect(
      pool.query(
        `UPDATE user_wallet_subscriptions SET state = 'winding_down'
          WHERE user_id = $1 AND wallet_address = $2`,
        [user.id, address]
      )
    ).rejects.toThrow(/chk_subscription_state_stamps/);
  });

  it('rejects ended with no ended_at', async () => {
    const user = await makeUser();
    const address = walletFor('noend');
    await subscribe(user, address);

    await expect(
      pool.query(
        `UPDATE user_wallet_subscriptions SET state = 'ended'
          WHERE user_id = $1 AND wallet_address = $2`,
        [user.id, address]
      )
    ).rejects.toThrow(/chk_subscription_state_stamps/);
  });

  it('rejects an active row carrying wind-down or close-all stamps', async () => {
    const user = await makeUser();
    const address = walletFor('activest');
    await subscribe(user, address);

    // An active subscription with a wind-down stamp would read as sells-only to
    // an operator and buys-and-sells to the fan-out.
    await expect(
      pool.query(
        `UPDATE user_wallet_subscriptions SET wound_down_at = NOW()
          WHERE user_id = $1 AND wallet_address = $2`,
        [user.id, address]
      )
    ).rejects.toThrow(/chk_subscription_state_stamps/);

    await expect(
      pool.query(
        `UPDATE user_wallet_subscriptions SET close_all_requested_at = NOW()
          WHERE user_id = $1 AND wallet_address = $2`,
        [user.id, address]
      )
    ).rejects.toThrow(/chk_subscription_state_stamps/);
  });

  it('keeps the partial index the fan-out path depends on', async () => {
    // Without it every mirror scans the accumulated history of everyone who
    // ever left this master, because `ended` rows are retained forever.
    const indexes = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE tablename = 'user_wallet_subscriptions'`
    );
    const names = indexes.rows.map((row) => row.indexname);
    expect(names).toContain('idx_uws_wallet_live');
    expect(names).toContain('idx_uws_winding_down');
  });
});

describe('wind-down lifecycle', () => {
  it('walks active -> winding_down -> ended and keeps both stamps', async () => {
    const user = await makeUser();
    const address = walletFor('walk');
    await subscribe(user, address);
    const scope = forUser(user.id);

    const wound = await beginWindDown(scope, address);
    expect(wound.changed).toBe(true);
    expect(wound.subscription.state).toBe('winding_down');
    expect(wound.subscription.woundDownAt).toBeInstanceOf(Date);

    // Still listed and still gated-in: the user has open positions being
    // mirrored out, so their per-wallet endpoints must keep working.
    expect(await isSubscribed(scope, address)).toBe(true);
    expect((await listWalletSubscriptions(scope)).map((s) => s.state)).toEqual(['winding_down']);

    const ended = await endSubscription(scope, address);
    expect(ended.subscription.state).toBe('ended');
    expect(ended.subscription.endedAt).toBeInstanceOf(Date);
    // Preserved: "how long did this take to close" is the operational question.
    expect(ended.subscription.woundDownAt).toBeInstanceOf(Date);

    // Hidden from the user, but retained for attribution.
    expect(await isSubscribed(scope, address)).toBe(false);
    expect(await listWalletSubscriptions(scope)).toHaveLength(0);
    expect((await getSubscriptionState(scope, address))?.state).toBe('ended');
    expect(await readRow(user.id, address)).toBeDefined();
  });

  it('ends directly from active when nothing was ever opened', async () => {
    const user = await makeUser();
    const address = walletFor('direct');
    await subscribe(user, address);

    const ended = await endSubscription(forUser(user.id), address);
    expect(ended.subscription.state).toBe('ended');
    // No fictitious wind-down it would then sit in forever.
    expect(ended.subscription.woundDownAt).toBeNull();
  });

  it('refuses to wind down an ended subscription', async () => {
    const user = await makeUser();
    const address = walletFor('reended');
    await subscribe(user, address);
    const scope = forUser(user.id);
    await endSubscription(scope, address);

    await expect(beginWindDown(scope, address)).rejects.toBeInstanceOf(
      IllegalSubscriptionTransitionError
    );
    expect((await getSubscriptionState(scope, address))?.state).toBe('ended');
  });

  it('records close-all once and winds down in the same step', async () => {
    const user = await makeUser();
    const address = walletFor('closeall');
    await subscribe(user, address);
    const scope = forUser(user.id);

    const first = await requestCloseAll(scope, address);
    expect(first.subscription.state).toBe('winding_down');
    expect(first.subscription.closeAllRequestedAt).toBeInstanceOf(Date);

    const second = await requestCloseAll(scope, address);
    // A second click is a no-op, not a second round of sells.
    expect(second.changed).toBe(false);
    expect(second.subscription.closeAllRequestedAt).toEqual(first.subscription.closeAllRequestedAt);
  });
});

describe('re-subscribe', () => {
  it('revives an ended subscription in place and moves the forward-only boundary', async () => {
    const user = await makeUser();
    const address = walletFor('revive');
    await subscribe(user, address);
    const scope = forUser(user.id);

    const before = await readRow(user.id, address);
    await endSubscription(scope, address);

    // The primary key forbids a second row, so this must not raise a duplicate
    // key — the transition IS the re-subscribe.
    const revived = await subscribe(user, address);
    expect(revived.subscriptionCreated).toBe(true);
    expect(revived.subscription.state).toBe('active');

    const after = await readRow(user.id, address);
    expect(after?.created_at).toEqual(before?.created_at);
    // Forward-only (S4-M2): the boundary moves even though created_at does not.
    expect(after!.active_since.getTime()).toBeGreaterThan(before!.active_since.getTime());
    expect(after?.wound_down_at).toBeNull();
    expect(after?.ended_at).toBeNull();

    const rows = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM user_wallet_subscriptions
        WHERE user_id = $1 AND wallet_address = $2`,
      [user.id, address]
    );
    expect(rows.rows[0]?.count).toBe('1');
  });

  it('resumes a winding-down subscription without a second quota charge', async () => {
    // Free tier tracks 3, so a wrongly-charged resume at the boundary would
    // refuse the user their own wallet back.
    const user = await makeUser('free');
    const scope = forUser(user.id);
    const addresses = [walletFor('q1'), walletFor('q2'), walletFor('q3')];
    for (const address of addresses) await subscribe(user, address);

    await beginWindDown(scope, addresses[0]!);
    const resumed = await subscribe(user, addresses[0]!);
    expect(resumed.subscription.state).toBe('active');
    expect(resumed.subscriptionCreated).toBe(false);
  });

  it('counts winding_down against the quota and ignores ended', async () => {
    const user = await makeUser('free');
    const scope = forUser(user.id);
    const addresses = [walletFor('c1'), walletFor('c2'), walletFor('c3')];
    for (const address of addresses) await subscribe(user, address);

    // Winding down still consumes the resource: the wallet is still indexed and
    // its sells are still mirrored. Otherwise the quota is bypassable by
    // unsubscribing from each wallet in turn.
    await beginWindDown(scope, addresses[0]!);
    await expect(subscribe(user, walletFor('c4'))).rejects.toBeInstanceOf(QuotaExceededError);

    // Ended does not: a finished subscription must not occupy a slot forever.
    await endSubscription(scope, addresses[0]!);
    const fifth = await subscribe(user, walletFor('c5'));
    expect(fifth.subscriptionCreated).toBe(true);
  });
});
