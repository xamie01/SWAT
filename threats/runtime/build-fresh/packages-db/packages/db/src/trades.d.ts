import type { Chain } from '@swat/shared';
export type TradeInsert = {
    signalId?: string | null;
    sourceTradeId?: string | null;
    copyExecutionId?: string | null;
    /**
     * Owning tenant. Omit or pass `null` for the pre-multi-tenant operator
     * account — `null` is a real, meaningful value here, not a missing one
     * (S4-10, migration 050_copy_tenancy.sql). Do not substitute a placeholder
     * uuid: `normalizeTenantId` rejects anything that is not a uuid or null.
     */
    userId?: string | null;
    walletAddress?: string | null;
    tokenMint: string;
    chain?: Chain | null;
    direction: 'buy' | 'sell';
    /** Size of the position in SOL. */
    amountSol?: number | null;
    /** USD value of the position at execution time (the cost basis for a buy). */
    amountUsd?: number | null;
    /** Requested USD notional, retained separately when a venue fill is pending or partial. */
    targetAmountUsd?: number | null;
    /** Token amount acquired/sold, in human units (used for mark-to-market). */
    tokenAmount?: number | null;
    /** Token price in USD at execution time. */
    priceUsd?: number | null;
    /** Receipt- or venue-derived execution fees in USD. */
    feeUsd?: number | null;
    slippageBps?: number | null;
    signature?: string | null;
    /** 'paper' | 'live' */
    executionMode?: string | null;
    /** 'paper' | 'trojan' | 'jupiter-sim' | ... */
    executor?: string | null;
    status?: string;
    errorMessage?: string | null;
    /** Venue-assigned order identity; never substitute this for an on-chain signature. */
    venueOrderId?: string | null;
    venueStatus?: string | null;
    venueTradeIds?: string[];
    settlementTransactionHashes?: string[];
    /** Link a simulated trade to the real live trade it is shadowing */
    shadowOf?: string | null;
    /** Price impact the swap would cause (e.g. 0.45 = 0.45 %). */
    priceImpactPct?: number | null;
    /** Full Jupiter route plan (DEX hops, amounts, fees). */
    routeInfo?: unknown | null;
    /** Solana slot at which the Jupiter quote was computed. */
    quoteSlot?: number | null;
    /** Minimum output after slippage, in human token units. */
    minTokenAmount?: number | null;
    submittedAt?: Date | null;
    confirmedAt?: Date | null;
};
export declare function insertTrade(input: TradeInsert): Promise<{
    id: string;
}>;
/**
 * Persist a filled trade and mark its signal executed in one transaction.
 * Locking the signal also makes retry recovery idempotent: if a previous
 * attempt committed the trade, a retry only repairs the signal status.
 */
export declare function insertTradeAndMarkSignalExecuted(input: TradeInsert & {
    signalId: string;
}): Promise<{
    id: string;
}>;
/** Persist a terminal non-fill attempt and release its execution claim atomically. */
export declare function insertTradeAndReleaseSignalClaim(input: TradeInsert & {
    signalId: string;
    status: string;
}): Promise<{
    id: string;
}>;
/**
 * Advance a signal's lifecycle status (e.g. to 'executed' once a trade fills).
 */
export declare function markSignalExecuted(signalId: string): Promise<void>;
/**
 * Atomically claim a signal for execution. Sets status to 'executing' only if
 * it is pending, and returns true if THIS caller won the
 * claim. This is the idempotency guard that prevents a duplicate/re-delivered
 * signal from triggering a second (live) trade — it must be called BEFORE the
 * trade is placed. Returns false if the signal was already claimed/executed.
 */
export declare function claimSignalForExecution(signalId: string): Promise<boolean>;
/** Revert a claim back to pending when execution fails, so it can be retried. */
export declare function releaseSignalClaim(signalId: string): Promise<void>;
/**
 * Whether a filled buy for this token was placed within the last N minutes.
 * Used by the executor to suppress re-buying a token the system just bought
 * (a held position keeps re-triggering snipe signals after the dedupe window).
 *
 * Deliberately NOT tenant-scoped, and this is a known gap rather than an
 * oversight: with more than one tenant, user A's buy currently suppresses
 * user B's legitimate entry into the same token. Scoping it by `user_id` is a
 * change to a live risk/dedupe control, not a tenancy plumbing change, so
 * S4-10 leaves the semantics exactly as they are. Whoever owns the per-user
 * risk limits decides whether the window is per tenant, global, or both.
 */
export declare function hasRecentBuy(tokenMint: string, withinMinutes: number): Promise<boolean>;
/**
 * The tenant whose rolling exposure is being summed.
 *
 * `null` is a real, load-bearing value, not a missing one: migration 050 leaves every
 * legacy row at `user_id NULL` and backfills nothing, so `null` IS the pre-tenancy
 * operator account. That is why the predicate below is `IS NOT DISTINCT FROM` and not
 * `=` -- `user_id = NULL` is never true, so an `=` comparison would report the
 * operator's rolling exposure as 0 and uncap the operator path entirely.
 *
 * A non-null value must be a `users.id` UUID. `normalizeTenantId` rejects anything
 * else, which is what stops a stray account label (`'operator'`, an email, a
 * chain-prefixed address) from silently matching zero rows and reading as "this user
 * has spent nothing today".
 */
export type ExposureAccount = string | null;
/**
 * USD bought on one chain by ONE tenant in the last 24 hours.
 *
 * ## Why this gained a parameter (`S4-M47`)
 *
 * It used to be `getRollingExposureUsd(chain)` with `WHERE chain = $1` alone, and the
 * comment above it argued the global sum was deliberately conservative. That argument
 * held while there was exactly one tenant. Under fan-out it inverts: **one user's
 * spending charges every other user's daily allowance**, so the first user to trade
 * hard silently caps the entire cohort, and the users who lose their allowance did
 * nothing and get no explanation. "Conservative" stops being a safety property when it
 * is another tenant's money being refused.
 *
 * This is the third of the checklist's §1 exceptions: there was no `account` argument
 * to substitute a user key into, so it is a signature change rather than a value
 * substitution.
 *
 * ## `account` here is the TENANCY COLUMN, not the risk-policy account label
 *
 * The executor has two `'operator'`-valued constants that must not be collapsed:
 * `RISK_POLICY_ACCOUNT` (a tenancy key that becomes the user id) and
 * `RECONCILIATION_ACCOUNT` (an escalation label that stays `'operator'`). This
 * parameter is a THIRD thing and belongs to neither: it is compared against
 * `trades.user_id`, a `users(id)` foreign key. So the call site passes the raw
 * `userId` -- **not** `riskPolicyAccountForUser(userId)`, which returns the literal
 * `'operator'` for the operator path and would be rejected here by
 * `normalizeTenantId` rather than quietly matching nothing.
 *
 * ## Scoped, not global-plus-scoped
 *
 * A per-tenant sum plus a separate platform-wide sum is a defensible design, but it is
 * a **risk-policy decision** (two limits, two thresholds, two alerts) and not this
 * change. `userDailyExposureCapUsd` in the executor pairs a per-user cap with this
 * per-user figure; a platform-wide ceiling on top of it is a distinct cap that should
 * be named and configured as one rather than smuggled in as a side effect of this sum.
 */
export declare function getRollingExposureUsd(account: ExposureAccount, chain: string): Promise<number>;
//# sourceMappingURL=trades.d.ts.map