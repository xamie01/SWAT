import { type Chain, type UserTier } from '@swat/shared';
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
export declare class QuotaExceededError extends Error {
    readonly quota: string;
    readonly limit: number;
    readonly used: number;
    constructor(quota: string, limit: number, used: number);
}
export declare class WalletNotSubscribedError extends Error {
    constructor();
}
/**
 * Mirroring lifecycle of one subscription. Persisted as
 * `user_wallet_subscriptions.state` by migration `051`.
 *
 * - `active` — mirror the master's buys **and** sells.
 * - `winding_down` — mirror the master's **sells only**. Unsubscribe lands
 *   here: entries stop immediately, but a position opened while active keeps
 *   the exit path it was always going to use, which is the master's sell
 *   mirror. Auto-selling instead would be a market action the user never
 *   requested, and dropping the link would orphan the position.
 * - `ended` — mirror nothing. The last position opened under this
 *   subscription has closed, or unsubscribe found nothing open.
 */
export type SubscriptionState = 'active' | 'winding_down' | 'ended';
/**
 * Frozen rather than a `ReadonlySet`, following the `S4-M0` precedent in
 * `apps/signal-engine/src/trade-eligibility.ts`: `readonly` is a compile-time
 * claim only, and one stray `.add()` would widen the state machine
 * process-wide with no diff to review.
 */
export declare const SUBSCRIPTION_STATES: readonly SubscriptionState[];
export declare function isSubscriptionState(value: unknown): value is SubscriptionState;
/** What the fan-out is allowed to mirror for a subscription in a given state. */
export type MirrorEligibility = 'buys-and-sells' | 'sells-only' | 'none';
/**
 * The single definition of what each state permits — the term `S4-13` consumes
 * when enumerating eligible users for a signal.
 *
 * **Fails closed.** The argument is `unknown` rather than `SubscriptionState`
 * on purpose: the value arrives from a database column, so a row written by a
 * future migration, a manual UPDATE, or a service running a different release
 * can carry a state this build has never heard of. An unrecognised state
 * mirrors nothing, because the alternative — treating it as `active` — opens
 * positions on behalf of a user whose intent we cannot read.
 */
export declare function mirrorEligibilityForState(state: unknown): MirrorEligibility;
export type SubscriptionTransitionVerdict = {
    readonly kind: 'apply';
    readonly from: SubscriptionState;
    readonly to: SubscriptionState;
} | {
    readonly kind: 'noop';
    readonly state: SubscriptionState;
} | {
    readonly kind: 'illegal';
    readonly from: unknown;
    readonly to: unknown;
    readonly reason: string;
};
/**
 * Pure state machine. **This is the only place that decides transition
 * legality**; the database helpers below call it rather than embedding their
 * own rules, so the rules are unit-testable without infrastructure — the same
 * split `stop-loss.ts` uses between its decision math and its DB claim.
 *
 * The legal graph, and why:
 *
 * - `active → winding_down` — unsubscribe. The main path.
 * - `active → ended` — unsubscribe with nothing open. A subscription that
 *   never opened a position must not be forced through a fictitious wind-down
 *   it would then sit in forever, since nothing would ever close to end it.
 * - `winding_down → ended` — the last open position closed. The normal exit.
 * - `winding_down → active` — **legal, deliberately.** The user changed their
 *   mind while positions are still open. Refusing would be worse product for
 *   no correctness gain: the primary key `(user_id, wallet_address)` forbids a
 *   second row, so a refusal would mean the user cannot re-subscribe until
 *   every position happens to close. The positions in question came from this
 *   very subscription, so their cost basis is known and nothing is being
 *   entered blind. Forward-only (S4-M2) is preserved because entering `active`
 *   resets `active_since` — the wind-down window is never caught up on.
 * - `ended → active` — an ordinary re-subscribe, forward-only from now.
 * - `ended → winding_down` — refused, see `TRANSITION_REFUSALS`.
 *
 * Same-state requests are `noop`, not `illegal`: a double-clicked unsubscribe
 * or a redelivered job must be idempotent, not an error.
 */
export declare function evaluateSubscriptionTransition(from: unknown, to: unknown): SubscriptionTransitionVerdict;
export declare class IllegalSubscriptionTransitionError extends Error {
    readonly from: unknown;
    readonly to: unknown;
    readonly reason: string;
    constructor(from: unknown, to: unknown, reason: string);
}
export type SubscriptionSource = 'manual' | 'platform-signal' | 'discovered';
/**
 * One subscription as a user is allowed to see it.
 *
 * **There is deliberately no `membershipSlot` field** (`S4-M9`). The ordinal
 * migration `056` stores is a rank, and a rank is a headcount signal: "you are
 * member #37" tells a user roughly how many people are ahead of them in the
 * queue behind one worker, and tells a master when farming their own followers
 * pays. Adding it here would ship it straight to `GET /v1/me/wallets`.
 */
export interface WalletSubscription {
    readonly walletAddress: string;
    readonly label: string | null;
    readonly source: SubscriptionSource;
    readonly createdAt: Date;
    readonly state: SubscriptionState;
    /**
     * Start of the CURRENT active period, reset on every entry into `active`.
     * The forward-only mirror boundary (S4-M2) — not `createdAt`, which a
     * revived subscription keeps from its first lifecycle.
     */
    readonly activeSince: Date;
    readonly woundDownAt: Date | null;
    readonly endedAt: Date | null;
    readonly closeAllRequestedAt: Date | null;
}
/**
 * The user's live subscriptions — `active` and `winding_down`.
 *
 * `ended` rows are excluded rather than deleted. They are retained so a closed
 * position stays attributable to the subscription that opened it, but they are
 * not something the user is tracking any more, so listing them would put dead
 * wallets in the dashboard and in `GET /v1/me/wallets`.
 */
export declare function listWalletSubscriptions(scope: UserScope): Promise<WalletSubscription[]>;
/**
 * Whether the user still holds a live subscription to this wallet.
 *
 * `winding_down` counts: those users still have open positions being mirrored
 * out and marked to market, so the per-wallet endpoints this gates must keep
 * working for them. `ended` does not.
 */
export declare function isSubscribed(scope: UserScope, walletAddress: string): Promise<boolean>;
export interface SubscribeResult {
    readonly subscription: WalletSubscription;
    /** True when this call created the global wallet row, i.e. a backfill is needed. */
    readonly walletCreated: boolean;
    /** False when the user was already subscribed — the call was a no-op. */
    readonly subscriptionCreated: boolean;
}
/**
 * Subscribes a user to a wallet, creating the global wallet row if absent.
 *
 * `walletCreated` is returned rather than inferred by the caller, so the backfill
 * is enqueued exactly when the wallet is genuinely new. Enqueuing on every
 * subscribe would re-backfill a wallet each time another user tracks it.
 *
 * Also the **re-subscribe** path (S4-M3): a `winding_down` or `ended` row is
 * transitioned back to `active` here rather than in a separate helper, so the
 * tracked-wallet quota is resolved in exactly one place.
 *
 * **Two independent caps bind here and they are not interchangeable.** The
 * tracked-wallet quota is the *user's* limit — how many masters this account may
 * follow — and over it means 402, upgrade and you may. The membership cap
 * (`S4-M43`, migration `056`) is the *master's* limit — how many users it may
 * serve — and over it means a refusal no upgrade can lift. The quota is checked
 * first because it is the more specific answer to the caller, and because
 * telling a user "the master is not accepting copiers" when they could not have
 * subscribed anyway discloses the master's state for nothing (`S4-M9`).
 */
export declare function subscribeToWallet(scope: UserScope, input: {
    walletAddress: string;
    chain: Chain;
    tier: UserTier;
    tierExpiresAt: Date | null;
    label?: string | null;
    source?: SubscriptionSource;
}): Promise<SubscribeResult>;
/**
 * Removes one user's subscription **row**, permanently.
 *
 * **Never touches the global wallet row.** Another tenant may be subscribed to
 * it, and the platform may be scoring it — deleting it here would be a
 * cross-tenant data loss triggered by an ordinary unsubscribe.
 *
 * **This is the pre-fan-out unsubscribe and it is not the ADR-0005 one.** Once
 * a subscription can have opened a copy position, deleting the row is exactly
 * the abandonment §3.7 rejects: the position's exit was going to arrive as the
 * master's sell mirror, and the row is what says so. The ADR-0005 operations
 * are `beginWindDown` (stop entries, keep honouring sells) and
 * `endSubscription` (nothing left open).
 *
 * It is deliberately left in place rather than redirected to `beginWindDown`,
 * because choosing between `winding_down` and `ended` requires knowing whether
 * the subscription has an open position, and **nothing in the schema can answer
 * that yet**: `copy_positions` is keyed `(target_account, chain, token_mint)`
 * plus `user_id` (028, 050) and carries no master-wallet column, so a position
 * cannot be attributed to the subscription that opened it. Defaulting to
 * `winding_down` would strand every unsubscribe in a state nothing can clear,
 * which is worse than the current behaviour. Redirect this at the moment
 * fan-out lands that attribution (S4-13/S4-15), not before.
 */
export declare function unsubscribeFromWallet(scope: UserScope, walletAddress: string): Promise<boolean>;
export interface SubscriptionStateChange {
    readonly subscription: WalletSubscription;
    /** False when the subscription was already in the requested state. */
    readonly changed: boolean;
}
/** The full lifecycle row, including `ended` — unlike `listWalletSubscriptions`. */
export declare function getSubscriptionState(scope: UserScope, walletAddress: string): Promise<WalletSubscription | null>;
/**
 * Unsubscribe, ADR-0005 §3.7 semantics: **stop entries immediately, keep
 * honouring the master's sells** until each open position closes.
 *
 * Idempotent — a double-clicked unsubscribe returns `changed: false` rather
 * than throwing, and does not move `wound_down_at`.
 */
export declare function beginWindDown(scope: UserScope, walletAddress: string): Promise<SubscriptionStateChange>;
/**
 * Mirroring is over: the last position opened under this subscription has
 * closed, or the unsubscribe found nothing open at all.
 *
 * Reachable from `winding_down` (the normal path) and directly from `active`
 * (nothing was ever opened). The row is retained, not deleted, so a closed
 * position stays attributable to the subscription that opened it.
 */
export declare function endSubscription(scope: UserScope, walletAddress: string): Promise<SubscriptionStateChange>;
/**
 * The explicit **"close all now"** (S4-M3): exit every open position rather
 * than waiting for the master to sell.
 *
 * Winds the subscription down first when it is still `active`, because a user
 * asking to exit everything has certainly asked to stop entering. Both halves
 * land in one statement so there is no window in which entries are still
 * eligible while exits are being requested.
 *
 * Records the request; it does not place orders. It must be durable rather than
 * an in-flight command so the request survives an executor restart, and
 * `COALESCE` makes a second click a no-op instead of a second round of sells.
 *
 * Refused on an `ended` subscription: there is nothing open to close, and
 * accepting it would imply otherwise.
 */
export declare function requestCloseAll(scope: UserScope, walletAddress: string): Promise<SubscriptionStateChange>;
export type TokenWatchStatus = 'pending' | 'running' | 'complete' | 'failed';
export interface TokenWatch {
    readonly id: string;
    readonly chain: Chain;
    readonly tokenMint: string;
    readonly status: TokenWatchStatus;
    readonly createdAt: Date;
}
export declare function listTokenWatches(scope: UserScope): Promise<TokenWatch[]>;
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
export declare function requestTokenWatch(scope: UserScope, input: {
    chain: Chain;
    tokenMint: string;
    tier: UserTier;
    tierExpiresAt: Date | null;
}): Promise<RequestTokenWatchResult>;
//# sourceMappingURL=subscriptions.d.ts.map