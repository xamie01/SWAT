import type { Chain } from '@swat/shared';
import { BALANCE_MAX_STALENESS_MS, toBalance, type BalanceRow, type BalanceSource, type UserBalance } from './user-balance-state.js';
export { BALANCE_MAX_STALENESS_MS, isBalanceStale, resolveKnownBalanceUsd } from './user-balance-state.js';
export type { BalanceSource, UserBalance } from './user-balance-state.js';
import { query } from './client.js';
import { isCrossTenant, type UserScope } from './tenancy.js';

/**
 * Per-user cached balances (`S4-8`, migration `048`).
 *
 * The table is a cache of an on-chain fact, and this module's job is to keep
 * callers from reading it as authority. Two shapes carry that:
 *
 *   * `usd` is `number | null`, never coerced to 0. A funded user whose price
 *     fetch failed must read as *unknown*, because sizing against 0 produces a
 *     zero-size trade that looks like a working system declining to trade.
 *   * `isBalanceStale` is a separate, pure predicate rather than a filter buried
 *     in a `WHERE` clause, so the sizing path has to decide what to do about a
 *     stale row instead of receiving a shorter list and not noticing.
 *
 * The on-chain fetch itself is not here — `apps/trade-executor/src/balances.ts`
 * owns that. This module is only the persistence half the poller writes through.
 */

const BALANCE_COLUMNS =
  'user_id, chain, asset, amount, decimals, usd, usd_priced_at, fetched_at, source';

export async function listUserBalances(
  scope: UserScope,
  chain?: Chain
): Promise<UserBalance[]> {
  const rows = chain
    ? await query<BalanceRow>(
        `SELECT ${BALANCE_COLUMNS} FROM user_balances
          WHERE user_id = $1 AND chain = $2
          ORDER BY chain, asset`,
        [scope.userId, chain]
      )
    : await query<BalanceRow>(
        `SELECT ${BALANCE_COLUMNS} FROM user_balances
          WHERE user_id = $1
          ORDER BY chain, asset`,
        [scope.userId]
      );
  return rows.map(toBalance);
}

export async function getUserBalance(
  scope: UserScope,
  chain: Chain,
  asset: string
): Promise<UserBalance | null> {
  const rows = await query<BalanceRow>(
    `SELECT ${BALANCE_COLUMNS} FROM user_balances
      WHERE user_id = $1 AND chain = $2 AND asset = $3`,
    [scope.userId, chain, asset]
  );
  return rows[0] ? toBalance(rows[0]) : null;
}

export interface UpsertUserBalanceInput {
  readonly chain: Chain;
  readonly asset: string;
  readonly amount: number;
  readonly decimals: number;
  /** Pass `null` when the price fetch failed. Do not pass 0. */
  readonly usd?: number | null;
  readonly usdPricedAt?: Date | null;
  readonly source?: BalanceSource;
}

/**
 * Writes one observation, replacing any previous one for the triple.
 *
 * `fetched_at = NOW()` is set by the database rather than the caller so that a
 * clock-skewed poller cannot write a future timestamp and make a stale balance
 * pass the staleness gate forever.
 */
export async function upsertUserBalance(
  scope: UserScope,
  input: UpsertUserBalanceInput
): Promise<UserBalance> {
  if (!Number.isFinite(input.amount) || input.amount < 0) {
    throw new Error(`user_balances.amount must be a non-negative finite number, got ${input.amount}`);
  }
  if (!Number.isInteger(input.decimals) || input.decimals < 0 || input.decimals > 36) {
    throw new Error(`user_balances.decimals must be an integer in 0..36, got ${input.decimals}`);
  }
  const usd = input.usd ?? null;
  if (usd !== null && (!Number.isFinite(usd) || usd < 0)) {
    throw new Error(`user_balances.usd must be null or a non-negative finite number, got ${usd}`);
  }

  const rows = await query<BalanceRow>(
    `INSERT INTO user_balances
       (user_id, chain, asset, amount, decimals, usd, usd_priced_at, source, fetched_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, 'poller'), NOW())
     ON CONFLICT (user_id, chain, asset) DO UPDATE
       SET amount        = EXCLUDED.amount,
           decimals      = EXCLUDED.decimals,
           usd           = EXCLUDED.usd,
           usd_priced_at = EXCLUDED.usd_priced_at,
           source        = EXCLUDED.source,
           fetched_at    = EXCLUDED.fetched_at
     RETURNING ${BALANCE_COLUMNS}`,
    [
      scope.userId,
      input.chain,
      input.asset,
      input.amount,
      input.decimals,
      usd,
      // A priced row must carry its timestamp (chk_ub_usd_priced_at). Defaulting
      // to now() when the caller supplies a price but no timestamp is right: the
      // price was fetched for this write.
      usd === null ? (input.usdPricedAt ?? null) : (input.usdPricedAt ?? new Date()),
      input.source ?? null
    ]
  );
  return toBalance(rows[0]!);
}

/**
 * Oldest-first balances due for a refresh. Drives the poller, so it crosses
 * tenants by design and requires a `crossTenantScope`.
 *
 * Served by `idx_user_balances_stale`.
 */
export async function listStaleUserBalances(
  scope: UserScope,
  options: { olderThanMs?: number; limit?: number } = {}
): Promise<UserBalance[]> {
  if (!isCrossTenant(scope)) {
    throw new Error('listStaleUserBalances is a platform sweep; pass crossTenantScope(reason)');
  }
  const olderThanMs = options.olderThanMs ?? BALANCE_MAX_STALENESS_MS;
  const rows = await query<BalanceRow>(
    `SELECT ${BALANCE_COLUMNS} FROM user_balances
      WHERE fetched_at < NOW() - make_interval(secs => $1::double precision)
      ORDER BY fetched_at
      LIMIT $2`,
    [olderThanMs / 1000, options.limit ?? 500]
  );
  return rows.map(toBalance);
}

/**
 * Drops rows for assets the user no longer holds on a chain.
 *
 * Needed because an upsert-only poller can never zero a position it stopped
 * seeing: a token sold to zero would keep its last non-zero amount forever, and
 * the sizing path would believe the user still holds it. `keptAssets` is the full
 * set observed in this poll for that chain.
 */
export async function pruneUserBalances(
  scope: UserScope,
  chain: Chain,
  keptAssets: readonly string[]
): Promise<number> {
  const rows = await query<{ asset: string }>(
    `DELETE FROM user_balances
      WHERE user_id = $1 AND chain = $2 AND NOT (asset = ANY($3::text[]))
      RETURNING asset`,
    [scope.userId, chain, [...keptAssets]]
  );
  return rows.length;
}
