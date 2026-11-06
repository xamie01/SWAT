import type { Chain } from '@swat/shared';
import { type UserScope } from './tenancy.js';
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
export declare const BALANCE_MAX_STALENESS_MS = 60000;
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
export declare function listUserBalances(scope: UserScope, chain?: Chain): Promise<UserBalance[]>;
export declare function getUserBalance(scope: UserScope, chain: Chain, asset: string): Promise<UserBalance | null>;
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
export declare function upsertUserBalance(scope: UserScope, input: UpsertUserBalanceInput): Promise<UserBalance>;
/** True when this observation is too old to size a live trade against. */
export declare function isBalanceStale(balance: Pick<UserBalance, 'fetchedAt'>, now?: Date, maxAgeMs?: number): boolean;
/**
 * The USD total the sizing path may use, or `null` if it may not.
 *
 * `null` on *any* stale or unpriced row, not a partial sum over the rows that
 * happen to be fresh. A partial total is indistinguishable from a smaller
 * balance, so it would size a real trade against a number nobody computed —
 * failing toward moving funds, which is the wrong direction.
 */
export declare function resolveKnownBalanceUsd(balances: readonly UserBalance[], now?: Date, maxAgeMs?: number): number | null;
/**
 * Oldest-first balances due for a refresh. Drives the poller, so it crosses
 * tenants by design and requires a `crossTenantScope`.
 *
 * Served by `idx_user_balances_stale`.
 */
export declare function listStaleUserBalances(scope: UserScope, options?: {
    olderThanMs?: number;
    limit?: number;
}): Promise<UserBalance[]>;
/**
 * Drops rows for assets the user no longer holds on a chain.
 *
 * Needed because an upsert-only poller can never zero a position it stopped
 * seeing: a token sold to zero would keep its last non-zero amount forever, and
 * the sizing path would believe the user still holds it. `keptAssets` is the full
 * set observed in this poll for that chain.
 */
export declare function pruneUserBalances(scope: UserScope, chain: Chain, keptAssets: readonly string[]): Promise<number>;
//# sourceMappingURL=user-balances.d.ts.map