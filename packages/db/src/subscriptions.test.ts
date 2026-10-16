import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const clientQuery = vi.fn();
  return {
    clientQuery,
    query: vi.fn(),
    // A real PoolClient is an EventEmitter and withTransaction attaches an
    // 'error' listener; transaction.test.ts covers that behaviour itself. The
    // real `withTransaction` runs here, so BEGIN/COMMIT show up in the
    // statement log and a helper that forgets its transaction is visible.
    connect: vi.fn(async () => ({
      query: clientQuery,
      release: vi.fn(),
      on: vi.fn(),
      off: vi.fn()
    }))
  };
});

vi.mock('./client.js', () => ({
  query: mocks.query,
  pool: { connect: mocks.connect }
}));

import {
  beginWindDown,
  endSubscription,
  evaluateSubscriptionTransition,
  getSubscriptionState,
  IllegalSubscriptionTransitionError,
  isSubscribed,
  isSubscriptionState,
  listWalletSubscriptions,
  mirrorEligibilityForState,
  QuotaExceededError,
  requestCloseAll,
  subscribeToWallet,
  SUBSCRIPTION_STATES,
  unsubscribeFromWallet,
  WalletNotSubscribedError,
  type SubscriptionState
} from './subscriptions.js';
import { forUser } from './tenancy.js';

/**
 * Subscription lifecycle (`S4-M3`, ADR-0005 §3.7, migration `051`).
 *
 * The state machine is the whole point of this file. Unsubscribe is an
 * exits-only wind-down, so the states are what stand between a user and two
 * distinct harms: an entry opened after they asked us to stop, and an open
 * position whose exit path we deleted. Neither is loud when it regresses —
 * the first looks like a normal copy and the second looks like nothing at all
 * until the master sells and no mirror fires.
 *
 * The pure half needs no database. The DB half is asserted through the
 * statement log, because what matters is *whether* an UPDATE was issued at
 * all: a refused transition that still writes is the failure mode.
 */

const scope = forUser('11111111-2222-3333-4444-555555555555');
const WALLET = 'solana:MasterWalletAddress1111111111111111111111';

interface Stub {
  match: RegExp;
  rows?: Record<string, unknown>[];
}

/** Statements the mocked client has seen, transaction control included. */
function statements(): string[] {
  return mocks.clientQuery.mock.calls.map((call) => String(call[0]));
}

function updates(): string[] {
  return statements().filter((text) => /^\s*UPDATE/i.test(text));
}

function routeClient(stubs: Stub[]): void {
  mocks.clientQuery.mockImplementation(async (text: string) => {
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(text)) return { rows: [] };
    const hit = stubs.find((stub) => stub.match.test(text));
    if (!hit) throw new Error(`unstubbed statement: ${text}`);
    return { rows: hit.rows ?? [] };
  });
}

function row(state: SubscriptionState, overrides: Record<string, unknown> = {}) {
  return {
    wallet_address: WALLET,
    label: null,
    source: 'manual',
    created_at: new Date('2026-01-01T00:00:00Z'),
    state,
    active_since: new Date('2026-01-01T00:00:00Z'),
    wound_down_at: state === 'active' ? null : new Date('2026-06-01T00:00:00Z'),
    ended_at: state === 'ended' ? new Date('2026-07-01T00:00:00Z') : null,
    close_all_requested_at: null,
    ...overrides
  };
}

beforeEach(() => {
  mocks.query.mockReset();
  mocks.clientQuery.mockReset();
});

// ---------------------------------------------------------------------------
// Pure state machine
// ---------------------------------------------------------------------------

describe('evaluateSubscriptionTransition', () => {
  const legal: Array<[SubscriptionState, SubscriptionState]> = [
    ['active', 'winding_down'],
    // Unsubscribe with nothing open: must not be forced through a wind-down it
    // would then sit in forever, because nothing would ever close to end it.
    ['active', 'ended'],
    ['winding_down', 'ended'],
    // Changed their mind mid-wind-down. The PK forbids a second row, so
    // refusing this would mean the user cannot re-subscribe until every
    // position happens to close.
    ['winding_down', 'active'],
    ['ended', 'active']
  ];

  for (const [from, to] of legal) {
    it(`allows ${from} -> ${to}`, () => {
      expect(evaluateSubscriptionTransition(from, to)).toEqual({ kind: 'apply', from, to });
    });
  }

  for (const state of SUBSCRIPTION_STATES) {
    it(`treats ${state} -> ${state} as a no-op, not an error`, () => {
      // A double-clicked unsubscribe and a redelivered job must be idempotent.
      expect(evaluateSubscriptionTransition(state, state)).toEqual({ kind: 'noop', state });
    });
  }

  it('refuses ended -> winding_down with a reason', () => {
    // `ended` means every position opened under this subscription is closed.
    // A sells-only claim over closed positions would send the sell mirror
    // looking for holdings that do not exist.
    const verdict = evaluateSubscriptionTransition('ended', 'winding_down');
    expect(verdict.kind).toBe('illegal');
    expect(verdict.kind === 'illegal' && verdict.reason).toMatch(/no open position/);
  });

  it('fails closed on a state this build does not recognise', () => {
    // Reachable rather than theoretical: `state` is a VARCHAR, so a future
    // migration, a manual UPDATE, or a service on another release can put a
    // value here that this build has never seen.
    for (const unknownState of ['paused', 'ACTIVE', 'active ', '', null, undefined, 7, {}]) {
      expect(evaluateSubscriptionTransition(unknownState, 'ended').kind).toBe('illegal');
      expect(evaluateSubscriptionTransition('active', unknownState).kind).toBe('illegal');
    }
  });

  it('recognises exactly the three documented states', () => {
    expect([...SUBSCRIPTION_STATES]).toEqual(['active', 'winding_down', 'ended']);
    expect(isSubscriptionState('winding_down')).toBe(true);
    expect(isSubscriptionState('winding-down')).toBe(false);
    // Frozen, not merely typed readonly: one stray push would widen the state
    // machine process-wide with no diff to review.
    expect(Object.isFrozen(SUBSCRIPTION_STATES)).toBe(true);
  });
});

describe('mirrorEligibilityForState', () => {
  it('mirrors buys and sells only while active', () => {
    expect(mirrorEligibilityForState('active')).toBe('buys-and-sells');
  });

  it('mirrors SELLS ONLY while winding down', () => {
    // The §7.4 fan-out term. If this ever returns 'buys-and-sells', every user
    // who unsubscribed keeps receiving entries they explicitly stopped.
    expect(mirrorEligibilityForState('winding_down')).toBe('sells-only');
  });

  it('mirrors nothing once ended', () => {
    expect(mirrorEligibilityForState('ended')).toBe('none');
  });

  it('mirrors nothing for an unrecognised state', () => {
    // Fails closed: treating an unknown state as active would open positions
    // on behalf of a user whose intent we cannot read.
    for (const unknownState of ['paused', '', null, undefined, 0, {}]) {
      expect(mirrorEligibilityForState(unknownState)).toBe('none');
    }
  });
});

// ---------------------------------------------------------------------------
// Transitions against the database
// ---------------------------------------------------------------------------

describe('beginWindDown', () => {
  it('stops entries and stamps the wind-down', async () => {
    routeClient([
      { match: /FOR UPDATE/, rows: [row('active')] },
      { match: /^\s*UPDATE/, rows: [row('winding_down')] }
    ]);

    const result = await beginWindDown(scope, WALLET);

    expect(result.changed).toBe(true);
    expect(result.subscription.state).toBe('winding_down');
    expect(updates()).toHaveLength(1);
    expect(updates()[0]).toContain("state = 'winding_down'");
    // COALESCE, so a repeat never resets the clock on a stuck wind-down.
    expect(updates()[0]).toContain('COALESCE(wound_down_at, NOW())');
  });

  it('is idempotent and writes nothing when already winding down', async () => {
    routeClient([{ match: /FOR UPDATE/, rows: [row('winding_down')] }]);

    const result = await beginWindDown(scope, WALLET);

    expect(result.changed).toBe(false);
    expect(updates()).toEqual([]);
  });

  it('refuses to write when the row carries an unrecognised state', async () => {
    // The database CHECK is the second line of defence, not the first: this
    // build must not write a transition it cannot reason about.
    routeClient([{ match: /FOR UPDATE/, rows: [row('paused' as SubscriptionState)] }]);

    await expect(beginWindDown(scope, WALLET)).rejects.toBeInstanceOf(
      IllegalSubscriptionTransitionError
    );
    expect(updates()).toEqual([]);
  });

  it('rejects an unsubscribed wallet without writing', async () => {
    routeClient([{ match: /FOR UPDATE/, rows: [] }]);

    await expect(beginWindDown(scope, WALLET)).rejects.toBeInstanceOf(WalletNotSubscribedError);
    expect(updates()).toEqual([]);
  });

  it('locks the subscription row it is about to transition', async () => {
    routeClient([
      { match: /FOR UPDATE/, rows: [row('active')] },
      { match: /^\s*UPDATE/, rows: [row('winding_down')] }
    ]);

    await beginWindDown(scope, WALLET);

    // Without the lock, an unsubscribe and a "last position closed" sweep can
    // both read `active` and leave timestamps that disagree with the state.
    expect(statements().some((text) => /FOR UPDATE/.test(text))).toBe(true);
    expect(statements()[0]).toMatch(/^BEGIN/);
    expect(statements().at(-1)).toMatch(/^COMMIT/);
  });
});

describe('unsubscribeFromWallet', () => {
  it('winds down when this master has an attributed open lot', async () => {
    routeClient([
      { match: /FOR UPDATE/, rows: [row('active')] },
      { match: /copy_position_lots/, rows: [{ open: true }] },
      { match: /^\s*UPDATE/, rows: [] }
    ]);

    await expect(unsubscribeFromWallet(scope, WALLET)).resolves.toBe(true);
    expect(updates()).toHaveLength(1);
    expect(updates()[0]).toContain("state = 'winding_down'");
    expect(updates()[0]).not.toContain('DELETE FROM');
  });

  it('ends immediately when this master has no attributed open lot', async () => {
    routeClient([
      { match: /FOR UPDATE/, rows: [row('active')] },
      { match: /copy_position_lots/, rows: [{ open: false }] },
      { match: /^\s*UPDATE/, rows: [] }
    ]);

    await expect(unsubscribeFromWallet(scope, WALLET)).resolves.toBe(true);
    expect(updates()).toHaveLength(1);
    expect(updates()[0]).toContain("state = 'ended'");
  });

  it('does not write when the subscription does not exist', async () => {
    routeClient([{ match: /FOR UPDATE/, rows: [] }]);

    await expect(unsubscribeFromWallet(scope, WALLET)).resolves.toBe(false);
    expect(updates()).toEqual([]);
  });
});

describe('endSubscription', () => {
  it('ends a subscription that never opened a position, straight from active', async () => {
    routeClient([
      { match: /FOR UPDATE/, rows: [row('active')] },
      { match: /copy_position_lots/, rows: [{ open: false }] },
      { match: /^\s*UPDATE/, rows: [row('ended', { wound_down_at: null })] }
    ]);

    const result = await endSubscription(scope, WALLET);

    expect(result.changed).toBe(true);
    expect(updates()[0]).toContain('ended_at = NOW()');
    // `wound_down_at` is not stamped on this path — there was no wind-down —
    // and migration 051's CHECK deliberately does not require it for `ended`.
    // Asserted on the SET clause: the RETURNING list names every column.
    expect(updates()[0]).not.toContain('wound_down_at =');
  });

  it('preserves wound_down_at when the wind-down completes', async () => {
    routeClient([
      { match: /FOR UPDATE/, rows: [row('winding_down')] },
      { match: /copy_position_lots/, rows: [{ open: false }] },
      { match: /^\s*UPDATE/, rows: [row('ended')] }
    ]);

    const result = await endSubscription(scope, WALLET);

    expect(result.subscription.woundDownAt).not.toBeNull();
    expect(updates()[0]).not.toContain('wound_down_at =');
  });

  it('is idempotent once ended', async () => {
    routeClient([{ match: /FOR UPDATE/, rows: [row('ended')] }]);

    expect((await endSubscription(scope, WALLET)).changed).toBe(false);
    expect(updates()).toEqual([]);
  });

  it('refuses to end while the subscription still owns an open lot', async () => {
    routeClient([
      { match: /FOR UPDATE/, rows: [row('winding_down')] },
      { match: /copy_position_lots/, rows: [{ open: true }] }
    ]);

    await expect(endSubscription(scope, WALLET)).rejects.toThrow(
      'attributed positions remain open'
    );
    expect(updates()).toEqual([]);
  });
});

describe('requestCloseAll', () => {
  it('stops entries and records the request in one statement', async () => {
    routeClient([
      { match: /FOR UPDATE/, rows: [row('active')] },
      {
        match: /^\s*UPDATE/,
        rows: [row('winding_down', { close_all_requested_at: new Date('2026-08-20T00:00:00Z') })]
      }
    ]);

    const result = await requestCloseAll(scope, WALLET);

    expect(result.changed).toBe(true);
    // One statement, so there is no window in which entries are still eligible
    // while exits are being requested.
    expect(updates()).toHaveLength(1);
    expect(updates()[0]).toContain("state = 'winding_down'");
    expect(updates()[0]).toContain('COALESCE(close_all_requested_at, NOW())');
    expect(result.subscription.closeAllRequestedAt).not.toBeNull();
  });

  it('does not re-request when one is already recorded', async () => {
    const requestedAt = new Date('2026-08-01T00:00:00Z');
    routeClient([
      { match: /FOR UPDATE/, rows: [row('winding_down', { close_all_requested_at: requestedAt })] },
      { match: /^\s*UPDATE/, rows: [row('winding_down', { close_all_requested_at: requestedAt })] }
    ]);

    const result = await requestCloseAll(scope, WALLET);

    // A second click must not become a second round of sells.
    expect(result.changed).toBe(false);
    expect(result.subscription.closeAllRequestedAt).toEqual(requestedAt);
    expect(updates()).toEqual([]);
  });

  it('refuses on an ended subscription', async () => {
    // Nothing is open to close; accepting would imply otherwise.
    routeClient([{ match: /FOR UPDATE/, rows: [row('ended')] }]);

    await expect(requestCloseAll(scope, WALLET)).rejects.toBeInstanceOf(
      IllegalSubscriptionTransitionError
    );
    expect(updates()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Re-subscribe
// ---------------------------------------------------------------------------

describe('subscribeToWallet re-subscribe path', () => {
  const input = {
    walletAddress: WALLET,
    chain: 'solana' as const,
    tier: 'free' as const,
    tierExpiresAt: null
  };

  it('revives an ended subscription forward-only, and charges quota for it', async () => {
    routeClient([
      { match: /FOR UPDATE/, rows: [{ id: scope.userId }] },
      { match: /COUNT\(\*\)/, rows: [{ count: '1' }] },
      { match: /SELECT wallet_address/, rows: [row('ended')] },
      // Migration 056: re-entering `active` allocates a membership ordinal
      // under a per-master advisory lock. See master-membership.test.ts.
      { match: /pg_advisory_xact_lock/, rows: [] },
      { match: /SELECT membership_slot/, rows: [] },
      { match: /^\s*UPDATE/, rows: [row('active', { wound_down_at: null, ended_at: null })] }
    ]);

    const result = await subscribeToWallet(scope, input);

    // A new lifecycle, so the API's 201 is honest.
    expect(result.subscriptionCreated).toBe(true);
    expect(result.subscription.state).toBe('active');
    // `active_since` is the forward-only boundary (S4-M2). Resetting it is what
    // stops a revived subscriber catching up on the master's trades from before
    // the revival — `created_at` still points at the first lifecycle.
    expect(updates()[0]).toContain('active_since = NOW()');
    expect(updates()[0]).toContain('wound_down_at = NULL');
    expect(updates()[0]).toContain('ended_at = NULL');
    expect(updates()[0]).toContain('close_all_requested_at = NULL');
  });

  it('excludes ended rows from the tracked-wallet quota', async () => {
    routeClient([
      { match: /FOR UPDATE/, rows: [{ id: scope.userId }] },
      { match: /COUNT\(\*\)/, rows: [{ count: '0' }] },
      { match: /SELECT wallet_address/, rows: [row('ended')] },
      { match: /pg_advisory_xact_lock/, rows: [] },
      { match: /SELECT membership_slot/, rows: [] },
      { match: /^\s*UPDATE/, rows: [row('active', { wound_down_at: null, ended_at: null })] }
    ]);

    await subscribeToWallet(scope, input);

    // Counting them would mean a free-tier user who ends three subscriptions
    // can never start another one.
    const counted = statements().find((text) => /COUNT\(\*\)/.test(text));
    expect(counted).toContain("state <> 'ended'");
  });

  it('refuses to revive an ended subscription when the user is at quota', async () => {
    routeClient([
      { match: /FOR UPDATE/, rows: [{ id: scope.userId }] },
      // Free tier tracks 3.
      { match: /COUNT\(\*\)/, rows: [{ count: '3' }] },
      { match: /SELECT wallet_address/, rows: [row('ended')] }
    ]);

    await expect(subscribeToWallet(scope, input)).rejects.toBeInstanceOf(QuotaExceededError);
    expect(updates()).toEqual([]);
  });

  it('resumes a winding-down subscription without charging quota again', async () => {
    routeClient([
      { match: /FOR UPDATE/, rows: [{ id: scope.userId }] },
      { match: /SELECT wallet_address/, rows: [row('winding_down')] },
      { match: /pg_advisory_xact_lock/, rows: [] },
      // No COUNT(*) stub, deliberately: the membership read is a plain SELECT of
      // the ordinals, so an accidental quota re-check would still be caught.
      { match: /SELECT membership_slot/, rows: [] },
      { match: /^\s*UPDATE/, rows: [row('active', { wound_down_at: null })] }
    ]);

    const result = await subscribeToWallet(scope, input);

    // The row was never released, so it still occupies its slot. Charging
    // again would refuse a user their own wallet back at the quota boundary;
    // the unstubbed COUNT below is what proves no charge happened.
    expect(statements().some((text) => /COUNT\(\*\)/.test(text))).toBe(false);
    // Resuming a wind-down is not a creation, so the API answers 200, not 201.
    expect(result.subscriptionCreated).toBe(false);
    expect(result.subscription.state).toBe('active');
  });

  it('is a no-op for an already-active subscription', async () => {
    routeClient([
      { match: /FOR UPDATE/, rows: [{ id: scope.userId }] },
      { match: /SELECT wallet_address/, rows: [row('active')] }
    ]);

    const result = await subscribeToWallet(scope, input);

    expect(result.subscriptionCreated).toBe(false);
    expect(result.walletCreated).toBe(false);
    expect(updates()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Read scoping
// ---------------------------------------------------------------------------

describe('live-subscription reads', () => {
  it('hides ended subscriptions from the user without deleting them', async () => {
    mocks.query.mockResolvedValue([]);
    await listWalletSubscriptions(scope);
    await isSubscribed(scope, WALLET);

    // The filter is the behaviour here — PostgreSQL applies it — so the SQL is
    // what there is to assert. `winding_down` must survive both filters: those
    // users still have open positions being mirrored out and marked to market.
    for (const call of mocks.query.mock.calls) {
      expect(String(call[0])).toContain("state <> 'ended'");
    }
  });

  it('exposes the ended row to the lifecycle reader', async () => {
    mocks.query.mockResolvedValue([row('ended')]);
    const record = await getSubscriptionState(scope, WALLET);

    expect(record?.state).toBe('ended');
    // Retained for attribution, so this reader must NOT filter it out.
    expect(String(mocks.query.mock.calls[0]?.[0])).not.toContain("state <> 'ended'");
  });
});

// ---------------------------------------------------------------------------
// Migration 051
// ---------------------------------------------------------------------------

describe('migration 051', () => {
  const sqlPath = resolve(import.meta.dirname, '../sql/051_subscription_states.sql');

  /** Comments talk about CREATE and ADD; only executable text is interesting. */
  async function executableSql(): Promise<string> {
    const raw = await readFile(sqlPath, 'utf8');
    return raw
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');
  }

  it('constrains the column to exactly the states this module knows', async () => {
    const sql = await executableSql();
    const check = /CHECK \(state IN \(([^)]*)\)\)/.exec(sql);
    expect(check).not.toBeNull();
    const states = check![1]!.split(',').map((value) => value.trim().replace(/'/g, ''));
    // Drift between the TS union and the SQL CHECK is silent in both
    // directions: a state TS can emit but the database rejects fails a write at
    // runtime, and a state the database accepts but TS cannot read falls
    // through `mirrorEligibilityForState` to 'none' and stops mirroring.
    expect(states).toEqual([...SUBSCRIPTION_STATES]);
  });

  it('defaults existing rows to active', async () => {
    const sql = await executableSql();
    // Exact, not a fallback: every row that exists was written by
    // `subscribeToWallet` and no fan-out has run, so none can be mid-wind-down.
    expect(sql).toMatch(/state VARCHAR\(16\) NOT NULL DEFAULT 'active'/);
  });

  it('makes an incoherent state/timestamp row unrepresentable, and fails closed', async () => {
    const sql = await executableSql();
    expect(sql).toContain('chk_subscription_state_stamps');
    // A fourth state added to the enum without a branch here is rejected
    // loudly rather than escaping the invariant.
    expect(sql).toContain('ELSE FALSE');
  });

  it('replays safely: every constraint add is guarded', async () => {
    const sql = await executableSql();
    // `migrate.ts` has no applied-migrations table, so a bare ADD CONSTRAINT
    // would break `pnpm db:migrate` for every developer on the second run.
    const guards = sql.match(/IF NOT EXISTS \(\s*SELECT 1\s+FROM pg_constraint/g) ?? [];
    const adds = sql.match(/ADD CONSTRAINT/g) ?? [];
    expect(adds.length).toBeGreaterThan(0);
    expect(guards.length).toBe(adds.length);
  });

  it('adds the forward-only boundary column and backfills it from created_at', async () => {
    const sql = await executableSql();
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS active_since');
    // Stamping NOW() instead would erase every existing subscription's real
    // start time, and it is the boundary S4-M2 filters on.
    expect(sql).toMatch(/SET active_since = created_at\s+WHERE active_since IS NULL/);
  });
});
