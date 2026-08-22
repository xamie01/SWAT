import { describe, expect, it, vi } from 'vitest';

// `forward-only.ts` holds a DB half alongside the pure predicate, so importing it
// pulls in `client.js`, which demands a URL at import time. The pool never
// connects here — every case below is pure. Same shim as `stop-loss.test.ts`.
vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgres://forward-only-unit-test/unused';
});

import {
  DEFAULT_FORWARD_ONLY_CLOCK_SKEW_TOLERANCE_MS,
  evaluateForwardOnlyMirror,
  type ForwardOnlySubscriptionWindow
} from './forward-only.js';

const ACTIVE_SINCE = new Date('2026-08-20T12:00:00.000Z');

function subscription(
  overrides: Partial<ForwardOnlySubscriptionWindow> = {}
): ForwardOnlySubscriptionWindow {
  return {
    userId: 'user-1',
    walletAddress: 'solana:master-wallet',
    state: 'active',
    activeSince: ACTIVE_SINCE,
    ...overrides
  };
}

/** Offsets from `active_since`, so intent is readable at each call site. */
function at(offsetMs: number): Date {
  return new Date(ACTIVE_SINCE.getTime() + offsetMs);
}

describe('evaluateForwardOnlyMirror — the S4-M2 done-when', () => {
  it('refuses a buy the master made BEFORE the subscription went active', () => {
    // The item's done-when: "a test asserts a new subscriber receives no position
    // for a token the master held before subscription." Entering an existing
    // position at an unknown cost basis is how followers become exit liquidity.
    const decision = evaluateForwardOnlyMirror({
      side: 'buy',
      eventAt: at(-60 * 60_000), // an hour before
      subscription: subscription()
    });
    expect(decision).toMatchObject({
      kind: 'skip',
      code: 'source-event-precedes-active-since'
    });
  });

  it('mirrors a buy at or after active_since', () => {
    expect(evaluateForwardOnlyMirror({
      side: 'buy',
      eventAt: at(60_000),
      subscription: subscription()
    })).toMatchObject({ kind: 'mirror', basis: 'event-at-or-after-active-since' });
  });

  it('admits a buy exactly AT active_since', () => {
    // Boundary. Excluding it would drop a legitimate first mirror for a wallet
    // whose event landed in the same millisecond the subscription was written.
    const decision = evaluateForwardOnlyMirror({
      side: 'buy',
      eventAt: ACTIVE_SINCE,
      subscription: subscription()
    });
    expect(decision.kind).toBe('mirror');
    if (decision.kind === 'mirror') expect(decision.eventOffsetMs).toBe(0);
  });

  it('refuses a buy one millisecond before active_since at the default tolerance', () => {
    expect(evaluateForwardOnlyMirror({
      side: 'buy',
      eventAt: at(-1),
      subscription: subscription()
    })).toMatchObject({ kind: 'skip', code: 'source-event-precedes-active-since' });
  });
});

describe('the sell exemption', () => {
  it('never gates a sell, even one long predating the subscription', () => {
    // A sell is the user's exit. If they somehow hold a position, refusing the
    // master's sell strands them — strictly worse than a missed entry.
    const decision = evaluateForwardOnlyMirror({
      side: 'sell',
      eventAt: at(-365 * 24 * 60 * 60_000),
      subscription: subscription()
    });
    expect(decision).toMatchObject({ kind: 'mirror', basis: 'exit-never-gated' });
  });

  it('reports no offset for a sell rather than a misleading zero', () => {
    // `0` would claim a comparison that never happened.
    const decision = evaluateForwardOnlyMirror({
      side: 'sell',
      eventAt: at(-1_000),
      subscription: subscription()
    });
    if (decision.kind === 'mirror') expect(decision.eventOffsetMs).toBeNull();
  });

  it('still exempts a sell while the subscription is winding down', () => {
    // Exits-only wind-down (S4-M3): entries have stopped, sells keep mirroring
    // until each open position closes.
    expect(evaluateForwardOnlyMirror({
      side: 'sell',
      eventAt: at(-1_000),
      subscription: subscription({ state: 'winding_down' })
    })).toMatchObject({ kind: 'mirror' });
  });
});

describe('subscription state is delegated, not re-decided', () => {
  it('stops entries while winding down', () => {
    expect(evaluateForwardOnlyMirror({
      side: 'buy',
      eventAt: at(60_000),
      subscription: subscription({ state: 'winding_down' })
    })).toMatchObject({ kind: 'skip', code: 'subscription-entries-stopped' });
  });

  it('mirrors nothing for an ended subscription', () => {
    expect(evaluateForwardOnlyMirror({
      side: 'buy',
      eventAt: at(60_000),
      subscription: subscription({ state: 'ended' })
    })).toMatchObject({ kind: 'skip', code: 'subscription-not-mirroring' });
  });

  it('fails closed on a state this build does not recognise', () => {
    // `state` is a VARCHAR, so an unknown value is reachable. Treating it as
    // mirrorable would let a schema change re-enable entries silently.
    for (const state of ['paused', '', null, undefined, 42]) {
      expect(evaluateForwardOnlyMirror({
        side: 'buy',
        eventAt: at(60_000),
        subscription: subscription({ state })
      })).toMatchObject({ kind: 'skip' });
    }
  });
});

describe('fail-closed branches', () => {
  it('refuses when the user has no subscription at all', () => {
    expect(evaluateForwardOnlyMirror({
      side: 'buy',
      eventAt: at(60_000),
      subscription: null
    })).toMatchObject({ kind: 'skip', code: 'no-subscription-window' });
  });

  it('STILL mirrors a sell when there is no subscription row at all', () => {
    // Counter-intuitive and deliberate: the sell branch is unconditional and sits
    // ahead of every other check, so an exit is gated by nothing — not timing, not
    // lifecycle state, not even the existence of a subscription.
    //
    // This is load-bearing rather than theoretical. `unsubscribeFromWallet` still
    // hard-deletes the row today (see S4-M3), so a user can hold an open position
    // with no subscription row, and refusing the master's sell would leave it with
    // no exit path at all. What keeps it safe is downstream: a sell mirror is
    // proportional to the position actually held, and `computeCopySellProportion`
    // throws rather than defaulting to sell-everything when position evidence is
    // missing. So a user holding nothing gets nothing, not a spurious order.
    //
    // If this ever needs to become a skip, the position-orphan case must be closed
    // first, or the change silently strands positions.
    expect(evaluateForwardOnlyMirror({
      side: 'sell',
      eventAt: at(60_000),
      subscription: null
    })).toMatchObject({ kind: 'mirror', basis: 'exit-never-gated' });
  });

  it('mirrors a sell even for an ended subscription, for the same reason', () => {
    // `ended` should mean the wind-down completed and nothing is open — but if a
    // position survived, this is its only exit.
    expect(evaluateForwardOnlyMirror({
      side: 'sell',
      eventAt: at(-99_999),
      subscription: subscription({ state: 'ended' })
    })).toMatchObject({ kind: 'mirror', basis: 'exit-never-gated' });
  });

  it('refuses a side that is not provably buy or sell', () => {
    for (const side of ['transfer_in', 'transfer_out', 'BUY', '', 'lp']) {
      expect(evaluateForwardOnlyMirror({
        side,
        eventAt: at(60_000),
        subscription: subscription()
      })).toMatchObject({ kind: 'skip', code: 'source-side-unrecognised' });
    }
  });

  it('refuses an unreadable event timestamp', () => {
    expect(evaluateForwardOnlyMirror({
      side: 'buy',
      eventAt: new Date('not a date'),
      subscription: subscription()
    })).toMatchObject({ kind: 'skip', code: 'source-event-timestamp-unreadable' });
  });

  it('refuses an unreadable active_since', () => {
    expect(evaluateForwardOnlyMirror({
      side: 'buy',
      eventAt: at(60_000),
      subscription: subscription({ activeSince: new Date('not a date') })
    })).toMatchObject({ kind: 'skip', code: 'active-since-unreadable' });
  });
});

describe('clock-skew tolerance', () => {
  it('defaults to zero, so no pre-subscription event is admitted by accident', () => {
    // The failure modes are asymmetric: too low costs one missed entry the user
    // recovers from on the next trade; too high opens a position at a cost basis
    // the user never had, which is unrecoverable and is the harm S4-M2 prevents.
    expect(DEFAULT_FORWARD_ONLY_CLOCK_SKEW_TOLERANCE_MS).toBe(0);
  });

  it('admits an event inside an explicitly widened tolerance, and says so', () => {
    const decision = evaluateForwardOnlyMirror({
      side: 'buy',
      eventAt: at(-5_000),
      subscription: subscription(),
      clockSkewToleranceMs: 10_000
    });
    expect(decision).toMatchObject({
      kind: 'mirror',
      basis: 'event-within-clock-skew-tolerance'
    });
  });

  it('still refuses an event beyond the widened tolerance', () => {
    expect(evaluateForwardOnlyMirror({
      side: 'buy',
      eventAt: at(-15_000),
      subscription: subscription(),
      clockSkewToleranceMs: 10_000
    })).toMatchObject({ kind: 'skip', code: 'source-event-precedes-active-since' });
  });

  it('throws on a misconfigured tolerance rather than coercing it', () => {
    // Coercing to 0 tightens a gate without saying so; coercing upward loosens
    // one. Either way the operator is not told.
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => evaluateForwardOnlyMirror({
        side: 'buy',
        eventAt: at(60_000),
        subscription: subscription(),
        clockSkewToleranceMs: bad
      })).toThrow(/non-negative finite/);
    }
  });
});

describe('re-subscribe is the case created_at would get wrong', () => {
  it('measures against the CURRENT active period, not the original signup', () => {
    // The PK is (user_id, wallet_address), so re-subscribe is an ended -> active
    // transition on the same row: `created_at` still reads January for a
    // subscription revived in August. Filtering on it would mirror eight months
    // of history on every re-subscribe — catch-up buying in the one case nobody
    // tests. `active_since` is reset on each entry into `active`.
    const revivedAt = new Date('2026-08-20T12:00:00.000Z');
    const duringFirstPeriod = new Date('2026-01-15T00:00:00.000Z');

    expect(evaluateForwardOnlyMirror({
      side: 'buy',
      eventAt: duringFirstPeriod,
      subscription: subscription({ activeSince: revivedAt })
    })).toMatchObject({ kind: 'skip', code: 'source-event-precedes-active-since' });
  });
});
