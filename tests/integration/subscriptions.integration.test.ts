import { randomUUID } from 'node:crypto';
import { describe, it, expect, afterAll } from 'vitest';
import { pool } from '../../packages/db/src/client.js';
import { forUser } from '../../packages/db/src/tenancy.js';
import { createUser } from '../../packages/db/src/users.js';
import {
  listWalletSubscriptions,
  QuotaExceededError,
  requestTokenWatch,
  subscribeToWallet,
  unsubscribeFromWallet
} from '../../packages/db/src/subscriptions.js';
import {
  pauseUnderperformingWallets,
  pauseUnsubscribedWallets
} from '../../packages/db/src/scoring-queries.js';

/**
 * Stage 2 subscription model (checklist S2-1 … S2-6).
 *
 * The assertions that matter here are the *negative* ones — that a subscribed
 * wallet survives the nightly pause sweep, and that unsubscribing one user does
 * not delete a wallet another user still tracks. Both are silent data-loss bugs
 * if they regress, invisible until a user reports missing data days later.
 */

const runId = randomUUID().replace(/-/g, '').slice(0, 12);
const userIds: string[] = [];
const walletAddresses: string[] = [];

function walletFor(suffix: string): string {
  const address = `solana:SWATtest${runId}${suffix}`.slice(0, 100);
  walletAddresses.push(address);
  return address;
}

async function makeUser(tier: 'free' | 'operator' | 'ultra' = 'free') {
  const user = await createUser({
    email: `s2-${randomUUID()}@example.com`,
    password: 'a-very-long-password',
    tier
  });
  userIds.push(user.id);
  return user;
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

describe('stage 2 subscriptions', () => {
  it('indexes a wallet once and links many subscribers (global dedup)', async () => {
    const alice = await makeUser();
    const bob = await makeUser();
    const address = walletFor('dedup');

    const first = await subscribeToWallet(forUser(alice.id), {
      walletAddress: address,
      chain: 'solana',
      tier: alice.tier,
      tierExpiresAt: alice.tierExpiresAt
    });
    const second = await subscribeToWallet(forUser(bob.id), {
      walletAddress: address,
      chain: 'solana',
      tier: bob.tier,
      tierExpiresAt: bob.tierExpiresAt
    });

    // Only the first subscriber creates the global wallet, so only that call
    // should trigger a backfill. Enqueuing on every subscribe is the cost the
    // dedup model exists to avoid.
    expect(first.walletCreated).toBe(true);
    expect(second.walletCreated).toBe(false);
    expect(second.subscriptionCreated).toBe(true);

    const wallets = await pool.query('SELECT address FROM wallets WHERE address = $1', [address]);
    expect(wallets.rowCount).toBe(1);
  });

  it('is idempotent and consumes no quota when re-subscribing', async () => {
    const user = await makeUser();
    const address = walletFor('idem');
    const scope = forUser(user.id);

    const first = await subscribeToWallet(scope, {
      walletAddress: address,
      chain: 'solana',
      tier: user.tier,
      tierExpiresAt: user.tierExpiresAt
    });
    const again = await subscribeToWallet(scope, {
      walletAddress: address,
      chain: 'solana',
      tier: user.tier,
      tierExpiresAt: user.tierExpiresAt
    });

    expect(first.subscriptionCreated).toBe(true);
    expect(again.subscriptionCreated).toBe(false);
    expect(await listWalletSubscriptions(scope)).toHaveLength(1);
  });

  it('enforces the free-tier wallet quota at the limit', async () => {
    const user = await makeUser('free');
    const scope = forUser(user.id);

    for (let i = 0; i < 3; i++) {
      await subscribeToWallet(scope, {
        walletAddress: walletFor(`q${i}`),
        chain: 'solana',
        tier: user.tier,
        tierExpiresAt: user.tierExpiresAt
      });
    }

    await expect(
      subscribeToWallet(scope, {
        walletAddress: walletFor('q3'),
        chain: 'solana',
        tier: user.tier,
        tierExpiresAt: user.tierExpiresAt
      })
    ).rejects.toBeInstanceOf(QuotaExceededError);

    expect(await listWalletSubscriptions(scope)).toHaveLength(3);
  });

  it('does not let concurrent subscribes exceed the quota', async () => {
    // The TOCTOU this guards: check-then-insert lets two requests both observe
    // `2 < 3` and both insert, landing a free user on 4 wallets.
    const user = await makeUser('free');
    const scope = forUser(user.id);
    const addresses = [0, 1, 2, 3, 4].map((i) => walletFor(`c${i}`));

    const results = await Promise.allSettled(
      addresses.map((walletAddress) =>
        subscribeToWallet(scope, {
          walletAddress,
          chain: 'solana',
          tier: user.tier,
          tierExpiresAt: user.tierExpiresAt
        })
      )
    );

    const granted = results.filter((r) => r.status === 'fulfilled').length;
    expect(granted).toBeLessThanOrEqual(3);
    expect(await listWalletSubscriptions(scope)).toHaveLength(granted);
  });

  it('unsubscribing one user leaves the other subscriber and the wallet intact', async () => {
    const alice = await makeUser();
    const bob = await makeUser();
    const address = walletFor('unsub');

    for (const user of [alice, bob]) {
      await subscribeToWallet(forUser(user.id), {
        walletAddress: address,
        chain: 'solana',
        tier: user.tier,
        tierExpiresAt: user.tierExpiresAt
      });
    }

    expect(await unsubscribeFromWallet(forUser(alice.id), address)).toBe(true);

    expect(await listWalletSubscriptions(forUser(alice.id))).toHaveLength(0);
    expect(await listWalletSubscriptions(forUser(bob.id))).toHaveLength(1);
    // The global wallet must survive — deleting it here would be cross-tenant
    // data loss triggered by an ordinary unsubscribe.
    const wallets = await pool.query('SELECT address FROM wallets WHERE address = $1', [address]);
    expect(wallets.rowCount).toBe(1);
  });

  it('never pauses a subscribed wallet, however badly it scores', async () => {
    const user = await makeUser();
    const address = walletFor('pinned');
    await subscribeToWallet(forUser(user.id), {
      walletAddress: address,
      chain: 'solana',
      tier: user.tier,
      tierExpiresAt: user.tierExpiresAt
    });
    // Squarely inside the underperformance rule.
    await pool.query(
      `UPDATE wallets SET total_trades = 100, composite_score = 5,
              last_active = NOW() - INTERVAL '90 days'
        WHERE address = $1`,
      [address]
    );

    await pauseUnderperformingWallets();
    await pauseUnsubscribedWallets();

    const rows = await pool.query<{ status: string }>(
      'SELECT status FROM wallets WHERE address = $1',
      [address]
    );
    // A user chose this wallet. Pausing it would silently stop their data.
    expect(rows.rows[0]?.status).toBe('active');
  });

  it('pauses an unsubscribed wallet with no platform interest', async () => {
    const address = walletFor('orphan');
    await pool.query(
      `INSERT INTO wallets (address, chain, source, status, total_trades, composite_score, last_active)
       VALUES ($1, 'solana', 'discovered', 'active', 100, 5, NOW() - INTERVAL '90 days')
       ON CONFLICT (address) DO NOTHING`,
      [address]
    );

    await pauseUnsubscribedWallets();

    const rows = await pool.query<{ status: string }>(
      'SELECT status FROM wallets WHERE address = $1',
      [address]
    );
    expect(rows.rows[0]?.status).toBe('paused');
  });

  it('enforces the rolling-24h token backfill quota, and re-requests are free', async () => {
    const user = await makeUser('free');
    const scope = forUser(user.id);
    const mint = `solana:MINT${runId}a`;

    const first = await requestTokenWatch(scope, {
      chain: 'solana',
      tokenMint: mint,
      tier: user.tier,
      tierExpiresAt: user.tierExpiresAt
    });
    expect(first.created).toBe(true);

    // Same token again: idempotent, and must not spend the day's single slot.
    const repeat = await requestTokenWatch(scope, {
      chain: 'solana',
      tokenMint: mint,
      tier: user.tier,
      tierExpiresAt: user.tierExpiresAt
    });
    expect(repeat.created).toBe(false);

    await expect(
      requestTokenWatch(scope, {
        chain: 'solana',
        tokenMint: `solana:MINT${runId}b`,
        tier: user.tier,
        tierExpiresAt: user.tierExpiresAt
      })
    ).rejects.toBeInstanceOf(QuotaExceededError);
  });
});
