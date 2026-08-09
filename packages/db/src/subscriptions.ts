import { capabilitiesFor, quotaExceeded, type Chain, type UserTier } from '@swat/shared';
import { query } from './client.js';
import { withTransaction } from './transaction.js';
import type { UserScope } from './tenancy.js';

/**
 * Per-user wallet subscriptions and token watches (Stage 2).
 *
 * Every read here is scoped by `UserScope`. Every write that consumes a quota
 * checks and inserts **inside one transaction** — see `QuotaExceededError`.
 */

/**
 * Over quota. Mapped to HTTP **402**, not 403.
 *
 * 403 means "you may never do this"; 402 means "upgrade and you may". The
 * frontend needs that distinction to show an upgrade prompt rather than an
 * error, and conflating them makes every paywall look like a bug.
 */
export class QuotaExceededError extends Error {
  constructor(
    readonly quota: string,
    readonly limit: number,
    readonly used: number
  ) {
    super(`Quota exceeded: ${quota} (${used}/${limit})`);
    this.name = 'QuotaExceededError';
  }
}

export class WalletNotSubscribedError extends Error {
  constructor() {
    super('Wallet not subscribed');
    this.name = 'WalletNotSubscribedError';
  }
}

export type SubscriptionSource = 'manual' | 'platform-signal' | 'discovered';

export interface WalletSubscription {
  readonly walletAddress: string;
  readonly label: string | null;
  readonly source: SubscriptionSource;
  readonly createdAt: Date;
}

interface SubscriptionRow {
  wallet_address: string;
  label: string | null;
  source: SubscriptionSource;
  created_at: Date;
}

function toSubscription(row: SubscriptionRow): WalletSubscription {
  return {
    walletAddress: row.wallet_address,
    label: row.label,
    source: row.source,
    createdAt: row.created_at
  };
}

export async function listWalletSubscriptions(scope: UserScope): Promise<WalletSubscription[]> {
  const rows = await query<SubscriptionRow>(
    `SELECT wallet_address, label, source, created_at
       FROM user_wallet_subscriptions
      WHERE user_id = $1
      ORDER BY created_at DESC`,
    [scope.userId]
  );
  return rows.map(toSubscription);
}

export async function isSubscribed(scope: UserScope, walletAddress: string): Promise<boolean> {
  const rows = await query<{ one: number }>(
    `SELECT 1 AS one FROM user_wallet_subscriptions
      WHERE user_id = $1 AND wallet_address = $2`,
    [scope.userId, walletAddress]
  );
  return rows.length > 0;
}

export interface SubscribeResult {
  readonly subscription: WalletSubscription;
  /** True when this call created the global wallet row, i.e. a backfill is needed. */
  readonly walletCreated: boolean;
  /** False when the user was already subscribed — the call was a no-op. */
  readonly subscriptionCreated: boolean;
}

/**
 * Serialises quota-consuming writes for one user.
 *
 * **A transaction alone does not enforce a quota.** `withTransaction` runs at
 * READ COMMITTED, so N concurrent `COUNT(*)` reads all observe the state before
 * any of them commits — every one sees `0 < 3` and every one inserts. A test
 * firing five concurrent subscribes against a 3-wallet tier granted all five.
 *
 * Locking the user's own row first serialises that user's quota writes without
 * touching anyone else's: different users take different locks and never contend.
 * `FOR UPDATE` on `users` is preferred over `SERIALIZABLE` because it needs no
 * retry loop, and over an advisory lock because the row already exists and the
 * lock is released by the transaction automatically.
 */
async function lockUserForQuota(
  client: { query: (text: string, values: unknown[]) => Promise<unknown> },
  userId: string
): Promise<void> {
  await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
}

/**
 * Subscribes a user to a wallet, creating the global wallet row if absent.
 *
 * `walletCreated` is returned rather than inferred by the caller, so the backfill
 * is enqueued exactly when the wallet is genuinely new. Enqueuing on every
 * subscribe would re-backfill a wallet each time another user tracks it.
 */
export async function subscribeToWallet(
  scope: UserScope,
  input: {
    walletAddress: string;
    chain: Chain;
    tier: UserTier;
    tierExpiresAt: Date | null;
    label?: string | null;
    source?: SubscriptionSource;
  }
): Promise<SubscribeResult> {
  const capabilities = capabilitiesFor(input.tier, input.tierExpiresAt);

  return withTransaction(async (client) => {
    await lockUserForQuota(client, scope.userId);

    // Already subscribed: idempotent success, and it must not consume quota.
    const existing = await client.query<SubscriptionRow>(
      `SELECT wallet_address, label, source, created_at
         FROM user_wallet_subscriptions
        WHERE user_id = $1 AND wallet_address = $2`,
      [scope.userId, input.walletAddress]
    );
    if (existing.rows[0]) {
      return {
        subscription: toSubscription(existing.rows[0]),
        walletCreated: false,
        subscriptionCreated: false
      };
    }

    const counted = await client.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM user_wallet_subscriptions WHERE user_id = $1',
      [scope.userId]
    );
    const used = Number(counted.rows[0]?.count ?? '0');
    if (quotaExceeded(capabilities.trackedWallets, used)) {
      throw new QuotaExceededError('trackedWallets', capabilities.trackedWallets ?? 0, used);
    }

    const inserted = await client.query<{ address: string }>(
      `INSERT INTO wallets (address, chain, source, status)
       VALUES ($1, $2, 'manual', 'active')
       ON CONFLICT (address) DO NOTHING
       RETURNING address`,
      [input.walletAddress, input.chain]
    );
    const walletCreated = inserted.rows.length > 0;

    const subscription = await client.query<SubscriptionRow>(
      `INSERT INTO user_wallet_subscriptions (user_id, wallet_address, label, source)
       VALUES ($1, $2, $3, COALESCE($4, 'manual'))
       RETURNING wallet_address, label, source, created_at`,
      [scope.userId, input.walletAddress, input.label ?? null, input.source ?? null]
    );

    return {
      subscription: toSubscription(subscription.rows[0]!),
      walletCreated,
      subscriptionCreated: true
    };
  });
}

/**
 * Removes one user's subscription.
 *
 * **Never touches the global wallet row.** Another tenant may be subscribed to
 * it, and the platform may be scoring it — deleting it here would be a
 * cross-tenant data loss triggered by an ordinary unsubscribe.
 */
export async function unsubscribeFromWallet(
  scope: UserScope,
  walletAddress: string
): Promise<boolean> {
  const rows = await query<{ wallet_address: string }>(
    `DELETE FROM user_wallet_subscriptions
      WHERE user_id = $1 AND wallet_address = $2
      RETURNING wallet_address`,
    [scope.userId, walletAddress]
  );
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Token watches
// ---------------------------------------------------------------------------

export type TokenWatchStatus = 'pending' | 'running' | 'complete' | 'failed';

export interface TokenWatch {
  readonly id: string;
  readonly chain: Chain;
  readonly tokenMint: string;
  readonly status: TokenWatchStatus;
  readonly createdAt: Date;
}

interface TokenWatchRow {
  id: string;
  chain: Chain;
  token_mint: string;
  status: TokenWatchStatus;
  created_at: Date;
}

function toWatch(row: TokenWatchRow): TokenWatch {
  return {
    id: row.id,
    chain: row.chain,
    tokenMint: row.token_mint,
    status: row.status,
    createdAt: row.created_at
  };
}

export async function listTokenWatches(scope: UserScope): Promise<TokenWatch[]> {
  const rows = await query<TokenWatchRow>(
    `SELECT id, chain, token_mint, status, created_at
       FROM user_token_watches
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 100`,
    [scope.userId]
  );
  return rows.map(toWatch);
}

export interface RequestTokenWatchResult {
  readonly watch: TokenWatch;
  /** False when this token was already being watched — no quota was consumed. */
  readonly created: boolean;
}

/**
 * Starts a token backfill, subject to the rolling-24h quota.
 *
 * Re-requesting a token already watched returns the existing row and consumes no
 * quota — otherwise a user could exhaust their day by double-clicking.
 */
export async function requestTokenWatch(
  scope: UserScope,
  input: {
    chain: Chain;
    tokenMint: string;
    tier: UserTier;
    tierExpiresAt: Date | null;
  }
): Promise<RequestTokenWatchResult> {
  const capabilities = capabilitiesFor(input.tier, input.tierExpiresAt);

  return withTransaction(async (client) => {
    // Same serialisation as the wallet quota — see `lockUserForQuota`.
    await lockUserForQuota(client, scope.userId);

    const existing = await client.query<TokenWatchRow>(
      `SELECT id, chain, token_mint, status, created_at
         FROM user_token_watches
        WHERE user_id = $1 AND chain = $2 AND token_mint = $3`,
      [scope.userId, input.chain, input.tokenMint]
    );
    if (existing.rows[0]) {
      return { watch: toWatch(existing.rows[0]), created: false };
    }

    // Rolling 24h, not calendar-day: a calendar reset lets a user spend two days'
    // quota in a few minutes across midnight.
    const counted = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM user_token_watches
        WHERE user_id = $1 AND created_at > NOW() - INTERVAL '24 hours'`,
      [scope.userId]
    );
    const used = Number(counted.rows[0]?.count ?? '0');
    if (quotaExceeded(capabilities.tokenBackfillsPerDay, used)) {
      throw new QuotaExceededError('tokenBackfillsPerDay', capabilities.tokenBackfillsPerDay ?? 0, used);
    }

    const inserted = await client.query<TokenWatchRow>(
      `INSERT INTO user_token_watches (user_id, chain, token_mint)
       VALUES ($1, $2, $3)
       RETURNING id, chain, token_mint, status, created_at`,
      [scope.userId, input.chain, input.tokenMint]
    );
    return { watch: toWatch(inserted.rows[0]!), created: true };
  });
}
