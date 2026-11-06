/**
 * Master **membership** cap — how many users may be copying one master at all
 * (`S4-M43`), and what happens to a copier who leaves and comes back
 * (`S4-M44`). Migration `056`.
 *
 * ── Two caps, and this is the second one ──────────────────────────────────
 *
 * `master-capacity.ts` caps **one signal's fan-out**: how much cohort notional
 * may hit one pair in one window. This file caps **standing membership**: how
 * many users may hold a live subscription to one master at all. They answer
 * different questions and both are needed — a master with 5000 members whose
 * fan-out is impact-capped serves 50 people per signal and lies to the other
 * 4950 about what they bought.
 *
 * ── Why 50, and why the same 50 ───────────────────────────────────────────
 *
 * The operator originally asked for 500 and withdrew it once the throughput
 * arithmetic was shown. One concurrency-1 worker per chain at ~6s/order drains
 * roughly **50 orders per 5-minute window** — the same derivation behind
 * `DEFAULT_FOLLOWER_SOFT_CAP`. 500 copiers on one signal would take ~50 minutes
 * to clear, and everyone past roughly #50 fills at a materially worse price
 * than the master they are paying to copy.
 *
 * So membership is set **equal to** the per-signal cap. That equality is the
 * whole point: it is what makes the product promise honest, because every
 * member can actually be served inside one window. A test asserts the two
 * constants have not drifted apart.
 *
 * **This bounds the thundering herd; it does not remove it.** 50 users copying
 * one signal still queue behind one worker. The real defence on fill quality is
 * the aggregate price-impact check in `master-capacity.ts`. Reading "cap = 50"
 * as "herd solved" is the wrong model.
 *
 * ── The refusal discloses nothing (`S4-M9`) ───────────────────────────────
 *
 * `S4-M9` is a standing constraint against ever showing follower counts or
 * popularity, because a count is a crowding signal: it tells a master exactly
 * when farming their own followers pays, and it tells a user when to front-run
 * the cohort. So the refusal a user sees carries **no digits**, does not say
 * "full", and — critically — **does not vary by cause**. Differing wording is
 * itself a distinguishable signal: "cap reached" vs "your old slot is gone"
 * would let a caller probe the backend's state by reading the copy.
 *
 * The split is the one `MasterCapacityDecision` already established rather than
 * a second invention: `user.message` is the frozen generic string, `internal`
 * carries the real code, the cap and the counts, and is nested under a name
 * that makes rendering it to a user obvious in review.
 *
 * ── Pure decision, thin SQL ───────────────────────────────────────────────
 *
 * `decideMasterMembership` is a pure function over explicit inputs, following
 * `stop-loss.ts` / `position-cap.ts` / `fanout-eligibility.ts`. Not tidiness:
 * a rule expressed in SQL cannot be unit-tested, and this rule decides whether
 * a user may put money behind a master.
 *
 * ── Enforcement is a constraint, not a read-then-write ────────────────────
 *
 * `COUNT(*) < 50` followed by an INSERT is exceeded by exactly the number of
 * concurrent racers: at READ COMMITTED every racer reads the pre-insert count.
 * So the cap is enforced structurally by migration `056`:
 *
 *   * `membership_slot SMALLINT` constrained to `[1, MASTER_MEMBERSHIP_CAP]`,
 *   * a **partial unique index** on `(wallet_address, membership_slot)`,
 *   * a coherence CHECK making a slot-holding non-active row unrepresentable.
 *
 * Range plus uniqueness is a pigeonhole: there are only 50 ordinals a master
 * can hand out, so no writer — this code, a future service, or a hand-typed
 * INSERT — can produce a 51st slot-holder. `claimMasterMembershipSlot` also
 * takes a per-master transaction advisory lock, but that is for **liveness**
 * (it stops two racers picking the same ordinal and one of them eating a unique
 * violation); the constraint, not the lock, is what makes the cap true.
 *
 * ── Winding down does not hold a slot, but still receives sells ───────────
 *
 * A `winding_down` user is leaving and must **not** occupy a slot. They still
 * hold open positions and still need the master's sells mirrored, so they must
 * still be enumerated by `fanout-eligibility.ts` — which keys on
 * `mirrorEligibilityForState(state)` and never looks at `membership_slot`, so
 * the two facts cannot be conflated. Count them and the cap under-serves; drop
 * them from enumeration and their positions strand.
 *
 * ── S4-M44: a dropped copier does not get their slot back ─────────────────
 *
 * Leaving `active` releases the ordinal, and re-subscribing takes a fresh one
 * or is refused. No reservation, no waitlist: a slot held for an absent user
 * makes the cap dishonest, because the master then shows 50 members of whom
 * some cannot trade, and it rewards churning a subscription to hold position.
 * The cost is real — a user who lapses may not get back in — and belongs in the
 * unsubscribe confirmation copy rather than being discovered afterwards.
 */
// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════
/**
 * Members one master may have at once.
 *
 * Deliberately a **separate constant** from `DEFAULT_FOLLOWER_SOFT_CAP` rather
 * than an alias of it, even though the two are equal today. Aliasing would make
 * them one knob, so tuning the per-signal soft cap would silently move the
 * subscribe-time cap with it. A test asserts the equality instead, which is
 * where a deliberate divergence would have to be recorded.
 */
export const MASTER_MEMBERSHIP_CAP = 50;
/**
 * The one string a user ever sees when membership is refused, for every cause.
 *
 * No digits, no "full", no "50", and identical for every cause — see the
 * `S4-M9` note in the file header. The wording is also not false: we genuinely
 * are not accepting new copiers for this master.
 */
export const MEMBERSHIP_USER_MESSAGE = 'This master is not accepting new copiers.';
/**
 * Name of the partial unique index from migration `056`.
 *
 * Exported because it is the only reliable way to tell "two racers picked the
 * same ordinal" apart from any other unique violation on this table — the
 * primary key `(user_id, wallet_address)` also raises `23505`.
 */
export const MEMBERSHIP_SLOT_INDEX = 'unq_uws_membership_slot';
// ═══════════════════════════════════════════════════════════════════════════
// Errors
// ═══════════════════════════════════════════════════════════════════════════
/** Structurally impossible input. Loud, because the CHECK forbids it in the DB. */
export class MasterMembershipInputError extends Error {
    constructor(message) {
        super(message);
        this.name = 'MasterMembershipInputError';
    }
}
/**
 * The master is not accepting this user.
 *
 * **`message` is the digit-free user string, not a diagnostic.** Fastify error
 * handlers routinely echo `error.message`, so putting the cap or the count here
 * would leak exactly what `S4-M9` forbids through a path nobody reviews. The
 * real code and the figures are on `decision.internal`, which is where ops
 * logging reads them from.
 */
export class MasterMembershipFullError extends Error {
    decision;
    constructor(decision) {
        super(MEMBERSHIP_USER_MESSAGE);
        this.decision = decision;
        this.name = 'MasterMembershipFullError';
    }
}
/**
 * A slot ordinal collided despite the advisory lock.
 *
 * Not reachable from `subscribeToWallet`, which serialises allocation per
 * master. It means some other writer allocated an ordinal without taking the
 * lock. Surfaced with the same digit-free user message so the user sees a
 * refusal rather than a 500, and with a `detail` that names the real cause so
 * the bug is not hidden.
 */
export class MembershipSlotConflictError extends Error {
    detail;
    constructor(detail) {
        super(MEMBERSHIP_USER_MESSAGE);
        this.detail = detail;
        this.name = 'MembershipSlotConflictError';
    }
}
/**
 * Throws if a string bound for a user carries a digit.
 *
 * The runtime half of the `S4-M9` promise. The type system cannot stop somebody
 * interpolating a count into the refusal a year from now; this turns that edit
 * into a loud failure at the moment it happens instead of a quiet leak.
 */
export function assertDigitFreeMembershipMessage(message) {
    if (/\d/.test(message)) {
        throw new MasterMembershipInputError('A membership message bound for a user contains a digit (S4-M9): refusals must '
            + 'disclose no count, cap or ordinal');
    }
}
/**
 * Lowest unoccupied ordinal in `[1, cap]`, or `null` when the master is full.
 *
 * Lowest-first rather than "next after the highest": ordinals must stay compact
 * so that the range CHECK is the binding constraint, and a monotonic counter
 * would exhaust `[1, cap]` after `cap` joins regardless of how many had left.
 */
export function lowestFreeMembershipSlot(occupiedSlots, cap = MASTER_MEMBERSHIP_CAP) {
    const taken = new Set(occupiedSlots);
    for (let slot = 1; slot <= cap; slot += 1) {
        if (!taken.has(slot))
            return slot;
    }
    return null;
}
function refusal(code, detail, base) {
    // Routed through one function so no cause can acquire its own wording. The
    // guard runs on every refusal rather than once at module load, because the
    // leak this protects against is an interpolated message, not a bad constant.
    assertDigitFreeMembershipMessage(MEMBERSHIP_USER_MESSAGE);
    return {
        outcome: 'refuse',
        reasonCode: code,
        slot: null,
        user: { message: MEMBERSHIP_USER_MESSAGE },
        internal: { ...base, code, detail }
    };
}
/**
 * Decides whether one user may hold membership of one master.
 *
 * The complete statement of the rule, including the already-a-member case that
 * `subscribeToWallet` short-circuits before ever calling this — the short
 * circuit is an optimisation, and the rule must not live only inside it.
 */
export function decideMasterMembership(input) {
    const cap = input.cap ?? MASTER_MEMBERSHIP_CAP;
    if (!Number.isInteger(cap) || cap < 1) {
        throw new MasterMembershipInputError(`Membership cap must be a positive integer, got ${cap}`);
    }
    if (!input.masterWalletAddress) {
        throw new MasterMembershipInputError('decideMasterMembership requires a master wallet address');
    }
    const priorState = input.requester.priorState;
    const requesterPriorState = priorState === null || priorState === undefined
        ? null
        : String(priorState);
    const reSubscribe = requesterPriorState !== null;
    const heldSlot = input.requester.heldSlot;
    if (heldSlot !== null && priorState !== 'active') {
        // Migration 056's coherence CHECK makes this row unrepresentable, so seeing
        // it means the constraint is missing or a writer bypassed it. Guessing here
        // would either strand the ordinal or hand out a duplicate.
        throw new MasterMembershipInputError(`A non-active subscription holds membership slot ${heldSlot} (state ${requesterPriorState}): `
            + 'migration 056 forbids this row');
    }
    const base = {
        code: 'membership-slot-granted',
        detail: '',
        masterWalletAddress: input.masterWalletAddress,
        cap,
        occupiedSlotCount: input.occupancy ? input.occupancy.occupiedSlots.length : null,
        grandfatheredActiveCount: input.occupancy ? input.occupancy.grandfatheredActiveCount : null,
        requesterPriorState,
        reSubscribe
    };
    // Already a member: idempotent, and consumes nothing. Checked before
    // occupancy so a read failure cannot revoke an existing membership — the
    // fail-closed rule protects new joins, not people already in.
    if (priorState === 'active') {
        return {
            outcome: 'admit',
            reasonCode: 'membership-already-active',
            slot: heldSlot,
            user: { message: null },
            internal: {
                ...base,
                code: 'membership-already-active',
                detail: heldSlot === null
                    ? 'already an active member, grandfathered without an ordinal'
                    : `already an active member holding slot ${heldSlot}`
            }
        };
    }
    if (!input.occupancy) {
        return refusal('membership-occupancy-unknown', 'membership occupancy could not be read; refusing rather than admitting blind', base);
    }
    for (const slot of input.occupancy.occupiedSlots) {
        if (!Number.isInteger(slot) || slot < 1) {
            throw new MasterMembershipInputError(`Occupied membership slots must be positive integers, got ${String(slot)}`);
        }
    }
    if (new Set(input.occupancy.occupiedSlots).size !== input.occupancy.occupiedSlots.length) {
        // The partial unique index makes duplicates impossible. If they arrive, the
        // index is gone and the cap is no longer enforced — fail loudly.
        throw new MasterMembershipInputError(`Duplicate membership slots for ${input.masterWalletAddress}: the ${MEMBERSHIP_SLOT_INDEX} `
            + 'unique index is missing');
    }
    if (!Number.isInteger(input.occupancy.grandfatheredActiveCount)
        || input.occupancy.grandfatheredActiveCount < 0) {
        throw new MasterMembershipInputError('grandfatheredActiveCount must be a non-negative integer, got '
            + String(input.occupancy.grandfatheredActiveCount));
    }
    const slot = lowestFreeMembershipSlot(input.occupancy.occupiedSlots, cap);
    if (slot === null) {
        // Two codes, one message. `S4-M44` is the second: the slot this user used to
        // hold has been taken by somebody else and is not theirs to reclaim.
        return reSubscribe
            ? refusal('membership-slot-not-reclaimable', `re-subscribe refused: all ${cap} slots for ${input.masterWalletAddress} are held and a `
                + 'released slot is not reserved (S4-M44)', base)
            : refusal('membership-cap-reached', `all ${cap} membership slots for ${input.masterWalletAddress} are held`, base);
    }
    return {
        outcome: 'admit',
        reasonCode: 'membership-slot-granted',
        slot,
        user: { message: null },
        internal: {
            ...base,
            code: 'membership-slot-granted',
            detail: `granted slot ${slot} of ${cap}`
        }
    };
}
/**
 * Advisory-lock key for one master's slot allocation.
 *
 * Pure and exported so the keying rules are testable without a database, the
 * same reason `evmNonceLockKey` is. Keyed on the master alone: allocation for
 * two different masters never contends, and the `master-membership` namespace
 * keeps these keys away from `migrate.ts`'s `pg_advisory_lock(1)`, the
 * `evm-nonce:` locks and the copy-position locks in `copy-trade-lifecycle.ts`.
 *
 * The address is used verbatim. It is already chain-prefixed and already
 * normalised by `resolveChainAddress` upstream, and normalising again here
 * would risk producing a different key from the `wallet_address` the unique
 * index is keyed on.
 */
export function masterMembershipLockKey(masterWalletAddress) {
    const address = masterWalletAddress.trim();
    if (!address) {
        throw new MasterMembershipInputError('masterMembershipLockKey requires a wallet address');
    }
    return JSON.stringify(['master-membership', address]);
}
/**
 * Reads one master's live slot occupancy.
 *
 * Filtered to `state = 'active'` so a `winding_down` or `ended` row can never
 * be counted as occupying a slot. That filter is belt-and-braces: migration
 * `056`'s coherence CHECK already makes a non-active row with a non-null
 * `membership_slot` unrepresentable, so the two mechanisms have to fail
 * together for a leaver to hold a slot.
 *
 * Served by `idx_uws_wallet_live (wallet_address, state) WHERE state <> 'ended'`
 * from migration `051`; the row count per master is bounded by the cap plus
 * whatever `056` grandfathered, so no new index is warranted.
 */
export async function fetchMasterMembershipOccupancy(client, masterWalletAddress) {
    const rows = await client.query(`SELECT membership_slot, membership_grandfathered
       FROM user_wallet_subscriptions
      WHERE wallet_address = $1 AND state = 'active'`, [masterWalletAddress]);
    const occupiedSlots = [];
    let grandfatheredActiveCount = 0;
    for (const row of rows.rows) {
        if (row.membership_slot === null) {
            if (row.membership_grandfathered)
                grandfatheredActiveCount += 1;
            continue;
        }
        occupiedSlots.push(Number(row.membership_slot));
    }
    return { occupiedSlots, grandfatheredActiveCount };
}
/**
 * Allocates a membership slot for one user on one master, or refuses.
 *
 * Must be called inside a transaction: the advisory lock is transaction-scoped,
 * so it is released exactly when the INSERT or UPDATE that consumes the ordinal
 * commits or rolls back. Taking it outside one would release the lock before
 * the row existed and hand the same ordinal to the next caller.
 *
 * **What makes this race-safe, in order of what is load-bearing:**
 *
 *  1. Migration `056`'s range CHECK plus partial unique index. Only 50 ordinals
 *     exist per master and no two rows may share one, so a 51st member is
 *     unrepresentable no matter who writes it or how many write at once. This
 *     holds even if the code below is deleted.
 *  2. `pg_advisory_xact_lock` on the master. Without it two concurrent
 *     transactions both read the same occupancy and both pick the same lowest
 *     free ordinal; the index would reject one of them, so the cap would still
 *     hold, but the loser would get a unique violation instead of a clean
 *     refusal or a different slot. The lock converts that into serialisation.
 *  3. The lock is keyed on the **master**, which is what `lockUserForQuota`
 *     cannot do — it locks the *user* row, so it serialises one user's writes
 *     and does nothing about 50 different users joining one master at once.
 *
 * Throws `MasterMembershipFullError` on a refusal, carrying the decision.
 */
export async function claimMasterMembershipSlot(client, params) {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        masterMembershipLockKey(params.masterWalletAddress)
    ]);
    const occupancy = await fetchMasterMembershipOccupancy(client, params.masterWalletAddress);
    const decision = decideMasterMembership({
        masterWalletAddress: params.masterWalletAddress,
        cap: params.cap,
        occupancy,
        requester: params.requester
    });
    if (decision.outcome === 'refuse')
        throw new MasterMembershipFullError(decision);
    return decision;
}
/**
 * The ordinal a caller is about to write, or a loud failure.
 *
 * An admit with a `null` slot is only ever `membership-already-active` on a
 * grandfathered row, and that caller has nothing to write. Reaching here with
 * one means the caller is about to write `NULL` into an active row's
 * `membership_slot`, which migration `056`'s CHECK would reject anyway — this
 * turns that into an error that names the cause.
 */
export function requireGrantedSlot(decision) {
    if (decision.slot === null) {
        throw new MasterMembershipInputError(`Membership decision ${decision.reasonCode} granted no slot to write`);
    }
    return decision.slot;
}
/**
 * True when an error is two racers colliding on one master's slot ordinal.
 *
 * Matched on the index name rather than on `23505` alone: this table's primary
 * key `(user_id, wallet_address)` raises the same code, and that one means
 * "already subscribed", which is a completely different bug.
 */
export function isMembershipSlotConflict(error) {
    if (typeof error !== 'object' || error === null)
        return false;
    const candidate = error;
    return candidate.code === '23505' && candidate.constraint === MEMBERSHIP_SLOT_INDEX;
}
//# sourceMappingURL=master-membership.js.map