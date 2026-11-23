import type { Chain } from '@swat/shared';

/** Shared pool-free cached-balance mapping and freshness rules. Not balance authority. */
/**
 * How old a balance may be before a live trade must not be sized against it.
 *
 * 60s matches the poller interval. The gate is hard rather than a warning: the
 * previous trade's debit may not have been observed yet, so a stale read sizes
 * off pre-trade funds. Fan-out makes that acute — N jobs for one user can all
 * read the same pre-trade snapshot inside one interval.
 */
export const BALANCE_MAX_STALENESS_MS = 60_000;

export type BalanceSource = 'poller' | 'post-trade' | 'manual-refresh';

export interface UserBalance {
  readonly userId: string;
  readonly chain: Chain;
  /** Chain-prefixed mint/contract for a token, or the chain's native symbol. */
  readonly asset: string;
  /**
   * Human-scale amount, or `null` when the stored `NUMERIC` cannot be held in a
   * float64 without drift. Never silently rounded — see `toSafeNumber`.
   */
  readonly amount: number | null;
  /**
   * The exact stored value as text. Always present, and the only safe input to
   * base-unit arithmetic: a SELL needs an exact integer quantity (`S3-7`), which
   * `amount` cannot always provide.
   */
  readonly amountRaw: string;
  readonly decimals: number;
  /** `null` means "we hold this but do not know what it is worth". Not 0. */
  readonly usd: number | null;
  readonly usdPricedAt: Date | null;
  readonly fetchedAt: Date;
  readonly source: BalanceSource;
}

export interface BalanceRow {
  user_id: string;
  chain: Chain;
  asset: string;
  amount: number | string;
  decimals: number;
  usd: number | string | null;
  usd_priced_at: Date | null;
  fetched_at: Date;
  source: BalanceSource;
}

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
function toSafeNumber(value: number | string | null): number | null {
  if (value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  return null;
}

export function toBalance(row: BalanceRow): UserBalance {
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

/** True when this observation is too old to size a live trade against. */
export function isBalanceStale(
  balance: Pick<UserBalance, 'fetchedAt'>,
  now: Date = new Date(),
  maxAgeMs: number = BALANCE_MAX_STALENESS_MS
): boolean {
  const age = now.getTime() - balance.fetchedAt.getTime();
  // A negative age means the row is timestamped in the future — clock skew, or a
  // caller that set fetched_at itself. Treat it as stale: an unexplained
  // timestamp is not evidence of freshness.
  return !Number.isFinite(age) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0 || age < 0 || age > maxAgeMs;
}

/**
 * The USD total the sizing path may use, or `null` if it may not.
 *
 * `null` on *any* stale or unpriced row, not a partial sum over the rows that
 * happen to be fresh. A partial total is indistinguishable from a smaller
 * balance, so it would size a real trade against a number nobody computed —
 * failing toward moving funds, which is the wrong direction.
 */
export function resolveKnownBalanceUsd(
  balances: readonly UserBalance[],
  now: Date = new Date(),
  maxAgeMs: number = BALANCE_MAX_STALENESS_MS
): number | null {
  if (balances.length === 0) return null;
  let total = 0;
  for (const balance of balances) {
    if (balance.usd === null || !Number.isFinite(balance.usd) || balance.usd < 0) return null;
    if (isBalanceStale(balance, now, maxAgeMs)) return null;
    if (!(balance.usdPricedAt instanceof Date)
        || isBalanceStale({ fetchedAt: balance.usdPricedAt }, now, maxAgeMs)) return null;
    total += balance.usd;
    if (!Number.isFinite(total)) return null;
  }
  return total;
}

