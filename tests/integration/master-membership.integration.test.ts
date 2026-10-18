import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../../packages/db/src/client.js';
import { forUser } from '../../packages/db/src/tenancy.js';
import { createUser } from '../../packages/db/src/users.js';
import {
  MASTER_MEMBERSHIP_CAP,
  MEMBERSHIP_USER_MESSAGE,
  MasterMembershipFullError
} from '../../packages/db/src/master-membership.js';
import {
  beginWindDown,
  endSubscription,
  subscribeToWallet
} from '../../packages/db/src/subscriptions.js';

/**
 * Master membership cap (`S4-M43`) and slot release (`S4-M44`), migration `056`.
 *
 * **NEVER EXECUTED.** There is no database in the environment this was written
 * in, so every assertion below is an unverified claim about SQL. That is stated
 * rather than implied: the unit suite in
 * `packages/db/src/master-membership.test.ts` proves the decision function and
 * the statement text, and nothing outside this file proves that PostgreSQL
 * accepts these statements or that the constraints bind.
 *
 * These cases exist here because they are **only** answerable with a real
 * database:
 *
 *   1. **Concurrency.** A `COUNT(*) < 50` guard is exceeded by exactly the
 *      number of concurrent racers. Only firing real concurrent transactions at
 *      a real Postgres shows whether the cap holds. A mocked client cannot fail
 *      this test, so it cannot pass it either.
 *   2. **The constraints actually exist and bind.** A unit test can assert the
 *      migration's *text*; only Postgres can assert that the partial unique
 *      index rejects a duplicate ordinal and that the coherence CHECK rejects a
 *      leaver holding one.
 *   3. **Slot release round-trips.** That winding down frees an ordinal and a
 *      new joiner immediately gets it is a claim about three statements agreeing
 *      with one CHECK constraint.
 *
 * Run with `pnpm test:integration` against a database whose name ends in
 * `_integration` or `_test`.
 */

const runId = randomUUID().replace(/-/g, '').slice(0, 12);
const userIds: string[] = [];
const walletAddresses: string[] = [];

function walletFor(suffix: string): string {
  const address = `solana:SWATmem${runId}${suffix}`.slice(0, 100);
  walletAddresses.push(address);
  return address;
}

async function makeUser() {
  const user = await createUser({
    email: `s4m43-${randomUUID()}@example.com`,
    password: 'a-very-long-password',
    // `operator` tracks 25 wallets; the tracked-wallet quota is a per-USER
    // limit and must not be what refuses anyone in these cases, so each case
    // uses one wallet per user.
    tier: 'operator'
  });
  userIds.push(user.id);
  return user;
}

async function subscribe(userId: string, tier: 'operator', address: string) {
  return subscribeToWallet(forUser(userId), {
    walletAddress: address,
    chain: 'solana',
    tier,
    tierExpiresAt: null
  });
}

async function slotsHeld(address: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM user_wallet_subscriptions
      WHERE wallet_address = $1 AND membership_slot IS NOT NULL`,
    [address]
  );
  return Number(result.rows[0]?.count ?? '0');
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

describe('membership cap under concurrency (S4-M43)', () => {
  it('admits at most the cap when every subscribe arrives at once', async () => {
    // The whole reason the cap is a constraint rather than a count. With
    // check-then-insert, all cap+10 of these observe a pre-insert occupancy
    // below the cap and all cap+10 insert.
    const address = walletFor('race');
    const users = [];
    for (let index = 0; index < MASTER_MEMBERSHIP_CAP + 10; index += 1) {
      users.push(await makeUser());
    }

    const results = await Promise.allSettled(
      users.map((user) => subscribe(user.id, 'operator', address))
    );

    const granted = results.filter((entry) => entry.status === 'fulfilled').length;
    expect(granted).toBe(MASTER_MEMBERSHIP_CAP);
    expect(await slotsHeld(address)).toBe(MASTER_MEMBERSHIP_CAP);

    // Every refusal is the membership refusal, not a stray unique violation
    // leaking out as a 500.
    for (const entry of results) {
      if (entry.status === 'rejected') {
        expect(entry.reason).toBeInstanceOf(MasterMembershipFullError);
        expect((entry.reason as Error).message).toBe(MEMBERSHIP_USER_MESSAGE);
        expect((entry.reason as Error).message).not.toMatch(/\d/);
      }
    }
  });

  it('refuses the next joiner once the cap is reached', async () => {
    const address = walletFor('full');
    const users = [];
    for (let index = 0; index < MASTER_MEMBERSHIP_CAP; index += 1) {
      users.push(await makeUser());
    }
    for (const user of users) await subscribe(user.id, 'operator', address);

    const outsider = await makeUser();
    await expect(subscribe(outsider.id, 'operator', address)).rejects.toBeInstanceOf(
      MasterMembershipFullError
    );
  });
});

describe('the database, not the code, is what enforces the cap', () => {
  it('rejects a second row claiming the same ordinal', async () => {
    const address = walletFor('dupe');
    const [first, second] = await Promise.all([makeUser(), makeUser()]);
    await subscribe(first!.id, 'operator', address);
    await subscribe(second!.id, 'operator', address);

    // Hand-written, bypassing every application guard. The partial unique index
    // is what has to refuse this, or the cap is only as good as the code above.
    await expect(
      pool.query(
        `UPDATE user_wallet_subscriptions SET membership_slot = 1
          WHERE wallet_address = $1 AND user_id = $2`,
        [address, second!.id]
      )
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('rejects an ordinal above the cap', async () => {
    const address = walletFor('range');
    const user = await makeUser();
    await subscribe(user.id, 'operator', address);

    await expect(
      pool.query(
        `UPDATE user_wallet_subscriptions SET membership_slot = $3
          WHERE wallet_address = $1 AND user_id = $2`,
        [address, user.id, MASTER_MEMBERSHIP_CAP + 1]
      )
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects a winding-down row that still holds an ordinal', async () => {
    const address = walletFor('leaver');
    const user = await makeUser();
    await subscribe(user.id, 'operator', address);

    // The coherence CHECK is what makes "a leaver holds no slot" an invariant
    // rather than a convention that one forgetful UPDATE can break.
    await expect(
      pool.query(
        `UPDATE user_wallet_subscriptions
            SET state = 'winding_down', wound_down_at = NOW()
          WHERE wallet_address = $1 AND user_id = $2`,
        [address, user.id]
      )
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects an active row with no ordinal and no grandfathering flag', async () => {
    const address = walletFor('nullslot');
    const user = await makeUser();
    await subscribe(user.id, 'operator', address);

    // This is the hole the grandfathering flag closes: without it, an active row
    // with a NULL ordinal would have to be permitted forever and the cap would
    // silently stop being a cap.
    await expect(
      pool.query(
        `UPDATE user_wallet_subscriptions SET membership_slot = NULL
          WHERE wallet_address = $1 AND user_id = $2`,
        [address, user.id]
      )
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('a dropped copier does not get their slot back (S4-M44)', () => {
  it('frees the ordinal on wind-down and hands it to the next joiner', async () => {
    const address = walletFor('release');
    const leaver = await makeUser();
    await subscribe(leaver.id, 'operator', address);
    expect(await slotsHeld(address)).toBe(1);

    await beginWindDown(forUser(leaver.id), address);
    // Winding down releases the ordinal. It does NOT stop the sell mirror —
    // that is derived from `state`, and the row is still `winding_down`.
    expect(await slotsHeld(address)).toBe(0);
    const stillEnumerated = await pool.query<{ state: string }>(
      `SELECT state FROM user_wallet_subscriptions
        WHERE wallet_address = $1 AND user_id = $2`,
      [address, leaver.id]
    );
    expect(stillEnumerated.rows[0]?.state).toBe('winding_down');

    const newcomer = await makeUser();
    await subscribe(newcomer.id, 'operator', address);
    expect(await slotsHeld(address)).toBe(1);
  });

  it('refuses a returning copier whose slot was taken while they were away', async () => {
    const address = walletFor('noreclaim');
    const leaver = await makeUser();
    await subscribe(leaver.id, 'operator', address);
    await endSubscription(forUser(leaver.id), address);

    // Fill every ordinal with other people.
    const others = await Promise.all(
      Array.from({ length: MASTER_MEMBERSHIP_CAP }, () => makeUser())
    );
    for (const other of others) await subscribe(other.id, 'operator', address);

    // No grandfathering, no waitlist priority: the slot was not theirs once
    // released, and the refusal reads exactly the same as for a stranger.
    await expect(subscribe(leaver.id, 'operator', address)).rejects.toBeInstanceOf(
      MasterMembershipFullError
    );
  });

  it('does not let a winding-down member occupy a slot they can then reclaim', async () => {
    const address = walletFor('cycle');
    const cycler = await makeUser();
    await subscribe(cycler.id, 'operator', address);
    await beginWindDown(forUser(cycler.id), address);

    const others = await Promise.all(
      Array.from({ length: MASTER_MEMBERSHIP_CAP }, () => makeUser())
    );
    for (const other of others) await subscribe(other.id, 'operator', address);

    // Their ordinal went back into the pool when they wound down, so changing
    // their mind now competes for a free one and loses. Exempting this path
    // would let a user hold a slot indefinitely by cycling.
    await expect(subscribe(cycler.id, 'operator', address)).rejects.toBeInstanceOf(
      MasterMembershipFullError
    );
  });

  it('is idempotent for an existing member of a full master', async () => {
    const address = walletFor('idem');
    const users = await Promise.all(
      Array.from({ length: MASTER_MEMBERSHIP_CAP }, () => makeUser())
    );
    for (const user of users) await subscribe(user.id, 'operator', address);

    // An existing member must not be refused their own wallet, and must not
    // burn a second ordinal.
    const again = await subscribe(users[0]!.id, 'operator', address);
    expect(again.subscriptionCreated).toBe(false);
    expect(await slotsHeld(address)).toBe(MASTER_MEMBERSHIP_CAP);
  });
});
