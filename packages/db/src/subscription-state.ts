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
export const SUBSCRIPTION_STATES: readonly SubscriptionState[] = Object.freeze([
  'active',
  'winding_down',
  'ended'
] as const);

export function isSubscriptionState(value: unknown): value is SubscriptionState {
  return typeof value === 'string' && (SUBSCRIPTION_STATES as readonly string[]).includes(value);
}

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
export function mirrorEligibilityForState(state: unknown): MirrorEligibility {
  switch (state) {
    case 'active':
      return 'buys-and-sells';
    case 'winding_down':
      return 'sells-only';
    default:
      return 'none';
  }
}

