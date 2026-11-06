import type { Chain } from '@swat/shared';
import type { FanoutCandidate } from './fanout-eligibility.js';
import { type UserScope } from './tenancy.js';
/**
 * The fetch half of fan-out enumeration (`S4-13`, closing the open half of it).
 *
 * `fanout-eligibility.ts` decides *who copies a signal*; this produces the
 * `FanoutCandidate[]` it decides over. The split is the whole point and it runs
 * one way only: **this module fetches, `planFanout` decides.** A condition
 * expressed here as a WHERE clause cannot be unit-tested without Postgres, and
 * there is no Postgres available on this branch — so every rule that could
 * plausibly be either a filter or a verdict lives in the pure module, and what
 * remains here is scoping.
 *
 * Three filters do appear in the SQL, and each is a *scope*, not a decision:
 *
 *   1. `wallet_address = $1` — the signal's master wallet. That is the join
 *      ADR-0005 specified: single-master mirroring keys on the source wallet of
 *      a `source_trade` signal, never on cluster membership.
 *   2. `state <> 'ended'` — an ended subscription mirrors nothing and its rows
 *      are retained **forever** for attribution (`051`), so without the
 *      predicate every mirror would enumerate the accumulated history of
 *      everyone who ever left this master. `idx_uws_wallet_live` is the partial
 *      index built for exactly this predicate. It is also double-covered:
 *      `mirrorEligibilityForState('ended')` is `'none'`, so a leaked row would
 *      still be excluded with `subscription-not-mirroring` rather than copied.
 *      `winding_down` is deliberately **enumerated** — those users mirror sells,
 *      and dropping them strands their open positions with no exit.
 *   3. `users.status = 'active'` — see the note on `accountStatus` below. This
 *      one is **not** double-covered, and that is a gap worth knowing about.
 *
 * **Membership slots are deliberately not consulted.** A `winding_down` row
 * holds no `membership_slot` (migration `056`'s CHECK makes that
 * unrepresentable) and still has to be enumerated. Keying enumeration on the
 * slot instead of on the state is how a leaver's positions get stranded, so this
 * module never reads `membership_slot` — the same rule `master-membership.ts`
 * states from the other side.
 */
/**
 * Account status is filtered in SQL, and here is why that is unsatisfying.
 *
 * A suspended or soft-deleted account must not copy a trade. The API enforces
 * that at the session layer (`apps/api/src/auth/plugin.ts`), but a fan-out has
 * no session, so the enumeration has to. `FanoutExclusionCode` has no member for
 * it, so `planFanout` *cannot* report it — which means a suspended user
 * disappears from the fan-out instead of appearing with a reason. That is the
 * silent-filter shape this codebase avoids everywhere else.
 *
 * Filtering is still the lesser evil: the alternative is enumerating a suspended
 * account and letting it trade. Overloading `killed` to carry it was rejected —
 * `killed` is the per-user kill switch (`S6-8`), and reporting `user-killed` for
 * a suspended account sends an operator to check a switch that is off.
 *
 * The real fix is an `account-not-active` exclusion code in
 * `fanout-eligibility.ts`, which this module does not own.
 */
export interface ListFanoutCandidatesInput {
    /** The signal's master wallet, chain-prefixed (`solana:ABC...`). */
    readonly masterWalletAddress: string;
    /**
     * The signal's chain, used to scope the balance read.
     *
     * Balances are read **per chain**, not summed across chains, because
     * `resolveKnownBalanceUsd` returns `null` if *any* row it is given is stale or
     * unpriced. Summed across chains, one stale Solana price would report every
     * user's Polymarket buying power as unknown and halt copying on a chain whose
     * own feed is healthy. Per chain, a feed outage is contained to the chain that
     * has it.
     */
    readonly chain: Chain;
    /** Injected so balance staleness is testable without waiting. */
    readonly now?: Date;
    /** Defaults to `BALANCE_MAX_STALENESS_MS`; passed straight to `resolveKnownBalanceUsd`. */
    readonly balanceMaxAgeMs?: number;
}
/**
 * Every live subscriber of one master wallet, with the inputs `planFanout` needs.
 *
 * Cross-tenant by nature — it spans users on behalf of a background service — so
 * it takes a `crossTenantScope(reason)` and refuses a per-user scope, following
 * `listStaleUserBalances`. The refusal matters: called with a real user's scope
 * it would silently enumerate one subscriber and look like a working fan-out.
 *
 * Two round trips rather than one, deliberately. The balance total is produced by
 * `resolveKnownBalanceUsd` in TypeScript because its rule — `null` on *any*
 * stale or unpriced row, never a partial sum — is a decision, and a `SUM()` in
 * SQL would either coalesce the unknowns away or need a hand-rolled staleness
 * predicate that no unit test could reach. One extra query is a cheap price for
 * keeping that rule in the one place it is already tested.
 */
export declare function listFanoutCandidates(scope: UserScope, input: ListFanoutCandidatesInput): Promise<FanoutCandidate[]>;
//# sourceMappingURL=fanout-candidates.d.ts.map