import { query } from './client.js';
import { isCrossTenant } from './tenancy.js';
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
/**
 * How old a balance may be before a live trade must not be sized against it.
 *
 * 60s matches the poller interval. The gate is hard rather than a warning: the
 * previous trade's debit may not have been observed yet, so a stale read sizes
 * off pre-trade funds. Fan-out makes that acute — N jobs for one user can all
 * read the same pre-trade snapshot inside one interval.
 */
export const BALANCE_MAX_STALENESS_MS = 60_000;
const BALANCE_COLUMNS = 'user_id, chain, asset, amount, decimals, usd, usd_priced_at, fetched_at, source';
/**
 * `NUMERIC` arrives as a `number` from `configurePostgresNumericParsers` when it
 * fits in a float64 and as the original string when it does not — an 18-decimal
 * token balance does not fit.
 *
 * Re-parsing the string half with `Number()` would silently reintroduce exactly
 * the drift that parser exists to prevent, so an unrepresentable value reads as
 * `null` — *unknown* — and the caller must handle it. `amountRaw` carries the
 * exact digits for anyone who needs them.
 */
function toSafeNumber(value) {
    if (value === null)
        return null;
    if (typeof value === 'number')
        return Number.isFinite(value) ? value : null;
    return null;
}
function toBalance(row) {
    return {
        userId: row.user_id,
        chain: row.chain,
        asset: row.asset,
        amount: toSafeNumber(row.amount),
        amountRaw: String(row.amount),
        decimals: row.decimals,
        usd: toSafeNumber(row.usd),
        usdPricedAt: row.usd_priced_at,
        fetchedAt: row.fetched_at,
        source: row.source
    };
}
export async function listUserBalances(scope, chain) {
    const rows = chain
        ? await query(`SELECT ${BALANCE_COLUMNS} FROM user_balances
          WHERE user_id = $1 AND chain = $2
          ORDER BY chain, asset`, [scope.userId, chain])
        : await query(`SELECT ${BALANCE_COLUMNS} FROM user_balances
          WHERE user_id = $1
          ORDER BY chain, asset`, [scope.userId]);
    return rows.map(toBalance);
}
export async function getUserBalance(scope, chain, asset) {
    const rows = await query(`SELECT ${BALANCE_COLUMNS} FROM user_balances
      WHERE user_id = $1 AND chain = $2 AND asset = $3`, [scope.userId, chain, asset]);
    return rows[0] ? toBalance(rows[0]) : null;
}
/**
 * Writes one observation, replacing any previous one for the triple.
 *
 * `fetched_at = NOW()` is set by the database rather than the caller so that a
 * clock-skewed poller cannot write a future timestamp and make a stale balance
 * pass the staleness gate forever.
 */
export async function upsertUserBalance(scope, input) {
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
    const rows = await query(`INSERT INTO user_balances
       (user_id, chain, asset, amount, decimals, usd, usd_priced_at, source, fetched_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, 'poller'), NOW())
     ON CONFLICT (user_id, chain, asset) DO UPDATE
       SET amount        = EXCLUDED.amount,
           decimals      = EXCLUDED.decimals,
           usd           = EXCLUDED.usd,
           usd_priced_at = EXCLUDED.usd_priced_at,
           source        = EXCLUDED.source,
           fetched_at    = EXCLUDED.fetched_at
     RETURNING ${BALANCE_COLUMNS}`, [
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
    ]);
    return toBalance(rows[0]);
}
/** True when this observation is too old to size a live trade against. */
export function isBalanceStale(balance, now = new Date(), maxAgeMs = BALANCE_MAX_STALENESS_MS) {
    const age = now.getTime() - balance.fetchedAt.getTime();
    // A negative age means the row is timestamped in the future — clock skew, or a
    // caller that set fetched_at itself. Treat it as stale: an unexplained
    // timestamp is not evidence of freshness.
    return age < 0 || age > maxAgeMs;
}
/**
 * The USD total the sizing path may use, or `null` if it may not.
 *
 * `null` on *any* stale or unpriced row, not a partial sum over the rows that
 * happen to be fresh. A partial total is indistinguishable from a smaller
 * balance, so it would size a real trade against a number nobody computed —
 * failing toward moving funds, which is the wrong direction.
 */
export function resolveKnownBalanceUsd(balances, now = new Date(), maxAgeMs = BALANCE_MAX_STALENESS_MS) {
    if (balances.length === 0)
        return null;
    let total = 0;
    for (const balance of balances) {
        if (balance.usd === null)
            return null;
        if (isBalanceStale(balance, now, maxAgeMs))
            return null;
        total += balance.usd;
    }
    return total;
}
/**
 * Oldest-first balances due for a refresh. Drives the poller, so it crosses
 * tenants by design and requires a `crossTenantScope`.
 *
 * Served by `idx_user_balances_stale`.
 */
export async function listStaleUserBalances(scope, options = {}) {
    if (!isCrossTenant(scope)) {
        throw new Error('listStaleUserBalances is a platform sweep; pass crossTenantScope(reason)');
    }
    const olderThanMs = options.olderThanMs ?? BALANCE_MAX_STALENESS_MS;
    const rows = await query(`SELECT ${BALANCE_COLUMNS} FROM user_balances
      WHERE fetched_at < NOW() - make_interval(secs => $1::double precision)
      ORDER BY fetched_at
      LIMIT $2`, [olderThanMs / 1000, options.limit ?? 500]);
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
export async function pruneUserBalances(scope, chain, keptAssets) {
    const rows = await query(`DELETE FROM user_balances
      WHERE user_id = $1 AND chain = $2 AND NOT (asset = ANY($3::text[]))
      RETURNING asset`, [scope.userId, chain, [...keptAssets]]);
    return rows.length;
}
//# sourceMappingURL=user-balances.js.map