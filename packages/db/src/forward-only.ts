import type { PoolClient } from 'pg';
import { query } from './client.js';
import { mirrorEligibilityForState } from './subscriptions.js';
import type { UserScope } from './tenancy.js';

/**
 * Forward-only joins (checklist `S4-M2`, ADR-0005 §3.7).
 *
 * **The failure this prevents.** A user subscribes to a master who is already
 * holding twelve tokens. The master's history is sitting in `source_trades` and
 * the signal path is perfectly willing to mirror any of it. Following those
 * entries means buying into positions whose cost basis the user never had —
 * they enter at whatever the price is now, after the move that made the master
 * worth following already happened. That is the mechanism by which a copy
 * cohort becomes the master's exit liquidity, and it is not a rare case: it is
 * what "subscribe" would mean by default for every master worth subscribing to.
 *
 * So the rule is: **a subscription mirrors entries made from the subscription
 * onward, and nothing earlier.** The user's first day may be flat. That is the
 * correct outcome and `S6-31` is the notice that says so at subscribe time.
 *
 * ## Split
 *
 * The decision is **pure** (`evaluateForwardOnlyMirror`) and the read is thin
 * (`readForwardOnlySubscriptionWindow` / `loadForwardOnlySubscriptionWindow`),
 * the same shape `stop-loss.ts` uses between its threshold arithmetic and its
 * DB claim. No clock is read here: `eventAt` and `activeSince` both arrive as
 * arguments, so every boundary case is reachable from a unit test with no
 * infrastructure.
 *
 * ## Why `active_since` and never `created_at`
 *
 * The primary key of `user_wallet_subscriptions` is `(user_id, wallet_address)`
 * (`044`), so a second row for the same pair cannot exist. A re-subscribe is
 * therefore an `ended -> active` transition **on the row that is already
 * there** — see `subscribeToWallet` in `subscriptions.ts`, which UPDATEs the
 * existing row rather than inserting. Consequently a subscription created in
 * January, ended in March and revived in August still reads
 * `created_at = January`.
 *
 * A forward-only filter written against `created_at` would let that revived
 * subscriber catch up on eight months of the master's trades — precisely the
 * catch-up buying this item exists to forbid, in the one case nobody would
 * think to test. `051_subscription_states.sql` added `active_since` for exactly
 * this, resets it on **every** entry into `active` (`subscribeToWallet` sets
 * `active_since = NOW()` alongside `state = 'active'`), and says so in its
 * `COMMENT ON COLUMN`. This module reads `active_since` and does not read
 * `created_at` at all.
 *
 * ## Why this composes with `mirrorEligibilityForState` instead of restating it
 *
 * `subscriptions.ts` already owns what each lifecycle state permits: `active`
 * is buys and sells, `winding_down` is **sells only**, anything else is
 * nothing. That table is not copied here. The buy branch below *calls*
 * `mirrorEligibilityForState`, so a change to the state machine cannot leave a
 * stale duplicate of it in this file. Forward-only is a strictly narrower
 * question asked only of entries: *given that this subscription may enter at
 * all, is this particular event inside the current active window?*
 */

/**
 * The two columns of `user_wallet_subscriptions` this decision needs, plus the
 * key they were read by.
 *
 * `state` is `unknown` rather than `SubscriptionState` for the same reason
 * `mirrorEligibilityForState` takes `unknown`: the value arrives from a
 * database column that a future migration, a manual UPDATE, or a service on a
 * different release can populate with a state this build has never heard of.
 * A type that cannot be wrong makes the fail-closed branch unreachable and
 * therefore untestable.
 *
 * `walletAddress` is the **chain-prefixed** master address, matching
 * `user_wallet_subscriptions.wallet_address` and `source_trades.wallet_address`
 * (both store `${chain}:${raw}`). Nothing here un-prefixes or re-resolves it;
 * a bare address would simply not match a row, which is why the readers below
 * take the value already prefixed.
 */
export interface ForwardOnlySubscriptionWindow {
  readonly userId: string;
  readonly walletAddress: string;
  readonly state: unknown;
  /** Start of the CURRENT active period. Never `created_at`. */
  readonly activeSince: Date;
}

/**
 * Why an event was admitted, so a caller can tell the ordinary case from the
 * two that deserve a second look.
 */
export type ForwardOnlyMirrorBasis =
  /** The master's entry happened at or after the subscription went active. */
  | 'event-at-or-after-active-since'
  /**
   * The entry reads as *slightly* earlier than `active_since` and was admitted
   * under an operator-configured clock-skew tolerance. Never reached at the
   * default tolerance of zero.
   */
  | 'event-within-clock-skew-tolerance'
  /**
   * The event is a **sell**. This filter never refuses one — see
   * {@link evaluateForwardOnlyMirror}.
   */
  | 'exit-never-gated';

export interface ForwardOnlyMirror {
  readonly kind: 'mirror';
  /** Narrowed from the loose input so the caller does not re-derive it. */
  readonly side: 'buy' | 'sell';
  readonly basis: ForwardOnlyMirrorBasis;
  /**
   * Milliseconds from `active_since` to `event_at`; negative when the event
   * reads as earlier. `null` for a sell, where no window was consulted — never
   * `0`, which would claim a comparison that did not happen.
   */
  readonly eventOffsetMs: number | null;
}

/**
 * Why an entry was refused. Codes, not prose, because `S4-M24` needs a skip a
 * user can act on and these have genuinely different answers: "this predates
 * your subscription" is expected and permanent, "you unsubscribed" is the
 * user's own doing, and "we cannot read this timestamp" is our bug.
 */
export type ForwardOnlySkipCode =
  /**
   * **The `S4-M2` refusal.** The master made this entry before the current
   * active period began, so following it would be catch-up buying.
   */
  | 'source-event-precedes-active-since'
  /**
   * The subscription is `winding_down`: exits keep mirroring, entries have
   * stopped. Delegated from `mirrorEligibilityForState`, not decided here.
   */
  | 'subscription-entries-stopped'
  /**
   * `mirrorEligibilityForState` says this state mirrors nothing — `ended`, or
   * any state this build does not recognise. Fails closed.
   */
  | 'subscription-not-mirroring'
  /**
   * No subscription row for this (user, master) at all, so there is no active
   * window an entry could be inside of. Fails closed.
   */
  | 'no-subscription-window'
  /**
   * Not provably a `buy` or a `sell`. Fails closed — see the note in
   * {@link evaluateForwardOnlyMirror} on why the sell exemption forces this.
   */
  | 'source-side-unrecognised'
  /** `source_trades.event_at` is not a usable date. An indexer bug. */
  | 'source-event-timestamp-unreadable'
  /** `active_since` is not a usable date. A subscription-writer bug. */
  | 'active-since-unreadable';

export interface ForwardOnlySkip {
  readonly kind: 'skip';
  readonly code: ForwardOnlySkipCode;
  /** Operator- and user-readable, and specific enough to act on. */
  readonly reason: string;
}

export type ForwardOnlyDecision = ForwardOnlyMirror | ForwardOnlySkip;

export interface ForwardOnlyMirrorInput {
  /**
   * `source_trades.direction`.
   *
   * Typed `string`, not `SourceTradeSide`, following the same reasoning as
   * `evaluateMirrorableActivity`: the column's CHECK admits four values
   * (`028_copy_execution_lifecycle.sql`) and rows are mapped straight through,
   * so a narrow type here would be an assertion about a query rather than a
   * runtime guarantee.
   */
  readonly side: string;
  /** `source_trades.event_at` — when the master traded, per the chain. */
  readonly eventAt: Date;
  /** The subscription row, or `null` when the user has none for this master. */
  readonly subscription: ForwardOnlySubscriptionWindow | null;
  /**
   * How far *before* `active_since` an entry may read and still be admitted.
   * Defaults to {@link DEFAULT_FORWARD_ONLY_CLOCK_SKEW_TOLERANCE_MS}. See that
   * constant for why the default is zero.
   */
  readonly clockSkewToleranceMs?: number;
}

/**
 * Zero, and the asymmetry is the whole argument.
 *
 * `event_at` and `active_since` come from **different clocks**: `event_at` is a
 * chain or venue timestamp (a Solana block time is a stake-weighted median of
 * validator clocks; Polymarket's is the venue's own), while `active_since` is
 * this database's `NOW()`. They can disagree in either direction, and the two
 * errors are not equally bad.
 *
 *   * Tolerance too **low** — a chain clock running behind ours makes a
 *     genuine first entry read as pre-subscription and it is skipped. The user
 *     misses one entry in the seconds after subscribing and mirrors the next
 *     one. Recoverable, self-limiting, and already what `S6-31` warns about.
 *   * Tolerance too **high** — real pre-subscription history reads as
 *     in-window and is mirrored. Unrecoverable: the position is opened at a
 *     cost basis the user never had, which is the precise harm `S4-M2` exists
 *     to prevent.
 *
 * A safety gate whose failure modes are asymmetric defaults to the recoverable
 * one, so an event that reads as earlier than `active_since` is **not**
 * admitted unless an operator deliberately widens the window.
 *
 * There is a second reason not to widen it by default:
 * `listSourceTradeSignalCandidates` already admits `event_at <= now + INTERVAL
 * '30 seconds'`, which is this repo's existing acknowledgement that chain
 * clocks can run up to half a minute **ahead** of ours. Skew in that direction
 * already smuggles a little pre-subscription history past this gate and no
 * filter on these two columns can detect it. Adding backward tolerance on top
 * would widen an already-imperfect boundary in the dangerous direction.
 *
 * The knob exists so an operator who has *measured* a chain's drift can set it
 * with evidence, rather than patching this module.
 */
export const DEFAULT_FORWARD_ONLY_CLOCK_SKEW_TOLERANCE_MS = 0;

/** The only two sides this filter classifies. Anything else fails closed. */
const BUY = 'buy';
const SELL = 'sell';

/**
 * Whether one of the master's events is inside the current active window of
 * one subscription.
 *
 * Pure: no database, no clock, no environment. Both timestamps and the
 * tolerance are arguments.
 *
 * ## A sell is never refused here
 *
 * There is exactly **one** `sell` branch below and it is unconditional: no
 * timestamp is read, no state is consulted, no tolerance applies. The guarantee
 * is meant to be checkable by reading the function rather than by trusting a
 * comment.
 *
 * The reason is an asymmetry in what a refusal costs. Refusing an entry costs a
 * missed opportunity. Refusing an **exit** costs the user their way out: the
 * master's sell mirror is how a copied position was always going to close
 * (ADR-0005 §3.7 — a wind-down keeps honouring sells precisely so nothing is
 * orphaned), and a filter that declined it would leave the user holding a token
 * whose master has already left. Stranded is strictly worse than a missed
 * entry.
 *
 * This is also why the sell exemption is granted to a value that is *provably*
 * `'sell'` and never to "not a buy". If an unclassified side fell through to
 * the exempt branch, then any future or malformed `source_trades.direction`
 * would bypass the window check entirely — the exemption would become the hole.
 * Hence `source-side-unrecognised` fails closed even though `S4-M5`
 * (`evaluateMirrorableActivity`) is the gate that properly owns side
 * classification upstream.
 *
 * ## The boundary at `event_at == active_since`
 *
 * The window is **half-open**: `[active_since, infinity)`. An event whose
 * `event_at` is exactly `active_since` is **admitted**.
 *
 * `active_since` names the instant the subscription *became* active, so the
 * subscription is live *at* that instant and not merely after it. An event
 * timestamped there is concurrent with the join, not history — "catch-up
 * buying" means a backlog of positions already held, and a single event at the
 * microsecond of subscribing is the first mirror rather than a backlog. It is
 * also the same convention the SQL on this path already uses (`event_at >= now
 * - window` in `listSourceTradeSignalCandidates`), so a future SQL-side
 * implementation of this predicate agrees with the pure one by construction
 * instead of by coincidence.
 *
 * The case is close to unreachable in practice — two independent clocks
 * agreeing to the microsecond — so it is decided on which error would be
 * worse, and dropping a legitimate first mirror is a real, reachable regression
 * while admitting one concurrent event is not the harm the item names.
 *
 * ## Fails closed
 *
 * Absent evidence is never a pass. No subscription row, an unrecognised state,
 * an unreadable timestamp: all skip, each with its own code, because a missing
 * fact must not read the same as a satisfied check.
 */
export function evaluateForwardOnlyMirror(
  input: ForwardOnlyMirrorInput
): ForwardOnlyDecision {
  const toleranceMs = input.clockSkewToleranceMs ?? DEFAULT_FORWARD_ONLY_CLOCK_SKEW_TOLERANCE_MS;
  if (!Number.isFinite(toleranceMs) || toleranceMs < 0) {
    // Throws rather than degrading, following `resolveMinimumMirrorableNotionalUsd`:
    // silently coercing a bad tolerance to 0 tightens a gate without saying so,
    // and coercing it upward loosens one. A misconfiguration is an operator
    // error and belongs at the boundary, not absorbed into a trade decision.
    throw new Error(
      `clockSkewToleranceMs must be a non-negative finite number, received ${String(
        input.clockSkewToleranceMs
      )}`
    );
  }

  if (input.side !== BUY && input.side !== SELL) {
    return {
      kind: 'skip',
      code: 'source-side-unrecognised',
      reason:
        `the tracked wallet's event has side ${JSON.stringify(input.side)}, which is `
        + 'neither a buy nor a sell, so this build cannot tell whether it is an entry '
        + 'that must respect your subscription start'
    };
  }

  // THE sell branch. Unconditional, deliberately — see the doc comment.
  if (input.side === SELL) {
    return { kind: 'mirror', side: SELL, basis: 'exit-never-gated', eventOffsetMs: null };
  }

  const subscription = input.subscription;
  if (!subscription) {
    return {
      kind: 'skip',
      code: 'no-subscription-window',
      reason:
        'no subscription to this wallet was found for you, so there is no '
        + 'subscription start an entry could be after'
    };
  }

  // Delegated, not restated: `subscriptions.ts` is the only definition of what
  // a lifecycle state permits, and it returns 'none' for any state this build
  // does not recognise.
  const eligibility = mirrorEligibilityForState(subscription.state);
  if (eligibility === 'none') {
    return {
      kind: 'skip',
      code: 'subscription-not-mirroring',
      reason:
        `your subscription to this wallet is ${JSON.stringify(subscription.state)}, `
        + 'which mirrors nothing, so no new position will be opened'
    };
  }
  if (eligibility === 'sells-only') {
    return {
      kind: 'skip',
      code: 'subscription-entries-stopped',
      reason:
        'you have unsubscribed from this wallet, so new entries have stopped; '
        + 'the exits for positions you already hold are still being mirrored'
    };
  }

  if (!(subscription.activeSince instanceof Date) || Number.isNaN(subscription.activeSince.getTime())) {
    return {
      kind: 'skip',
      code: 'active-since-unreadable',
      reason:
        'the start of your subscription could not be read, so this entry cannot be '
        + 'shown to have happened after you subscribed'
    };
  }
  if (!(input.eventAt instanceof Date) || Number.isNaN(input.eventAt.getTime())) {
    return {
      kind: 'skip',
      code: 'source-event-timestamp-unreadable',
      reason:
        'the time of the tracked wallet\'s trade could not be read, so this entry '
        + 'cannot be shown to have happened after you subscribed'
    };
  }

  const eventOffsetMs = input.eventAt.getTime() - subscription.activeSince.getTime();
  if (eventOffsetMs >= 0) {
    return {
      kind: 'mirror',
      side: BUY,
      basis: 'event-at-or-after-active-since',
      eventOffsetMs
    };
  }
  if (eventOffsetMs >= -toleranceMs) {
    return {
      kind: 'mirror',
      side: BUY,
      basis: 'event-within-clock-skew-tolerance',
      eventOffsetMs
    };
  }
  return {
    kind: 'skip',
    code: 'source-event-precedes-active-since',
    reason:
      `the tracked wallet bought this token ${Math.abs(eventOffsetMs)}ms before your `
      + 'subscription started, so it is a position it already held; entering it now '
      + 'would mean buying at a cost basis you never had'
  };
}

// ---------------------------------------------------------------------------
// The DB half: read the window, decide nothing.
// ---------------------------------------------------------------------------

/**
 * `active_since` is selected and `created_at` deliberately is not, so this
 * query cannot be edited into the wrong column by autocomplete.
 */
const FORWARD_ONLY_WINDOW_COLUMNS = 'user_id, wallet_address, state, active_since';

interface ForwardOnlyWindowRow {
  user_id: string;
  wallet_address: string;
  state: string;
  active_since: Date;
}

function toWindow(row: ForwardOnlyWindowRow): ForwardOnlySubscriptionWindow {
  return {
    userId: row.user_id,
    walletAddress: row.wallet_address,
    state: row.state,
    activeSince: row.active_since
  };
}

/**
 * Read one subscription's forward-only window **on a caller-supplied client**.
 *
 * This overload exists so the read can happen inside the transaction that is
 * about to create a copy execution. Reading through the pool instead would use
 * a different snapshot, and a subscription that ended between the read and the
 * insert would still get an entry.
 *
 * Every lifecycle state is returned, including `ended`: the decision needs to
 * distinguish "you unsubscribed" from "we have no record of you following this
 * wallet", and a `WHERE state <> 'ended'` here would collapse the two into one
 * skip code.
 *
 * `userId` is a plain string rather than a `UserScope` because on the copy path
 * the tenant has already been established and canonicalised by
 * `normalizeTenantId`; the branded type guards the boundary where a tenant id
 * could come from a request payload, which is what
 * {@link loadForwardOnlySubscriptionWindow} is for.
 */
export async function readForwardOnlySubscriptionWindow(
  client: Pick<PoolClient, 'query'>,
  input: { userId: string; walletAddress: string }
): Promise<ForwardOnlySubscriptionWindow | null> {
  const result = await client.query<ForwardOnlyWindowRow>(
    `SELECT ${FORWARD_ONLY_WINDOW_COLUMNS}
       FROM user_wallet_subscriptions
      WHERE user_id = $1 AND wallet_address = $2`,
    [input.userId, input.walletAddress]
  );
  const row = result.rows[0];
  return row ? toWindow(row) : null;
}

/**
 * Pool-scoped read for callers outside a transaction — the fan-out planner and
 * any API surface that wants to explain a skip after the fact.
 *
 * Takes a `UserScope` so the tenant cannot arrive from a request payload.
 * `walletAddress` must be the chain-prefixed master address.
 */
export async function loadForwardOnlySubscriptionWindow(
  scope: UserScope,
  walletAddress: string
): Promise<ForwardOnlySubscriptionWindow | null> {
  const rows = await query<ForwardOnlyWindowRow>(
    `SELECT ${FORWARD_ONLY_WINDOW_COLUMNS}
       FROM user_wallet_subscriptions
      WHERE user_id = $1 AND wallet_address = $2`,
    [scope.userId, walletAddress]
  );
  const row = rows[0];
  return row ? toWindow(row) : null;
}
