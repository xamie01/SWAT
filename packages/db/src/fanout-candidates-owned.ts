import type { Chain, UserTier } from '@swat/shared';
import { USER_TIERS } from '@swat/shared';
import type { PoolClient } from 'pg';
import { isChain, resolveChainValue } from '@swat/shared';
import type { FanoutCandidate } from './fanout-eligibility.js';
import {
  BALANCE_MAX_STALENESS_MS,
  resolveKnownBalanceUsd,
  type UserBalance
} from './user-balance-state.js';
import { DEFAULT_USER_EXECUTION_SETTINGS } from './user-execution-defaults.js';
import { toBalance, type BalanceRow } from './user-balance-state.js';

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

interface CandidateRow {
  user_id: string;
  active_since: Date | null;
  /**
   * Typed `unknown` on purpose, matching `FanoutCandidate.subscriptionState`.
   *
   * The column can carry a value written by a future migration, a manual UPDATE,
   * or a service on another release. Narrowing it here would be a claim this
   * module cannot make; `mirrorEligibilityForState` is the only place that reads
   * it, and it fails closed.
   */
  subscription_state: unknown;
  tier: string;
  tier_expires_at: Date | null;
  /** `null` for every column below when the user has no settings row. */
  auto_execute: boolean | null;
  killed: boolean | null;
  min_signal_score: number | null;
  max_concurrent_positions: number | null;
  open_position_count: string;
}

/**
 * An unrecognised tier reads as the **least** capable tier, not as a crash and
 * not as `ultra`.
 *
 * `capabilitiesFor` indexes `TIER_CAPABILITIES` directly, so an out-of-CHECK
 * value would produce `undefined` and throw inside `tierAllowsChain` — taking
 * the whole signal's fan-out down for one bad row. `'free'` is the same floor
 * `effectiveTier` already degrades an expired tier to, so this introduces no new
 * policy: it narrows to the smallest chain set rather than inventing one.
 */
function toTier(value: string): UserTier {
  return (USER_TIERS as readonly string[]).includes(value) ? (value as UserTier) : 'free';
}

/**
 * A count that cannot be read must not read as zero.
 *
 * `openPositionCount` is compared with `>=` against the user's cap, so a `NaN`
 * would make the comparison false and *admit* — failing toward opening a
 * position past the cap. Throwing fails the whole fan-out closed instead, which
 * is the correct direction for an unreadable count on a money path.
 */
function toOpenPositionCount(value: string, userId: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(
      `copy_positions open count for user ${userId} is not a non-negative integer: ${value}`
    );
  }
  return parsed;
}

/** Validate and capture exact-master read inputs before caller acquisition.
 * The client owns the transaction and its reviewed DB identity. This factory
 * grants neither cross-tenant authority nor a swat_fanout protected backing;
 * SQL071/087 and current provisioning do not establish that identity.
 */
export function prepareListFanoutCandidates(input: ListFanoutCandidatesInput) {
  const masterWalletAddress = input.masterWalletAddress;
  const chain = input.chain;
  if (!isChain(chain)) throw new Error('Fanout candidates require an exact chain-prefixed master wallet');
  const master = resolveChainValue(masterWalletAddress, chain);
  if (master.prefixed !== masterWalletAddress || master.raw === '*') {
    throw new Error('Fanout candidates require an exact chain-prefixed master wallet');
  }
  const now = new Date((input.now ?? new Date()).getTime());
  const balanceMaxAgeMs = input.balanceMaxAgeMs ?? BALANCE_MAX_STALENESS_MS;
  if (!Number.isFinite(now.getTime()) || !Number.isFinite(balanceMaxAgeMs) || balanceMaxAgeMs < 0) {
    throw new Error('Invalid fanout candidate balance time/window');
  }
  const captured = { masterWalletAddress, chain, now, balanceMaxAgeMs };
  return (client: PoolClient): Promise<FanoutCandidate[]> => readCandidates(client, captured);
}

/** Shared canonical two-query body; mandatory caller client, no pool fallback. */
export async function listFanoutCandidatesWithClient(
  client: PoolClient, input: ListFanoutCandidatesInput
): Promise<FanoutCandidate[]> {
  return prepareListFanoutCandidates(input)(client);
}

async function readCandidates(client: PoolClient, input: ListFanoutCandidatesInput): Promise<FanoutCandidate[]> {
  const { rows } = await client.query<CandidateRow>(
    `SELECT
       subscription.user_id,
       subscription.active_since,
       subscription.state AS subscription_state,
       account.tier,
       account.tier_expires_at,
       settings.auto_execute,
       settings.killed,
       settings.min_signal_score,
       settings.max_concurrent_positions,
       (
         SELECT COUNT(*)::text
           FROM copy_positions position
          WHERE position.user_id = subscription.user_id
            AND position.confirmed_quantity > 0
       ) AS open_position_count
     FROM user_wallet_subscriptions subscription
     JOIN users account
       ON account.id = subscription.user_id
      AND account.status = 'active'
     LEFT JOIN user_execution_settings settings
       ON settings.user_id = subscription.user_id
     WHERE subscription.wallet_address = $1
       AND subscription.state <> 'ended'
     ORDER BY subscription.user_id`,
    [input.masterWalletAddress]
  );

  if (rows.length === 0) return [];

  const userIds = rows.map((row) => row.user_id);
  const { rows: balanceRows } = await client.query<BalanceRow>(
    `SELECT user_id, chain, asset, amount, decimals, usd, usd_priced_at, fetched_at, source
       FROM user_balances
      WHERE chain = $1 AND user_id = ANY($2::uuid[])
      ORDER BY user_id, asset`,
    [input.chain, userIds]
  );

  const balancesByUser = new Map<string, UserBalance[]>();
  for (const row of balanceRows) {
    const balance = toBalance(row);
    const existing = balancesByUser.get(balance.userId);
    if (existing) existing.push(balance);
    else balancesByUser.set(balance.userId, [balance]);
  }

  const now = input.now ?? new Date();
  const maxAgeMs = input.balanceMaxAgeMs ?? BALANCE_MAX_STALENESS_MS;

  return rows.map((row) => ({
    userId: row.user_id,
    activeSince: row.active_since,
    subscriptionState: row.subscription_state,
    tier: toTier(row.tier),
    tierExpiresAt: row.tier_expires_at,
    // A missing settings row is defaults, not "opted out" — see
    // `DEFAULT_USER_EXECUTION_SETTINGS`. The join is therefore an outer one: an
    // inner join would drop the user entirely and `planFanout` would report no
    // exclusion at all, which is indistinguishable from "not subscribed". With
    // the defaults the same user appears and is excluded as `auto-execute-off`,
    // which is the true reason (nothing creates the row at signup, so
    // auto-execute is off until the user turns it on — D13).
    autoExecute: row.auto_execute ?? DEFAULT_USER_EXECUTION_SETTINGS.autoExecute,
    killed: row.killed ?? DEFAULT_USER_EXECUTION_SETTINGS.killed,
    minSignalScore: row.min_signal_score ?? DEFAULT_USER_EXECUTION_SETTINGS.minSignalScore,
    maxConcurrentPositions:
      row.max_concurrent_positions ?? DEFAULT_USER_EXECUTION_SETTINGS.maxConcurrentPositions,
    openPositionCount: toOpenPositionCount(row.open_position_count, row.user_id),
    // Passed straight through, `null` included. A user with no balance row on
    // this chain gets `null` from `resolveKnownBalanceUsd([])` — unknown, not
    // zero — and is excluded as `balance-unknown`. Coalescing to 0 here would
    // report `balance-below-minimum` instead, which reads as "this user is
    // broke" when the truth is "we never priced them".
    knownBalanceUsd: resolveKnownBalanceUsd(
      balancesByUser.get(row.user_id) ?? [],
      now,
      maxAgeMs
    )
  }));
}
