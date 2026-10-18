import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../../packages/db/src/client.js';
import { listFanoutCandidates } from '../../packages/db/src/fanout-candidates.js';
import { planFanout } from '../../packages/db/src/fanout-eligibility.js';
import {
  beginWindDown,
  endSubscription,
  subscribeToWallet
} from '../../packages/db/src/subscriptions.js';
import { crossTenantScope, forUser } from '../../packages/db/src/tenancy.js';
import { upsertUserBalance } from '../../packages/db/src/user-balances.js';
import { upsertUserExecutionSettings } from '../../packages/db/src/user-execution-settings.js';
import { createUser, type UserRecord } from '../../packages/db/src/users.js';

/**
 * The fetch half of fan-out enumeration (`S4-13`), against a real database.
 *
 * ⚠️ **WRITTEN AND NEVER RUN.** There is no database on the branch this landed
 * on, so every assertion below is a claim about PostgreSQL's behaviour and not an
 * observation of it. `packages/db/src/fanout-candidates.test.ts` covers the
 * mapping and the statement text with a mocked `query`; what only PostgreSQL can
 * prove is here, and it is exactly the set of things a mocked test silently
 * passes:
 *
 *   1. **The statement parses and every column exists.** A mocked `query` never
 *      touches the grammar. In particular `copy_positions position` uses
 *      `position` as a table alias — a `col_name_keyword` — and the correlated
 *      scalar subquery reaches out to `subscription.user_id` from inside it.
 *   2. **`ended` is genuinely not enumerated** and `winding_down` genuinely is.
 *      The unit test can only assert that the predicate appears in the text.
 *   3. **A user with no `user_execution_settings` row survives the join.** The
 *      unit test asserts `LEFT JOIN` is written; only the database proves the row
 *      comes back.
 *   4. **A suspended account is excluded**, which is the one filter here with no
 *      double cover in `planFanout`.
 *   5. **The open-position count is what `copy_positions` actually holds** —
 *      `confirmed_quantity > 0`, every chain, this tenant only. `NULLS NOT
 *      DISTINCT` on `uq_copy_positions_account_chain_token_user` (migration
 *      `050`) means a legacy operator row shares the natural key space, so a
 *      count that leaked across tenants would be invisible in a unit test.
 *
 * Deliberately **not** asserted: that the planner chooses
 * `idx_uws_wallet_live`. On a table holding a handful of fixture rows it will
 * choose a sequential scan whatever the index says, so an `EXPLAIN` assertion
 * here would either be vacuous or would fail for the wrong reason.
 */

const runId = randomUUID().replace(/-/g, '').slice(0, 12);
const userIds: string[] = [];
const walletAddresses: string[] = [];
const targetAccounts: string[] = [];

const sweep = () => crossTenantScope('fan-out enumeration integration test');

function walletFor(suffix: string): string {
  const address = `solana:SWATfo${runId}${suffix}`.slice(0, 100);
  walletAddresses.push(address);
  return address;
}

async function makeUser(tier: 'free' | 'operator' | 'ultra' = 'ultra'): Promise<UserRecord> {
  const user = await createUser({
    email: `s414-${randomUUID()}@example.com`,
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

/** A funded, freshly priced balance, so the balance gate is not what excludes. */
async function fund(user: UserRecord, usd: number, chain: 'solana' | 'polygon' = 'solana') {
  await upsertUserBalance(forUser(user.id), {
    chain,
    asset: chain === 'solana' ? 'SOL' : 'USDC',
    amount: 1,
    decimals: chain === 'solana' ? 9 : 6,
    usd,
    usdPricedAt: new Date()
  });
}

async function openPosition(
  user: UserRecord,
  chain: 'solana' | 'polygon',
  tokenMint: string,
  confirmedQuantity: number
) {
  const targetAccount = `paper:${chain}:${runId}`;
  targetAccounts.push(targetAccount);
  await pool.query(
    `INSERT INTO copy_positions (target_account, chain, token_mint, user_id, confirmed_quantity)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (target_account, chain, token_mint, user_id)
       DO UPDATE SET confirmed_quantity = EXCLUDED.confirmed_quantity`,
    [targetAccount, chain, tokenMint, user.id, confirmedQuantity]
  );
}

afterAll(async () => {
  if (targetAccounts.length > 0) {
    await pool.query('DELETE FROM copy_positions WHERE target_account = ANY($1)', [targetAccounts]);
  }
  if (walletAddresses.length > 0) {
    await pool.query('DELETE FROM user_wallet_subscriptions WHERE wallet_address = ANY($1)', [
      walletAddresses
    ]);
    await pool.query('DELETE FROM wallets WHERE address = ANY($1)', [walletAddresses]);
  }
  if (userIds.length > 0) {
    await pool.query('DELETE FROM user_balances WHERE user_id = ANY($1)', [userIds]);
    await pool.query('DELETE FROM user_execution_settings WHERE user_id = ANY($1)', [userIds]);
    await pool.query('DELETE FROM audit_log WHERE actor_id = ANY($1)', [userIds]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [userIds]);
  }
});

describe('listFanoutCandidates against PostgreSQL', () => {
  it('executes and returns the subscriber of a master wallet', async () => {
    const user = await makeUser();
    const master = walletFor('exec');
    await subscribe(user, master);
    await fund(user, 500);

    const candidates = await listFanoutCandidates(sweep(), {
      masterWalletAddress: master,
      chain: 'solana'
    });

    expect(candidates.map((candidate) => candidate.userId)).toEqual([user.id]);
    expect(candidates[0]).toMatchObject({
      subscriptionState: 'active',
      tier: 'ultra',
      openPositionCount: 0,
      knownBalanceUsd: 500
    });
  });

  it('returns nothing for a master nobody is subscribed to', async () => {
    const master = walletFor('lonely');
    // No `subscribeToWallet`, so no `wallets` row either — the query must simply
    // return zero rows rather than error.
    walletAddresses.pop();
    await expect(
      listFanoutCandidates(sweep(), { masterWalletAddress: master, chain: 'solana' })
    ).resolves.toEqual([]);
  });

  it('omits an ended subscription and keeps a winding-down one', async () => {
    const leaver = await makeUser();
    const winder = await makeUser();
    const master = walletFor('states');
    await subscribe(leaver, master);
    await subscribe(winder, master);
    await fund(leaver, 500);
    await fund(winder, 500);

    await endSubscription(forUser(leaver.id), master);
    await beginWindDown(forUser(winder.id), master);

    const candidates = await listFanoutCandidates(sweep(), {
      masterWalletAddress: master,
      chain: 'solana'
    });

    expect(candidates.map((candidate) => candidate.userId)).toEqual([winder.id]);
    expect(candidates[0]!.subscriptionState).toBe('winding_down');
  });

  it('lets a winding-down subscriber mirror a sell but not a buy', async () => {
    // The end-to-end version of the distinction `S4-13` exists to keep: dropping
    // these users strands the positions whose only exit is the master's sell.
    const winder = await makeUser();
    const master = walletFor('sells');
    await subscribe(winder, master);
    await fund(winder, 500);
    await upsertUserExecutionSettings(forUser(winder.id), { autoExecute: true });
    await beginWindDown(forUser(winder.id), master);

    const candidates = await listFanoutCandidates(sweep(), {
      masterWalletAddress: master,
      chain: 'solana'
    });
    const platform = {
      chainMode: { effectiveMode: 'paper' as const },
      minimumBalanceUsd: 0,
      capacity: { outcome: 'admit' as const }
    };
    const signal = {
      chain: 'solana' as const,
      masterWalletAddress: master,
      tokenMint: 'solana:SomeMint',
      score: 90,
      eventAt: new Date('2026-09-02T00:00:00.000Z')
    };

    expect(planFanout(candidates, { ...signal, direction: 'sell' }, platform).eligible)
      .toHaveLength(1);
    expect(planFanout(candidates, { ...signal, direction: 'buy' }, platform).exclusionCounts)
      .toEqual({ 'winding-down-buy-refused': 1 });
  });

  it('returns a user who has no execution settings row, filled with the defaults', async () => {
    const user = await makeUser();
    const master = walletFor('nosett');
    await subscribe(user, master);
    await fund(user, 500);

    const rows = await pool.query('SELECT 1 FROM user_execution_settings WHERE user_id = $1', [
      user.id
    ]);
    expect(rows.rowCount).toBe(0);

    const candidates = await listFanoutCandidates(sweep(), {
      masterWalletAddress: master,
      chain: 'solana'
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      autoExecute: false,
      killed: false,
      minSignalScore: 80,
      maxConcurrentPositions: 5
    });
  });

  it('reads a persisted settings row rather than the defaults', async () => {
    const user = await makeUser();
    const master = walletFor('sett');
    await subscribe(user, master);
    await fund(user, 500);
    await upsertUserExecutionSettings(forUser(user.id), {
      autoExecute: true,
      minSignalScore: 95,
      maxConcurrentPositions: 2
    });

    const candidates = await listFanoutCandidates(sweep(), {
      masterWalletAddress: master,
      chain: 'solana'
    });
    expect(candidates[0]).toMatchObject({
      autoExecute: true,
      minSignalScore: 95,
      maxConcurrentPositions: 2
    });
  });

  it('omits a suspended account, the one filter planFanout cannot report', async () => {
    const suspended = await makeUser();
    const active = await makeUser();
    const master = walletFor('susp');
    await subscribe(suspended, master);
    await subscribe(active, master);
    await pool.query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [suspended.id]);

    const candidates = await listFanoutCandidates(sweep(), {
      masterWalletAddress: master,
      chain: 'solana'
    });
    expect(candidates.map((candidate) => candidate.userId)).toEqual([active.id]);
  });

  it('counts open positions across chains and only for the asking tenant', async () => {
    const user = await makeUser();
    const other = await makeUser();
    const master = walletFor('poscnt');
    await subscribe(user, master);
    await fund(user, 500);

    await openPosition(user, 'solana', 'solana:MintA', 5);
    await openPosition(user, 'polygon', 'polygon:0xaaa', 3);
    // Closed: must not count.
    await openPosition(user, 'solana', 'solana:MintClosed', 0);
    // Another tenant's position: must not count.
    await openPosition(other, 'solana', 'solana:MintB', 9);

    const candidates = await listFanoutCandidates(sweep(), {
      masterWalletAddress: master,
      chain: 'solana'
    });
    expect(candidates[0]!.openPositionCount).toBe(2);
  });

  it('reports an unpriced balance as unknown rather than as zero', async () => {
    const user = await makeUser();
    const master = walletFor('unpr');
    await subscribe(user, master);
    await fund(user, 500);
    await upsertUserBalance(forUser(user.id), {
      chain: 'solana',
      asset: 'BONK',
      amount: 1000,
      decimals: 5,
      usd: null
    });

    const candidates = await listFanoutCandidates(sweep(), {
      masterWalletAddress: master,
      chain: 'solana'
    });
    expect(candidates[0]!.knownBalanceUsd).toBeNull();
  });

  it('reports a stale balance as unknown', async () => {
    const user = await makeUser();
    const master = walletFor('stale');
    await subscribe(user, master);
    await fund(user, 500);

    const candidates = await listFanoutCandidates(sweep(), {
      masterWalletAddress: master,
      chain: 'solana',
      // The row was written with `fetched_at = NOW()`, so a one-millisecond
      // window makes it stale without touching the clock.
      balanceMaxAgeMs: 1,
      now: new Date(Date.now() + 60_000)
    });
    expect(candidates[0]!.knownBalanceUsd).toBeNull();
  });

  it('does not let one chain balance feed poison another chain fan-out', async () => {
    // The reason the balance read is chain-scoped: `resolveKnownBalanceUsd`
    // returns null on any unpriced row it is given, so a cross-chain sum would
    // stop Polymarket copying because a Solana token could not be priced.
    const user = await makeUser();
    const master = walletFor('chsc');
    await subscribe(user, master);
    await fund(user, 250, 'polygon');
    await upsertUserBalance(forUser(user.id), {
      chain: 'solana',
      asset: 'BONK',
      amount: 1000,
      decimals: 5,
      usd: null
    });

    const polygon = await listFanoutCandidates(sweep(), {
      masterWalletAddress: master,
      chain: 'polygon'
    });
    const solana = await listFanoutCandidates(sweep(), {
      masterWalletAddress: master,
      chain: 'solana'
    });

    expect(polygon[0]!.knownBalanceUsd).toBe(250);
    expect(solana[0]!.knownBalanceUsd).toBeNull();
  });

  it('refuses a per-user scope against a real connection too', async () => {
    const user = await makeUser();
    await expect(
      listFanoutCandidates(forUser(user.id), {
        masterWalletAddress: walletFor('scope'),
        chain: 'solana'
      })
    ).rejects.toThrow(/crossTenantScope/);
    walletAddresses.pop();
  });
});
