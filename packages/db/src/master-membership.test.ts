import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const clientQuery = vi.fn();
  return {
    clientQuery,
    query: vi.fn(),
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

import { DEFAULT_FOLLOWER_SOFT_CAP } from './master-capacity.js';
import { assessFanoutCandidate } from './fanout-eligibility.js';
import {
  MASTER_MEMBERSHIP_CAP,
  MEMBERSHIP_SLOT_INDEX,
  MEMBERSHIP_USER_MESSAGE,
  MasterMembershipFullError,
  MasterMembershipInputError,
  MembershipSlotConflictError,
  assertDigitFreeMembershipMessage,
  decideMasterMembership,
  isMembershipSlotConflict,
  lowestFreeMembershipSlot,
  masterMembershipLockKey,
  requireGrantedSlot
} from './master-membership.js';
import type { MasterMembershipInput, MasterMembershipOccupancy } from './master-membership.js';
import { mirrorEligibilityForState, subscribeToWallet } from './subscriptions.js';
import type { SubscriptionState } from './subscriptions.js';
import { forUser } from './tenancy.js';

/**
 * Master membership cap (`S4-M43`), and the rule that a dropped copier does not
 * get their slot back (`S4-M44`). Migration `056`.
 *
 * Three things this file exists to hold down, each of which fails quietly:
 *
 *  1. **The refusal discloses nothing.** No digits, and — the part that is easy
 *     to lose — the *same* string for every cause. Two different messages let a
 *     caller read backend state off the copy, which is the `S4-M9` leak in a
 *     different costume.
 *  2. **A `winding_down` user holds no slot but still receives sells.** Count
 *     them and the cap under-serves the master; drop them from enumeration and
 *     their open positions strand with no exit.
 *  3. **The cap is a constraint, not a count.** A `COUNT(*) < 50` before an
 *     INSERT is exceeded by exactly the number of concurrent racers, so the
 *     assertions on migration `056` are load-bearing rather than decorative.
 */

const MASTER = 'solana:MasterWalletAddress1111111111111111111111';
const scope = forUser('11111111-2222-3333-4444-555555555555');

function occupancy(
  overrides: Partial<MasterMembershipOccupancy> = {}
): MasterMembershipOccupancy {
  return { occupiedSlots: [], grandfatheredActiveCount: 0, ...overrides };
}

/** Every ordinal taken, so the master is full at whatever cap is in force. */
function fullOccupancy(cap = MASTER_MEMBERSHIP_CAP): MasterMembershipOccupancy {
  return occupancy({
    occupiedSlots: Array.from({ length: cap }, (_unused, index) => index + 1)
  });
}

function input(overrides: Partial<MasterMembershipInput> = {}): MasterMembershipInput {
  return {
    masterWalletAddress: MASTER,
    occupancy: occupancy(),
    requester: { priorState: null, heldSlot: null },
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// The cap itself
// ---------------------------------------------------------------------------

describe('MASTER_MEMBERSHIP_CAP', () => {
  it('equals the per-signal follower soft cap', () => {
    // The equality is the product promise, not a coincidence. One
    // concurrency-1 worker per chain at ~6s/order drains ~50 orders per
    // 5-minute window, so membership above the per-signal cap admits users who
    // structurally cannot be served inside one window — which is how everyone
    // past roughly #50 ends up filling worse than the master they pay to copy.
    // A deliberate divergence has to be recorded by editing this test.
    expect(MASTER_MEMBERSHIP_CAP).toBe(DEFAULT_FOLLOWER_SOFT_CAP);
    expect(MASTER_MEMBERSHIP_CAP).toBe(50);
  });
});

describe('lowestFreeMembershipSlot', () => {
  it('returns the lowest unoccupied ordinal', () => {
    expect(lowestFreeMembershipSlot([1, 2, 4], 50)).toBe(3);
    expect(lowestFreeMembershipSlot([], 50)).toBe(1);
  });

  it('reuses a released ordinal rather than counting upward', () => {
    // A monotonic counter would exhaust 1..50 after 50 joins no matter how many
    // members had since left, so the range CHECK would start refusing an empty
    // master.
    expect(lowestFreeMembershipSlot([2, 3], 50)).toBe(1);
  });

  it('returns null when every ordinal in range is held', () => {
    expect(lowestFreeMembershipSlot([1, 2, 3], 3)).toBeNull();
  });

  it('ignores ordinals above the cap instead of handing them out again', () => {
    // Lowering the cap later leaves legacy ordinals out of range. They stay
    // taken and are never re-allocated; the free search simply never reaches
    // them.
    expect(lowestFreeMembershipSlot([1, 2, 90], 3)).toBe(3);
    expect(lowestFreeMembershipSlot([1, 2, 3, 90], 3)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The pure decision
// ---------------------------------------------------------------------------

describe('decideMasterMembership — admitting', () => {
  it('grants the lowest free ordinal to a first-time joiner', () => {
    const decision = decideMasterMembership(
      input({ occupancy: occupancy({ occupiedSlots: [1, 3] }) })
    );
    expect(decision.outcome).toBe('admit');
    expect(decision.reasonCode).toBe('membership-slot-granted');
    expect(decision.slot).toBe(2);
    expect(decision.user.message).toBeNull();
  });

  it('says nothing to the user on an admit', () => {
    expect(decideMasterMembership(input()).user.message).toBeNull();
  });

  it('admits an existing active member without consuming a second ordinal', () => {
    // An idempotent re-subscribe must not burn a slot, and must not be refused
    // when the master has filled up since they joined.
    const decision = decideMasterMembership(
      input({
        occupancy: fullOccupancy(),
        requester: { priorState: 'active', heldSlot: 7 }
      })
    );
    expect(decision.outcome).toBe('admit');
    expect(decision.reasonCode).toBe('membership-already-active');
    expect(decision.slot).toBe(7);
  });

  it('admits a grandfathered active member who holds no ordinal', () => {
    // Migration 056 leaves these rows on masters that were already over the cap.
    // They are members; they simply hold no slot, so there is nothing to write.
    const decision = decideMasterMembership(
      input({
        occupancy: fullOccupancy(),
        requester: { priorState: 'active', heldSlot: null }
      })
    );
    expect(decision.outcome).toBe('admit');
    expect(decision.reasonCode).toBe('membership-already-active');
    expect(decision.slot).toBeNull();
    expect(decision.internal.detail).toMatch(/grandfathered/);
  });
});

describe('decideMasterMembership — refusing', () => {
  it('refuses a first-time joiner when every ordinal is held', () => {
    const decision = decideMasterMembership(input({ occupancy: fullOccupancy() }));
    expect(decision.outcome).toBe('refuse');
    expect(decision.reasonCode).toBe('membership-cap-reached');
    expect(decision.slot).toBeNull();
  });

  it('refuses a re-subscribe whose old slot has been taken (S4-M44)', () => {
    // The distinguishing internal code is the whole of S4-M44: ops can see
    // re-subscribe pressure, the user cannot tell the two refusals apart.
    for (const priorState of ['winding_down', 'ended'] satisfies SubscriptionState[]) {
      const decision = decideMasterMembership(
        input({
          occupancy: fullOccupancy(),
          requester: { priorState, heldSlot: null }
        })
      );
      expect(decision.outcome).toBe('refuse');
      expect(decision.reasonCode).toBe('membership-slot-not-reclaimable');
      expect(decision.internal.reSubscribe).toBe(true);
      expect(decision.internal.detail).toMatch(/not reserved/);
    }
  });

  it('admits a re-subscribe when an ordinal has since been freed', () => {
    // No grandfathering and no waitlist priority — but no punishment either. A
    // returning user competes for a free slot on equal terms.
    const decision = decideMasterMembership(
      input({
        occupancy: occupancy({ occupiedSlots: [1, 2] }),
        requester: { priorState: 'ended', heldSlot: null }
      })
    );
    expect(decision.outcome).toBe('admit');
    expect(decision.slot).toBe(3);
  });

  it('fails closed when occupancy could not be read', () => {
    // An unreadable occupancy is not an empty one. Admitting blind is how a
    // transient read failure becomes an uncapped master.
    const decision = decideMasterMembership(input({ occupancy: null }));
    expect(decision.outcome).toBe('refuse');
    expect(decision.reasonCode).toBe('membership-occupancy-unknown');
    expect(decision.internal.occupiedSlotCount).toBeNull();
  });

  it('never revokes an existing member because occupancy was unreadable', () => {
    // Fail-closed protects new joins. Applying it to an existing active member
    // would refuse them their own wallet during any read blip.
    const decision = decideMasterMembership(
      input({ occupancy: null, requester: { priorState: 'active', heldSlot: 4 } })
    );
    expect(decision.outcome).toBe('admit');
  });
});

describe('decideMasterMembership — the winding_down interaction (S4-M45)', () => {
  it('does not let a winding-down subscription occupy an ordinal', () => {
    // A leaver holding a slot makes the cap under-serve the master by exactly
    // the number of people on their way out. Migration 056's CHECK forbids the
    // row; this asserts the decision layer agrees, by treating a winding-down
    // requester as somebody who needs a fresh ordinal rather than one who has
    // one.
    const decision = decideMasterMembership(
      input({
        occupancy: occupancy({ occupiedSlots: [1] }),
        requester: { priorState: 'winding_down', heldSlot: null }
      })
    );
    expect(decision.outcome).toBe('admit');
    expect(decision.slot).toBe(2);
  });

  it('throws if a non-active row is presented as holding an ordinal', () => {
    // Unrepresentable per 056's coherence CHECK. Guessing here would either
    // strand the ordinal or hand out a duplicate.
    expect(() =>
      decideMasterMembership(
        input({ requester: { priorState: 'winding_down', heldSlot: 3 } })
      )
    ).toThrow(MasterMembershipInputError);
  });

  it('still mirrors the master sells for a winding-down user who holds no slot', () => {
    // The pairing S4-M44 requires: releasing the ordinal must not remove them
    // from enumeration. Mirror eligibility is derived from `state` alone and
    // nothing on the fan-out path reads `membership_slot`, so the two facts
    // cannot be conflated.
    expect(mirrorEligibilityForState('winding_down')).toBe('sells-only');

    const verdict = assessFanoutCandidate(
      {
        userId: scope.userId,
        subscriptionState: 'winding_down',
        tier: 'operator',
        tierExpiresAt: null,
        autoExecute: true,
        killed: false,
        minSignalScore: 0,
        maxConcurrentPositions: 5,
        openPositionCount: 1,
        knownBalanceUsd: 1_000
      },
      {
        chain: 'solana',
        masterWalletAddress: MASTER,
        tokenMint: 'solana:TOKEN',
        direction: 'sell',
        score: 80
      },
      {
        chainMode: { effectiveMode: 'paper' },
        minimumBalanceUsd: 10,
        capacity: { outcome: 'admit' }
      }
    );
    expect(verdict.kind).toBe('eligible');
    expect(verdict.kind === 'eligible' && verdict.mirrors).toBe('sells-only');
  });
});

describe('decideMasterMembership — incoherent inputs fail loud', () => {
  it('rejects a non-positive or fractional cap', () => {
    for (const cap of [0, -1, 1.5, Number.NaN]) {
      expect(() => decideMasterMembership(input({ cap }))).toThrow(MasterMembershipInputError);
    }
  });

  it('rejects a missing master address', () => {
    expect(() => decideMasterMembership(input({ masterWalletAddress: '' }))).toThrow(
      MasterMembershipInputError
    );
  });

  it('rejects duplicate ordinals, because they mean the unique index is gone', () => {
    expect(() =>
      decideMasterMembership(input({ occupancy: occupancy({ occupiedSlots: [1, 1] }) }))
    ).toThrow(new RegExp(MEMBERSHIP_SLOT_INDEX));
  });

  it('rejects a non-integer or non-positive ordinal', () => {
    for (const slot of [0, -3, 1.5, Number.NaN]) {
      expect(() =>
        decideMasterMembership(input({ occupancy: occupancy({ occupiedSlots: [slot] }) }))
      ).toThrow(MasterMembershipInputError);
    }
  });

  it('rejects a negative grandfathered count', () => {
    expect(() =>
      decideMasterMembership(input({ occupancy: occupancy({ grandfatheredActiveCount: -1 }) }))
    ).toThrow(MasterMembershipInputError);
  });

  it('refuses to hand a caller a null ordinal to write', () => {
    const alreadyActive = decideMasterMembership(
      input({ requester: { priorState: 'active', heldSlot: null } })
    );
    expect(() => requireGrantedSlot(alreadyActive)).toThrow(MasterMembershipInputError);
    expect(requireGrantedSlot(decideMasterMembership(input()))).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The refusal discloses nothing (S4-M9)
// ---------------------------------------------------------------------------

describe('the membership refusal message', () => {
  const causes: Array<[string, MasterMembershipInput]> = [
    ['cap reached', input({ occupancy: fullOccupancy() })],
    [
      're-subscribe refused',
      input({ occupancy: fullOccupancy(), requester: { priorState: 'ended', heldSlot: null } })
    ],
    ['occupancy unknown', input({ occupancy: null })]
  ];

  it('is the frozen generic string', () => {
    expect(MEMBERSHIP_USER_MESSAGE).toBe('This master is not accepting new copiers.');
  });

  it('discloses no count, cap, ordinal or cause', () => {
    for (const [, candidate] of causes) {
      const userFacing = JSON.stringify(decideMasterMembership(candidate).user);
      // A digit is the leak this item is about: a headcount is a crowding
      // signal, and it tells a master exactly when farming their own followers
      // pays (S4-M9).
      expect(userFacing).not.toMatch(/\d/);
      expect(userFacing).not.toMatch(/follower/i);
      expect(userFacing).not.toMatch(/limit/i);
      expect(userFacing).not.toMatch(/full/i);
      expect(userFacing).not.toMatch(/capacity/i);
      expect(userFacing).not.toMatch(/slot/i);
      expect(userFacing).not.toMatch(/member/i);
      expect(userFacing).not.toMatch(/quota/i);
    }
    expect(MEMBERSHIP_USER_MESSAGE).not.toMatch(/\d/);
  });

  it('is identical for every cause, so the cause cannot be inferred from it', () => {
    // Differing wording is itself a distinguishable signal: "at capacity" vs
    // "your old slot is gone" lets a caller read backend state off the copy.
    const messages = new Set(
      causes.map(([, candidate]) => decideMasterMembership(candidate).user.message)
    );
    expect(messages).toEqual(new Set([MEMBERSHIP_USER_MESSAGE]));
    // ...while the internal codes stay distinct, so ops keep the diagnosis.
    const codes = new Set(
      causes.map(([, candidate]) => decideMasterMembership(candidate).internal.code)
    );
    expect(codes.size).toBe(causes.length);
  });

  it('keeps the real figures under `internal`, where rendering them is reviewable', () => {
    const decision = decideMasterMembership(
      input({ occupancy: occupancy({ occupiedSlots: [1, 2, 3] }), cap: 3 })
    );
    expect(decision.internal.cap).toBe(3);
    expect(decision.internal.occupiedSlotCount).toBe(3);
    expect(decision.internal.detail).toMatch(/\d/);
  });

  it('carries the digit-free string as the thrown error message too', () => {
    // Fastify error handlers routinely echo `error.message`. A diagnostic here
    // would leak the cap through a path nobody reviews.
    const full = new MasterMembershipFullError(
      decideMasterMembership(input({ occupancy: fullOccupancy() }))
    );
    expect(full.message).toBe(MEMBERSHIP_USER_MESSAGE);
    expect(full.message).not.toMatch(/\d/);
    expect(full.decision.internal.code).toBe('membership-cap-reached');

    expect(new MembershipSlotConflictError('two racers on one ordinal').message).toBe(
      MEMBERSHIP_USER_MESSAGE
    );
  });

  it('throws rather than emitting a user string that carries a digit', () => {
    // The runtime half of the promise: an interpolated count a year from now
    // fails loudly at the moment it happens.
    expect(() => assertDigitFreeMembershipMessage('at capacity: 50 of 50')).toThrow(
      MasterMembershipInputError
    );
    expect(() => assertDigitFreeMembershipMessage(MEMBERSHIP_USER_MESSAGE)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Lock keying and conflict detection
// ---------------------------------------------------------------------------

describe('masterMembershipLockKey', () => {
  it('is namespaced away from every other advisory lock in the repo', () => {
    // migrate.ts holds pg_advisory_lock(1); evm-nonce.ts and
    // copy-trade-lifecycle.ts hash their own text keys. A collision would
    // serialise unrelated work or, worse, fail to exclude what it must.
    expect(masterMembershipLockKey(MASTER)).toContain('master-membership');
  });

  it('keys on the master alone, so two masters never contend', () => {
    expect(masterMembershipLockKey(MASTER)).not.toBe(masterMembershipLockKey('solana:Other'));
  });

  it('uses the address verbatim, matching the column the unique index is keyed on', () => {
    // Re-normalising here could produce a key that differs from the
    // `wallet_address` value being written, and then two writers for the same
    // master would not exclude each other.
    expect(masterMembershipLockKey(`  ${MASTER}  `)).toBe(masterMembershipLockKey(MASTER));
    expect(masterMembershipLockKey(MASTER)).toContain(MASTER);
  });

  it('refuses an empty address rather than locking a shared key', () => {
    expect(() => masterMembershipLockKey('   ')).toThrow(MasterMembershipInputError);
  });
});

describe('isMembershipSlotConflict', () => {
  it('matches only a unique violation on the slot index', () => {
    expect(isMembershipSlotConflict({ code: '23505', constraint: MEMBERSHIP_SLOT_INDEX })).toBe(
      true
    );
  });

  it('does not mistake the primary key for a slot collision', () => {
    // `(user_id, wallet_address)` raises the same 23505 and means "already
    // subscribed", which is a completely different bug.
    expect(
      isMembershipSlotConflict({ code: '23505', constraint: 'user_wallet_subscriptions_pkey' })
    ).toBe(false);
    expect(isMembershipSlotConflict({ code: '23514' })).toBe(false);
    expect(isMembershipSlotConflict(null)).toBe(false);
    expect(isMembershipSlotConflict(new Error('boom'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The subscribe path
// ---------------------------------------------------------------------------

interface Stub {
  match: RegExp;
  rows?: Record<string, unknown>[];
}

function statements(): string[] {
  return mocks.clientQuery.mock.calls.map((call) => String(call[0]));
}

function updates(): string[] {
  return statements().filter((text) => /^\s*UPDATE/i.test(text));
}

function inserts(): string[] {
  return statements().filter((text) => /^\s*INSERT INTO user_wallet_subscriptions/i.test(text));
}

function valuesFor(pattern: RegExp): unknown[] {
  const call = mocks.clientQuery.mock.calls.find((entry) => pattern.test(String(entry[0])));
  return (call?.[1] as unknown[] | undefined) ?? [];
}

function routeClient(stubs: Stub[]): void {
  mocks.clientQuery.mockImplementation(async (text: string) => {
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(text)) return { rows: [] };
    const hit = stubs.find((stub) => stub.match.test(text));
    if (!hit) throw new Error(`unstubbed statement: ${text}`);
    return { rows: hit.rows ?? [] };
  });
}

function subscriptionRow(
  state: SubscriptionState,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    wallet_address: MASTER,
    label: null,
    source: 'manual',
    created_at: new Date('2026-01-01T00:00:00Z'),
    state,
    active_since: new Date('2026-01-01T00:00:00Z'),
    wound_down_at: state === 'active' ? null : new Date('2026-06-01T00:00:00Z'),
    ended_at: state === 'ended' ? new Date('2026-07-01T00:00:00Z') : null,
    close_all_requested_at: null,
    membership_slot: state === 'active' ? 1 : null,
    membership_grandfathered: false,
    ...overrides
  };
}

/** One row per held ordinal, as `fetchMasterMembershipOccupancy` reads them. */
function occupancyRows(slots: number[], grandfathered = 0): Record<string, unknown>[] {
  return [
    ...slots.map((slot) => ({ membership_slot: slot, membership_grandfathered: false })),
    ...Array.from({ length: grandfathered }, () => ({
      membership_slot: null,
      membership_grandfathered: true
    }))
  ];
}

const subscribeInput = {
  walletAddress: MASTER,
  chain: 'solana' as const,
  tier: 'operator' as const,
  tierExpiresAt: null
};

beforeEach(() => {
  mocks.query.mockReset();
  mocks.clientQuery.mockReset();
});

describe('subscribeToWallet — membership enforcement', () => {
  it('serialises allocation on a per-master advisory lock before reading occupancy', () => {
    // The lock is what stops two racers picking the same ordinal. The
    // constraint is what stops a 51st member existing; this asserts the
    // liveness half, which is the half that lives in TypeScript.
    routeClient([
      { match: /FOR UPDATE/, rows: [{ id: scope.userId }] },
      { match: /COUNT\(\*\)/, rows: [{ count: '0' }] },
      { match: /SELECT wallet_address/, rows: [] },
      { match: /pg_advisory_xact_lock/, rows: [] },
      { match: /SELECT membership_slot/, rows: occupancyRows([1, 2]) },
      { match: /INSERT INTO wallets/, rows: [{ address: MASTER }] },
      { match: /INSERT INTO user_wallet_subscriptions/, rows: [subscriptionRow('active')] }
    ]);

    return subscribeToWallet(scope, subscribeInput).then(() => {
      const lockAt = statements().findIndex((text) => /pg_advisory_xact_lock/.test(text));
      const readAt = statements().findIndex((text) => /SELECT membership_slot/.test(text));
      const writeAt = statements().findIndex((text) =>
        /INSERT INTO user_wallet_subscriptions/.test(text)
      );
      expect(lockAt).toBeGreaterThan(-1);
      expect(lockAt).toBeLessThan(readAt);
      expect(readAt).toBeLessThan(writeAt);
      // Transaction-scoped, so the lock is still held when the ordinal is
      // consumed and is released by the COMMIT rather than by a separate call.
      expect(statements().at(-1)).toMatch(/^COMMIT/);
    });
  });

  it('writes the granted ordinal on a first-time join', async () => {
    routeClient([
      { match: /FOR UPDATE/, rows: [{ id: scope.userId }] },
      { match: /COUNT\(\*\)/, rows: [{ count: '0' }] },
      { match: /SELECT wallet_address/, rows: [] },
      { match: /pg_advisory_xact_lock/, rows: [] },
      { match: /SELECT membership_slot/, rows: occupancyRows([1, 3]) },
      { match: /INSERT INTO wallets/, rows: [{ address: MASTER }] },
      { match: /INSERT INTO user_wallet_subscriptions/, rows: [subscriptionRow('active')] }
    ]);

    await subscribeToWallet(scope, subscribeInput);

    expect(inserts()[0]).toContain('membership_slot');
    expect(valuesFor(/INSERT INTO user_wallet_subscriptions/)).toContain(2);
  });

  it('counts only active rows as holding an ordinal', async () => {
    routeClient([
      { match: /FOR UPDATE/, rows: [{ id: scope.userId }] },
      { match: /COUNT\(\*\)/, rows: [{ count: '0' }] },
      { match: /SELECT wallet_address/, rows: [] },
      { match: /pg_advisory_xact_lock/, rows: [] },
      { match: /SELECT membership_slot/, rows: occupancyRows([1]) },
      { match: /INSERT INTO wallets/, rows: [{ address: MASTER }] },
      { match: /INSERT INTO user_wallet_subscriptions/, rows: [subscriptionRow('active')] }
    ]);

    await subscribeToWallet(scope, subscribeInput);

    // PostgreSQL applies the filter, so the SQL is what there is to assert.
    // Without it, every leaver would keep a slot and the cap would under-serve.
    const read = statements().find((text) => /SELECT membership_slot/.test(text));
    expect(read).toContain("state = 'active'");
  });

  it('refuses a first-time join when every ordinal is held', async () => {
    routeClient([
      { match: /FOR UPDATE/, rows: [{ id: scope.userId }] },
      { match: /COUNT\(\*\)/, rows: [{ count: '0' }] },
      { match: /SELECT wallet_address/, rows: [] },
      { match: /pg_advisory_xact_lock/, rows: [] },
      {
        match: /SELECT membership_slot/,
        rows: occupancyRows(Array.from({ length: MASTER_MEMBERSHIP_CAP }, (_u, i) => i + 1))
      },
      { match: /INSERT INTO wallets/, rows: [{ address: MASTER }] }
    ]);

    await expect(subscribeToWallet(scope, subscribeInput)).rejects.toBeInstanceOf(
      MasterMembershipFullError
    );
    expect(inserts()).toEqual([]);
  });

  it('refuses a re-subscribe whose slot was taken while they were away (S4-M44)', async () => {
    routeClient([
      { match: /FOR UPDATE/, rows: [{ id: scope.userId }] },
      { match: /COUNT\(\*\)/, rows: [{ count: '0' }] },
      {
        match: /SELECT wallet_address/,
        rows: [subscriptionRow('ended', { membership_slot: null })]
      },
      { match: /pg_advisory_xact_lock/, rows: [] },
      {
        match: /SELECT membership_slot/,
        rows: occupancyRows(Array.from({ length: MASTER_MEMBERSHIP_CAP }, (_u, i) => i + 1))
      }
    ]);

    // The user was here first and is still refused: no grandfathering, no
    // waitlist. A slot held for an absent user makes the cap dishonest.
    await expect(subscribeToWallet(scope, subscribeInput)).rejects.toBeInstanceOf(
      MasterMembershipFullError
    );
    expect(updates()).toEqual([]);
  });

  it('refuses a winding-down user changing their mind into a full master', async () => {
    routeClient([
      { match: /FOR UPDATE/, rows: [{ id: scope.userId }] },
      {
        match: /SELECT wallet_address/,
        rows: [subscriptionRow('winding_down', { membership_slot: null })]
      },
      { match: /pg_advisory_xact_lock/, rows: [] },
      {
        match: /SELECT membership_slot/,
        rows: occupancyRows(Array.from({ length: MASTER_MEMBERSHIP_CAP }, (_u, i) => i + 1))
      }
    ]);

    // Their ordinal was released when they wound down. Exempting this path
    // would let a user hold a slot indefinitely by cycling the subscription.
    await expect(subscribeToWallet(scope, subscribeInput)).rejects.toBeInstanceOf(
      MasterMembershipFullError
    );
    expect(updates()).toEqual([]);
  });

  it('grants a fresh ordinal when reviving an ended subscription', async () => {
    routeClient([
      { match: /FOR UPDATE/, rows: [{ id: scope.userId }] },
      { match: /COUNT\(\*\)/, rows: [{ count: '0' }] },
      {
        match: /SELECT wallet_address/,
        rows: [subscriptionRow('ended', { membership_slot: null })]
      },
      { match: /pg_advisory_xact_lock/, rows: [] },
      { match: /SELECT membership_slot/, rows: occupancyRows([1, 2, 3]) },
      { match: /^\s*UPDATE/, rows: [subscriptionRow('active')] }
    ]);

    await subscribeToWallet(scope, subscribeInput);

    expect(updates()[0]).toContain('membership_slot = $5');
    expect(updates()[0]).toContain('membership_grandfathered = FALSE');
    expect(valuesFor(/^\s*UPDATE/)).toContain(4);
  });

  it('consumes no ordinal for an already-active subscription', async () => {
    routeClient([
      { match: /FOR UPDATE/, rows: [{ id: scope.userId }] },
      { match: /SELECT wallet_address/, rows: [subscriptionRow('active')] }
    ]);

    await subscribeToWallet(scope, subscribeInput);

    // No lock, no occupancy read, no write: an idempotent subscribe must not
    // burn a second slot, nor be refused once the master fills up.
    expect(statements().some((text) => /pg_advisory_xact_lock/.test(text))).toBe(false);
    expect(updates()).toEqual([]);
  });

  it('never exposes the ordinal to the caller (S4-M9)', async () => {
    routeClient([
      { match: /FOR UPDATE/, rows: [{ id: scope.userId }] },
      { match: /COUNT\(\*\)/, rows: [{ count: '0' }] },
      { match: /SELECT wallet_address/, rows: [] },
      { match: /pg_advisory_xact_lock/, rows: [] },
      { match: /SELECT membership_slot/, rows: occupancyRows([]) },
      { match: /INSERT INTO wallets/, rows: [{ address: MASTER }] },
      { match: /INSERT INTO user_wallet_subscriptions/, rows: [subscriptionRow('active')] }
    ]);

    const result = await subscribeToWallet(scope, subscribeInput);

    // An ordinal is a rank, and a rank is a headcount signal: "you are #37"
    // tells a user how many people are ahead of them behind one worker.
    expect(result.subscription).not.toHaveProperty('membershipSlot');
    expect(JSON.stringify(result.subscription)).not.toMatch(/slot/i);
    expect(JSON.stringify(result.subscription)).not.toMatch(/grandfather/i);
  });
});

// ---------------------------------------------------------------------------
// Migration 056
// ---------------------------------------------------------------------------

describe('migration 056', () => {
  const sqlPath = resolve(import.meta.dirname, '../sql/056_master_membership.sql');

  /** Comments talk about CREATE and ADD; only executable text is interesting. */
  async function executableSql(): Promise<string> {
    const raw = await readFile(sqlPath, 'utf8');
    return raw
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');
  }

  it('enforces the cap with a partial unique index, not a count', async () => {
    const sql = await executableSql();
    // A COUNT(*) check before an INSERT is exceeded by exactly the number of
    // concurrent racers, because every one of them reads the pre-insert count
    // at READ COMMITTED. Range plus uniqueness is a pigeonhole instead: only
    // `cap` ordinals exist and no two rows may share one.
    expect(sql).toContain(`CREATE UNIQUE INDEX IF NOT EXISTS ${MEMBERSHIP_SLOT_INDEX}`);
    expect(sql).toMatch(
      /ON user_wallet_subscriptions \(wallet_address, membership_slot\)\s+WHERE membership_slot IS NOT NULL/
    );
  });

  it('binds the ordinal range to MASTER_MEMBERSHIP_CAP', async () => {
    const sql = await executableSql();
    // Drift here is silent and asymmetric: a wider CHECK means the database
    // permits members the code refuses, a narrower one means writes the code
    // believes legal fail at runtime.
    expect(sql).toContain(`membership_slot <= ${MASTER_MEMBERSHIP_CAP}`);
    expect(sql).toContain(`generate_series(1, ${MASTER_MEMBERSHIP_CAP})`);
  });

  it('makes a leaver holding an ordinal unrepresentable', async () => {
    const sql = await executableSql();
    expect(sql).toContain('chk_uws_membership_slot_state');
    // The ELSE branch is the S4-M44 invariant: leaving `active` releases the
    // ordinal AND cannot carry a grandfathering exemption out of the state, so
    // a returning member must take a real ordinal or be refused.
    expect(sql).toMatch(/ELSE membership_slot IS NULL AND NOT membership_grandfathered/);
  });

  it('guards every constraint add on conkey shape rather than on a name', async () => {
    const sql = await executableSql();
    // `migrate.ts` has no applied-migrations table, so a bare ADD CONSTRAINT
    // breaks `pnpm db:migrate` on the second run. Shape rather than name
    // because PostgreSQL truncates identifiers at 63 bytes.
    const guards = sql.match(/IF NOT EXISTS \(\s*SELECT 1\s+FROM pg_constraint/g) ?? [];
    const adds = sql.match(/ADD CONSTRAINT/g) ?? [];
    expect(adds).toHaveLength(2);
    expect(guards).toHaveLength(adds.length);
    expect(sql).toMatch(/conkey @> \w+_shape/);
    expect(sql).toMatch(/conkey <@ \w+_shape/);
  });

  it('grandfathers an over-subscribed master instead of evicting anyone', async () => {
    const sql = await executableSql();
    // Evicting the excess does not close their positions — it strands exactly
    // the open positions whose exit path is the master's sell mirror.
    expect(sql).not.toMatch(/DELETE\s+FROM/i);
    expect(sql).toContain('SET membership_grandfathered = TRUE');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS membership_grandfathered');
    expect(sql).toMatch(/membership_grandfathered BOOLEAN NOT NULL DEFAULT FALSE/);
  });

  it('backfills only ordinals that are demonstrably free, so a replay cannot collide', async () => {
    const sql = await executableSql();
    // Re-deriving ordinals from a ROW_NUMBER() over current members would, after
    // any churn, try to hand an already-taken ordinal to a grandfathered row and
    // abort the migration.
    expect(sql).toMatch(/WHERE NOT EXISTS \(\s*SELECT 1\s+FROM user_wallet_subscriptions taken/);
    expect(sql).toContain('AND taken.membership_slot = candidate.slot');
    // And the stronger argument: once the CHECK exists these rows cannot exist,
    // so the backfill matches nothing on replay.
    expect(sql).toMatch(/AND membership_slot IS NULL\s+AND NOT membership_grandfathered/);
  });

  it('leaves transaction control to the migration runner', async () => {
    const raw = await readFile(sqlPath, 'utf8');
    expect(raw).not.toMatch(/^\s*BEGIN\s*;/im);
    expect(raw).not.toMatch(/^\s*COMMIT\s*;/im);
  });

  it('warns against exposing the ordinal in the column comment', async () => {
    const sql = await executableSql();
    // The next person to add a field to `WalletSubscription` reads this, not
    // the checklist.
    expect(sql).toMatch(/COMMENT ON COLUMN user_wallet_subscriptions\.membership_slot/);
    expect(sql).toContain('S4-M9');
  });
});
