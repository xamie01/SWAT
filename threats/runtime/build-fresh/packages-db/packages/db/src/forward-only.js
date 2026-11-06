import { query } from './client.js';
import { mirrorEligibilityForState } from './subscriptions.js';
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
export function evaluateForwardOnlyMirror(input) {
    const toleranceMs = input.clockSkewToleranceMs ?? DEFAULT_FORWARD_ONLY_CLOCK_SKEW_TOLERANCE_MS;
    if (!Number.isFinite(toleranceMs) || toleranceMs < 0) {
        // Throws rather than degrading, following `resolveMinimumMirrorableNotionalUsd`:
        // silently coercing a bad tolerance to 0 tightens a gate without saying so,
        // and coercing it upward loosens one. A misconfiguration is an operator
        // error and belongs at the boundary, not absorbed into a trade decision.
        throw new Error(`clockSkewToleranceMs must be a non-negative finite number, received ${String(input.clockSkewToleranceMs)}`);
    }
    if (input.side !== BUY && input.side !== SELL) {
        return {
            kind: 'skip',
            code: 'source-side-unrecognised',
            reason: `the tracked wallet's event has side ${JSON.stringify(input.side)}, which is `
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
            reason: 'no subscription to this wallet was found for you, so there is no '
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
            reason: `your subscription to this wallet is ${JSON.stringify(subscription.state)}, `
                + 'which mirrors nothing, so no new position will be opened'
        };
    }
    if (eligibility === 'sells-only') {
        return {
            kind: 'skip',
            code: 'subscription-entries-stopped',
            reason: 'you have unsubscribed from this wallet, so new entries have stopped; '
                + 'the exits for positions you already hold are still being mirrored'
        };
    }
    if (!(subscription.activeSince instanceof Date) || Number.isNaN(subscription.activeSince.getTime())) {
        return {
            kind: 'skip',
            code: 'active-since-unreadable',
            reason: 'the start of your subscription could not be read, so this entry cannot be '
                + 'shown to have happened after you subscribed'
        };
    }
    if (!(input.eventAt instanceof Date) || Number.isNaN(input.eventAt.getTime())) {
        return {
            kind: 'skip',
            code: 'source-event-timestamp-unreadable',
            reason: 'the time of the tracked wallet\'s trade could not be read, so this entry '
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
        reason: `the tracked wallet bought this token ${Math.abs(eventOffsetMs)}ms before your `
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
function toWindow(row) {
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
export async function readForwardOnlySubscriptionWindow(client, input) {
    const result = await client.query(`SELECT ${FORWARD_ONLY_WINDOW_COLUMNS}
       FROM user_wallet_subscriptions
      WHERE user_id = $1 AND wallet_address = $2`, [input.userId, input.walletAddress]);
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
export async function loadForwardOnlySubscriptionWindow(scope, walletAddress) {
    const rows = await query(`SELECT ${FORWARD_ONLY_WINDOW_COLUMNS}
       FROM user_wallet_subscriptions
      WHERE user_id = $1 AND wallet_address = $2`, [scope.userId, walletAddress]);
    const row = rows[0];
    return row ? toWindow(row) : null;
}
//# sourceMappingURL=forward-only.js.map