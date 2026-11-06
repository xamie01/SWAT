import { capabilitiesFor, quotaExceeded } from '@swat/shared';
import { query } from './client.js';
import { claimMasterMembershipSlot, requireGrantedSlot } from './master-membership.js';
import { withTransaction } from './transaction.js';
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
export class QuotaExceededError extends Error {
    quota;
    limit;
    used;
    constructor(quota, limit, used) {
        super(`Quota exceeded: ${quota} (${used}/${limit})`);
        this.quota = quota;
        this.limit = limit;
        this.used = used;
        this.name = 'QuotaExceededError';
    }
}
export class WalletNotSubscribedError extends Error {
    constructor() {
        super('Wallet not subscribed');
        this.name = 'WalletNotSubscribedError';
    }
}
/**
 * Frozen rather than a `ReadonlySet`, following the `S4-M0` precedent in
 * `apps/signal-engine/src/trade-eligibility.ts`: `readonly` is a compile-time
 * claim only, and one stray `.add()` would widen the state machine
 * process-wide with no diff to review.
 */
export const SUBSCRIPTION_STATES = Object.freeze([
    'active',
    'winding_down',
    'ended'
]);
export function isSubscriptionState(value) {
    return typeof value === 'string' && SUBSCRIPTION_STATES.includes(value);
}
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
export function mirrorEligibilityForState(state) {
    switch (state) {
        case 'active':
            return 'buys-and-sells';
        case 'winding_down':
            return 'sells-only';
        default:
            return 'none';
    }
}
/**
 * Legal transitions, as data. `undefined` entries are the illegal ones and
 * carry the reason, so the refusal is explainable rather than a bare boolean.
 */
const TRANSITION_REFUSALS = Object.freeze({
    active: {},
    winding_down: {},
    // An `ended` subscription holds nothing to wind down — that is what `ended`
    // means. Allowing it would create a row claiming sells-only eligibility over
    // positions that are already closed, and the sell mirror would then look for
    // holdings that do not exist.
    ended: { winding_down: 'an ended subscription has no open position to wind down' }
});
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
export function evaluateSubscriptionTransition(from, to) {
    if (!isSubscriptionState(from)) {
        return { kind: 'illegal', from, to, reason: 'unrecognised current state' };
    }
    if (!isSubscriptionState(to)) {
        return { kind: 'illegal', from, to, reason: 'unrecognised target state' };
    }
    if (from === to) {
        return { kind: 'noop', state: from };
    }
    const refusal = TRANSITION_REFUSALS[from][to];
    if (refusal) {
        return { kind: 'illegal', from, to, reason: refusal };
    }
    return { kind: 'apply', from, to };
}
export class IllegalSubscriptionTransitionError extends Error {
    from;
    to;
    reason;
    constructor(from, to, reason) {
        super(`Illegal subscription transition ${String(from)} -> ${String(to)}: ${reason}`);
        this.from = from;
        this.to = to;
        this.reason = reason;
        this.name = 'IllegalSubscriptionTransitionError';
    }
}
/** Every column `toSubscription` needs, in one place so the reads cannot drift. */
const SUBSCRIPTION_COLUMNS = `wallet_address, label, source, created_at,
          state, active_since, wound_down_at, ended_at, close_all_requested_at`;
/**
 * The above plus the membership-slot columns (migration `056`).
 *
 * Kept separate rather than folded into `SUBSCRIPTION_COLUMNS` because a slot
 * ordinal is a **rank**, and a rank discloses the follower count `S4-M9`
 * forbids showing — "you are member #37" tells a user roughly how many people
 * are ahead of them and tells a master when farming their own followers pays.
 * `toSubscription` therefore has no field for it, and only the writers that
 * must allocate or release an ordinal select it.
 */
const SUBSCRIPTION_INTERNAL_COLUMNS = `${SUBSCRIPTION_COLUMNS},
          membership_slot, membership_grandfathered`;
function toSubscription(row) {
    return {
        walletAddress: row.wallet_address,
        label: row.label,
        source: row.source,
        createdAt: row.created_at,
        state: row.state,
        activeSince: row.active_since,
        woundDownAt: row.wound_down_at,
        endedAt: row.ended_at,
        closeAllRequestedAt: row.close_all_requested_at
    };
}
/**
 * The user's live subscriptions — `active` and `winding_down`.
 *
 * `ended` rows are excluded rather than deleted. They are retained so a closed
 * position stays attributable to the subscription that opened it, but they are
 * not something the user is tracking any more, so listing them would put dead
 * wallets in the dashboard and in `GET /v1/me/wallets`.
 */
export async function listWalletSubscriptions(scope) {
    const rows = await query(`SELECT ${SUBSCRIPTION_COLUMNS}
       FROM user_wallet_subscriptions
      WHERE user_id = $1 AND state <> 'ended'
      ORDER BY created_at DESC`, [scope.userId]);
    return rows.map(toSubscription);
}
/**
 * Whether the user still holds a live subscription to this wallet.
 *
 * `winding_down` counts: those users still have open positions being mirrored
 * out and marked to market, so the per-wallet endpoints this gates must keep
 * working for them. `ended` does not.
 */
export async function isSubscribed(scope, walletAddress) {
    const rows = await query(`SELECT 1 AS one FROM user_wallet_subscriptions
      WHERE user_id = $1 AND wallet_address = $2 AND state <> 'ended'`, [scope.userId, walletAddress]);
    return rows.length > 0;
}
/**
 * Serialises quota-consuming writes for one user.
 *
 * **A transaction alone does not enforce a quota.** `withTransaction` runs at
 * READ COMMITTED, so N concurrent `COUNT(*)` reads all observe the state before
 * any of them commits — every one sees `0 < 3` and every one inserts. A test
 * firing five concurrent subscribes against a 3-wallet tier granted all five.
 *
 * Locking the user's own row first serialises that user's quota writes without
 * touching anyone else's: different users take different locks and never contend.
 * `FOR UPDATE` on `users` is preferred over `SERIALIZABLE` because it needs no
 * retry loop, and over an advisory lock because the row already exists and the
 * lock is released by the transaction automatically.
 */
async function lockUserForQuota(client, userId) {
    await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
}
/**
 * Throws `QuotaExceededError` when the user is at their tracked-wallet limit.
 *
 * **`ended` rows do not count.** A subscription the user has finished with must
 * not occupy a tracked-wallet slot forever — those rows are retained for
 * attribution, and counting them would mean a free-tier user who ends three
 * subscriptions can never start another one.
 *
 * **`winding_down` rows DO count.** The platform is still indexing that wallet
 * and still mirroring exits against it, so the resource the quota bounds is
 * still being consumed. Excluding them would also make the quota trivially
 * bypassable: unsubscribe from each wallet in turn and track an unlimited
 * number of masters, all of them still receiving sell mirrors.
 *
 * Must be called with the user's row already locked (`lockUserForQuota`), or
 * concurrent callers all read the pre-insert count. See that function.
 */
async function assertTrackedWalletQuota(client, userId, limit) {
    const counted = await client.query(`SELECT COUNT(*)::text AS count FROM user_wallet_subscriptions
      WHERE user_id = $1 AND state <> 'ended'`, [userId]);
    const used = Number(counted.rows[0]?.count ?? '0');
    if (quotaExceeded(limit, used)) {
        throw new QuotaExceededError('trackedWallets', limit ?? 0, used);
    }
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
export async function subscribeToWallet(scope, input) {
    const capabilities = capabilitiesFor(input.tier, input.tierExpiresAt);
    return withTransaction(async (client) => {
        await lockUserForQuota(client, scope.userId);
        const existing = await client.query(`SELECT ${SUBSCRIPTION_INTERNAL_COLUMNS}
         FROM user_wallet_subscriptions
        WHERE user_id = $1 AND wallet_address = $2`, [scope.userId, input.walletAddress]);
        const current = existing.rows[0];
        // Already active: idempotent success, and it must not consume quota. Nor a
        // membership slot — the row already holds one (or is grandfathered), and
        // running the allocator here would refuse an existing member their own
        // wallet the moment the master filled up.
        if (current && current.state === 'active') {
            return {
                subscription: toSubscription(current),
                walletCreated: false,
                subscriptionCreated: false
            };
        }
        // A `winding_down` or `ended` row is a RE-SUBSCRIBE, not a duplicate. The
        // primary key `(user_id, wallet_address)` forbids a second row, so this
        // transition is the only representation a re-subscribe can have — and
        // returning "already subscribed" here instead would leave the user
        // permanently unable to restart a subscription they had ended.
        //
        // `active_since = NOW()` is what keeps this forward-only (S4-M2): the
        // master's trades during the wind-down or ended window are never caught up
        // on, no matter how long ago `created_at` was.
        if (current) {
            const verdict = evaluateSubscriptionTransition(current.state, 'active');
            if (verdict.kind === 'illegal') {
                throw new IllegalSubscriptionTransitionError(verdict.from, verdict.to, verdict.reason);
            }
            // Reviving an `ended` row consumes a slot, because `ended` rows are not
            // counted. Resuming a `winding_down` row does not — it is already counted.
            if (current.state === 'ended') {
                await assertTrackedWalletQuota(client, scope.userId, capabilities.trackedWallets);
            }
            // S4-M43 / S4-M44. Neither a `winding_down` nor an `ended` row holds a
            // membership ordinal — migration `056`'s CHECK makes that unrepresentable
            // — so re-entering `active` is an ordinary allocation and is refused when
            // the master is full. The slot the user used to hold is not reserved for
            // them: a reservation is a queue, and a queue holding a slot for an absent
            // user makes the cap dishonest.
            //
            // Note this also applies to `winding_down → active`, the "changed my mind"
            // path. It has to: the row released its ordinal when it wound down, and
            // exempting it would let a user hold a slot indefinitely by cycling.
            const membership = await claimMasterMembershipSlot(client, {
                masterWalletAddress: input.walletAddress,
                requester: {
                    priorState: current.state,
                    heldSlot: current.membership_slot ?? null
                }
            });
            const revived = await client.query(`UPDATE user_wallet_subscriptions
            SET state = 'active',
                active_since = NOW(),
                wound_down_at = NULL,
                ended_at = NULL,
                close_all_requested_at = NULL,
                membership_slot = $5,
                membership_grandfathered = FALSE,
                label = COALESCE($3, label),
                source = COALESCE($4, source)
          WHERE user_id = $1 AND wallet_address = $2
        RETURNING ${SUBSCRIPTION_COLUMNS}`, [
                scope.userId,
                input.walletAddress,
                input.label ?? null,
                input.source ?? null,
                requireGrantedSlot(membership)
            ]);
            return {
                subscription: toSubscription(revived.rows[0]),
                walletCreated: false,
                // Reviving an ended subscription starts a new lifecycle, so the
                // caller's 201 is honest. Resuming a wind-down is not a creation.
                subscriptionCreated: current.state === 'ended'
            };
        }
        await assertTrackedWalletQuota(client, scope.userId, capabilities.trackedWallets);
        const inserted = await client.query(`INSERT INTO wallets (address, chain, source, status)
       VALUES ($1, $2, 'manual', 'active')
       ON CONFLICT (address) DO NOTHING
       RETURNING address`, [input.walletAddress, input.chain]);
        const walletCreated = inserted.rows.length > 0;
        // S4-M43: a first-time join takes an ordinal or is refused. Placed after the
        // `wallets` upsert so the global wallet row exists for the foreign key, and
        // inside the same transaction as the INSERT below so the advisory lock the
        // allocator takes is still held when the ordinal is consumed.
        const membership = await claimMasterMembershipSlot(client, {
            masterWalletAddress: input.walletAddress,
            requester: { priorState: null, heldSlot: null }
        });
        const subscription = await client.query(`INSERT INTO user_wallet_subscriptions
              (user_id, wallet_address, label, source, membership_slot)
       VALUES ($1, $2, $3, COALESCE($4, 'manual'), $5)
       RETURNING ${SUBSCRIPTION_COLUMNS}`, [
            scope.userId,
            input.walletAddress,
            input.label ?? null,
            input.source ?? null,
            requireGrantedSlot(membership)
        ]);
        return {
            subscription: toSubscription(subscription.rows[0]),
            walletCreated,
            subscriptionCreated: true
        };
    });
}
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
export async function unsubscribeFromWallet(scope, walletAddress) {
    const rows = await query(`DELETE FROM user_wallet_subscriptions
      WHERE user_id = $1 AND wallet_address = $2
      RETURNING wallet_address`, [scope.userId, walletAddress]);
    return rows.length > 0;
}
/** The full lifecycle row, including `ended` — unlike `listWalletSubscriptions`. */
export async function getSubscriptionState(scope, walletAddress) {
    const rows = await query(`SELECT ${SUBSCRIPTION_COLUMNS}
       FROM user_wallet_subscriptions
      WHERE user_id = $1 AND wallet_address = $2`, [scope.userId, walletAddress]);
    return rows[0] ? toSubscription(rows[0]) : null;
}
/**
 * Applies one lifecycle transition, refusing anything
 * `evaluateSubscriptionTransition` calls illegal.
 *
 * `FOR UPDATE` on the subscription row, not on the user row: this consumes no
 * quota, and two concurrent transitions of the *same* subscription are the race
 * that matters — an unsubscribe and a "last position closed" sweep arriving
 * together must not both read `active` and produce a row whose timestamps
 * disagree with its state. Locking the subscription rather than the user also
 * keeps a wind-down from serialising behind that user's unrelated subscribes.
 *
 * Entry into `active` is deliberately NOT reachable here — it consumes
 * tracked-wallet quota, so it lives in `subscribeToWallet`.
 */
async function applyTransition(scope, walletAddress, to) {
    return withTransaction(async (client) => {
        const locked = await client.query(`SELECT ${SUBSCRIPTION_COLUMNS}
         FROM user_wallet_subscriptions
        WHERE user_id = $1 AND wallet_address = $2
        FOR UPDATE`, [scope.userId, walletAddress]);
        const current = locked.rows[0];
        if (!current)
            throw new WalletNotSubscribedError();
        const verdict = evaluateSubscriptionTransition(current.state, to);
        if (verdict.kind === 'illegal') {
            throw new IllegalSubscriptionTransitionError(verdict.from, verdict.to, verdict.reason);
        }
        if (verdict.kind === 'noop') {
            return { subscription: toSubscription(current), changed: false };
        }
        // One statement per target rather than a single clever one, so each write
        // visibly satisfies `chk_subscription_state_stamps` from migration 051.
        //
        // `wound_down_at` is COALESCEd rather than overwritten on the way into
        // `winding_down` so that a subscription which was wound down, revived and
        // wound down again... cannot in fact reach that branch — entry into
        // `active` NULLs it. The COALESCE is defence against a future writer that
        // forgets, not dead code: silently resetting the clock would hide a
        // wind-down that has been stuck for weeks (S4-M17).
        //
        // Entering `ended` deliberately preserves `wound_down_at`, because
        // "how long did this take to close" is the operational question, and
        // leaves it NULL on the direct `active → ended` path, which is why the
        // migration's CHECK does not require it for `ended`.
        //
        // Both branches release the membership ordinal (S4-M43/S4-M44, migration
        // `056`). A leaver must not hold a slot: they are no longer receiving
        // entries, so holding one would make the cap under-serve the master by
        // exactly the number of people on their way out. They **do** keep receiving
        // sell mirrors, because that is derived from `state` alone — nothing on the
        // fan-out path reads `membership_slot`, so releasing the slot cannot strand
        // their open positions. `membership_grandfathered` is cleared for the same
        // reason: `056`'s CHECK forbids a non-active row carrying the exemption, and
        // clearing it here is what makes re-subscribe take a real ordinal or be
        // refused.
        const updated = to === 'winding_down'
            ? await client.query(`UPDATE user_wallet_subscriptions
                SET state = 'winding_down',
                    wound_down_at = COALESCE(wound_down_at, NOW()),
                    membership_slot = NULL,
                    membership_grandfathered = FALSE
              WHERE user_id = $1 AND wallet_address = $2
            RETURNING ${SUBSCRIPTION_COLUMNS}`, [scope.userId, walletAddress])
            : await client.query(`UPDATE user_wallet_subscriptions
                SET state = 'ended',
                    ended_at = NOW(),
                    membership_slot = NULL,
                    membership_grandfathered = FALSE
              WHERE user_id = $1 AND wallet_address = $2
            RETURNING ${SUBSCRIPTION_COLUMNS}`, [scope.userId, walletAddress]);
        return { subscription: toSubscription(updated.rows[0]), changed: true };
    });
}
/**
 * Unsubscribe, ADR-0005 §3.7 semantics: **stop entries immediately, keep
 * honouring the master's sells** until each open position closes.
 *
 * Idempotent — a double-clicked unsubscribe returns `changed: false` rather
 * than throwing, and does not move `wound_down_at`.
 */
export async function beginWindDown(scope, walletAddress) {
    return applyTransition(scope, walletAddress, 'winding_down');
}
/**
 * Mirroring is over: the last position opened under this subscription has
 * closed, or the unsubscribe found nothing open at all.
 *
 * Reachable from `winding_down` (the normal path) and directly from `active`
 * (nothing was ever opened). The row is retained, not deleted, so a closed
 * position stays attributable to the subscription that opened it.
 */
export async function endSubscription(scope, walletAddress) {
    return applyTransition(scope, walletAddress, 'ended');
}
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
export async function requestCloseAll(scope, walletAddress) {
    return withTransaction(async (client) => {
        const locked = await client.query(`SELECT ${SUBSCRIPTION_COLUMNS}
         FROM user_wallet_subscriptions
        WHERE user_id = $1 AND wallet_address = $2
        FOR UPDATE`, [scope.userId, walletAddress]);
        const current = locked.rows[0];
        if (!current)
            throw new WalletNotSubscribedError();
        // Routed through the same state machine so "close all" can never reach a
        // state ordinary wind-down could not. From `active` this is `apply`; from
        // `winding_down` it is `noop` and only the stamp changes; from `ended` —
        // or any state this build does not recognise — it is illegal.
        const verdict = evaluateSubscriptionTransition(current.state, 'winding_down');
        if (verdict.kind === 'illegal') {
            throw new IllegalSubscriptionTransitionError(verdict.from, verdict.to, verdict.reason);
        }
        // Already winding down AND already requested: nothing to write. Keeps the
        // invariant that a no-op transition issues no UPDATE, and avoids a pointless
        // row version on every repeated click.
        if (verdict.kind === 'noop' && current.close_all_requested_at !== null) {
            return { subscription: toSubscription(current), changed: false };
        }
        const updated = await client.query(`UPDATE user_wallet_subscriptions
          SET state = 'winding_down',
              wound_down_at = COALESCE(wound_down_at, NOW()),
              close_all_requested_at = COALESCE(close_all_requested_at, NOW()),
              membership_slot = NULL,
              membership_grandfathered = FALSE
        WHERE user_id = $1 AND wallet_address = $2
      RETURNING ${SUBSCRIPTION_COLUMNS}`, [scope.userId, walletAddress]);
        return { subscription: toSubscription(updated.rows[0]), changed: true };
    });
}
function toWatch(row) {
    return {
        id: row.id,
        chain: row.chain,
        tokenMint: row.token_mint,
        status: row.status,
        createdAt: row.created_at
    };
}
export async function listTokenWatches(scope) {
    const rows = await query(`SELECT id, chain, token_mint, status, created_at
       FROM user_token_watches
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 100`, [scope.userId]);
    return rows.map(toWatch);
}
/**
 * Starts a token backfill, subject to the rolling-24h quota.
 *
 * Re-requesting a token already watched returns the existing row and consumes no
 * quota — otherwise a user could exhaust their day by double-clicking.
 */
export async function requestTokenWatch(scope, input) {
    const capabilities = capabilitiesFor(input.tier, input.tierExpiresAt);
    return withTransaction(async (client) => {
        // Same serialisation as the wallet quota — see `lockUserForQuota`.
        await lockUserForQuota(client, scope.userId);
        const existing = await client.query(`SELECT id, chain, token_mint, status, created_at
         FROM user_token_watches
        WHERE user_id = $1 AND chain = $2 AND token_mint = $3`, [scope.userId, input.chain, input.tokenMint]);
        if (existing.rows[0]) {
            return { watch: toWatch(existing.rows[0]), created: false };
        }
        // Rolling 24h, not calendar-day: a calendar reset lets a user spend two days'
        // quota in a few minutes across midnight.
        const counted = await client.query(`SELECT COUNT(*)::text AS count FROM user_token_watches
        WHERE user_id = $1 AND created_at > NOW() - INTERVAL '24 hours'`, [scope.userId]);
        const used = Number(counted.rows[0]?.count ?? '0');
        if (quotaExceeded(capabilities.tokenBackfillsPerDay, used)) {
            throw new QuotaExceededError('tokenBackfillsPerDay', capabilities.tokenBackfillsPerDay ?? 0, used);
        }
        const inserted = await client.query(`INSERT INTO user_token_watches (user_id, chain, token_mint)
       VALUES ($1, $2, $3)
       RETURNING id, chain, token_mint, status, created_at`, [scope.userId, input.chain, input.tokenMint]);
        return { watch: toWatch(inserted.rows[0]), created: true };
    });
}
//# sourceMappingURL=subscriptions.js.map