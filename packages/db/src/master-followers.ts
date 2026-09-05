import type { Chain } from '@swat/shared';
import { getChainPrefix } from '@swat/shared';
import { query } from './client.js';

/**
 * How many users one master's fan-out actually has to serve, per `(master, chain)`
 * — the `activeFollowerCount` input `assessMasterCapacity` needs for its crude
 * secondary cap (`S4-M6`, migration `053`; slots come from `056`).
 *
 * ── This is a count of capacity CONSUMERS, not of subscribers ─────────────
 *
 * The distinction is the whole reason this file exists rather than a `COUNT(*)`
 * at the call site, and getting it wrong breaks something in both directions:
 *
 *   * A **`winding_down`** subscription is **not** counted. Those users are
 *     leaving, they hold no `membership_slot` (migration `056`'s
 *     `chk_uws_membership_slot_state` makes a slot-holding non-active row
 *     unrepresentable), and they open no new position — `fanout-eligibility.ts`
 *     excludes them from a buy with `winding-down-buy-refused`. Counting them
 *     would charge the cohort for orders nobody places.
 *   * They nevertheless **still receive sell mirrors** (`S4-M44`/`S4-M45`), and
 *     that is exactly why this must not be renamed to something that reads as
 *     "subscribers". A leaver is enumerated by the fan-out and is not a member.
 *     Anyone who later "fixes" this to match the enumeration count will have
 *     silently widened the cap.
 *   * An **`ended`** subscription is not counted and its rows are retained
 *     forever for attribution (`051`), so the `state` predicate is load-bearing
 *     rather than cosmetic.
 *
 * ── Grandfathered actives are counted, and that departs from "slot holders" ─
 *
 * The obvious reading of "holders of a live membership slot" is
 * `state = 'active' AND membership_slot IS NOT NULL`. That is **not** the right
 * number here, because migration `056` deliberately left over-subscribed masters
 * with active members carrying `membership_slot IS NULL` **and**
 * `membership_grandfathered = true` — it evicts nobody, since eviction would
 * strand precisely the positions whose only exit is the master's sell mirror.
 *
 * A grandfathered member is fully active: they mirror buys and sells and they put
 * an order behind the chain's concurrency-1 worker like everybody else. Counting
 * slot holders alone would under-report a master's real cohort by exactly the
 * grandfathered set, and **under-reporting a cap is the permissive direction** —
 * the soft cap would stop binding on the very masters that were over-subscribed
 * when `056` ran, which are the only masters it was ever going to bind on.
 *
 * So the figure fed to the cap is `slotHolders + grandfatheredActive`, and both
 * halves are reported separately so an operator can see which is which. That is
 * the same split `fetchMasterMembershipOccupancy` already makes; the two
 * functions answer different questions and are deliberately not shared:
 * occupancy is **slot bookkeeping** (which ordinals are free), this is
 * **cohort size** (how many orders a fan-out implies).
 *
 * ── `null` is unknown and is never `0` ───────────────────────────────────
 *
 * `assessMasterCapacity` treats a `null` follower count as its own
 * `follower-count-unknown` unassessed reason and leaves the crude secondary cap
 * unevaluated. A `0` would read as "this master has no followers", which passes
 * every cap trivially. So every read failure returns `null`, and an *incoherent*
 * input (a prefix that disagrees with the chain) throws instead — a missing fact
 * and a caller bug are different events and must not share a return value.
 *
 * ── Pure / DB split ─────────────────────────────────────────────────────
 *
 * `summariseMasterFollowerRows` and `assertMasterAddressMatchesChain` are pure
 * and carry every rule worth testing. The one query below is thin, and — like
 * everything else in this package on this branch — has never been executed:
 * there is no database here.
 */

/**
 * A master's cohort size, split by how each member came to be in it.
 *
 * Both halves are surfaced because they have different fixes: a high
 * `slotHolders` is the cap working as designed, while a non-zero
 * `grandfatheredActive` is `056`'s backfill remainder and only ever shrinks.
 */
export interface MasterFollowerCount {
  /** Active members holding an ordinal in `1..MASTER_MEMBERSHIP_CAP`. */
  readonly slotHolders: number;
  /**
   * Active members with no ordinal, flagged by `056`'s backfill. Fully active
   * copiers; the set only shrinks, and the migration contains no `DELETE FROM`.
   */
  readonly grandfatheredActive: number;
  /**
   * What the cap is evaluated against: every active member who will place an
   * order for a buy. `slotHolders + grandfatheredActive`.
   */
  readonly capacityConsumers: number;
}

/** A caller asked for a count keyed on two facts that disagree. Loud, not `null`. */
export class MasterFollowerInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MasterFollowerInputError';
  }
}

/**
 * Refuses a master address whose chain prefix is not the chain being asked about.
 *
 * `user_wallet_subscriptions` has **no chain column** — the chain lives in the
 * address prefix, per the repo-wide invariant — so `(master, chain)` is only a
 * coherent key if the two agree. A mismatch would silently return the count for
 * a different chain's master, or `0` for a master that does not exist, and a `0`
 * here is the value this module exists to never produce by accident.
 *
 * Pure and exported so the rule is testable without a database, the same reason
 * `masterMembershipLockKey` is.
 */
export function assertMasterAddressMatchesChain(
  masterWalletAddress: string,
  chain: Chain
): void {
  const address = masterWalletAddress.trim();
  if (!address) {
    throw new MasterFollowerInputError(
      'countActiveMasterFollowers requires a chain-prefixed master wallet address'
    );
  }
  // `getChainPrefix` is the canonical reader of the prefix — it walks `CHAINS`
  // rather than splitting on ':', so an unsupported prefix reads as `null` here
  // instead of as some third chain.
  const prefixed = getChainPrefix(address);
  if (prefixed !== chain) {
    throw new MasterFollowerInputError(
      `master wallet address ${address} is not on ${chain} (prefix reads as `
        + `${prefixed ?? 'no supported chain'}). user_wallet_subscriptions has no chain `
        + 'column, so the prefix is the only thing that makes (master, chain) a coherent key.'
    );
  }
}

/** One row of the count query. `COUNT` is `bigint`, so it arrives as text. */
export interface MasterFollowerCountRow {
  slot_holders: string | null;
  grandfathered_active: string | null;
}

/**
 * Turns the count row into the figure the cap reads, or `null` if it cannot.
 *
 * A count that will not parse as a non-negative integer is **unknown**, not zero:
 * `Number(null)` and `Number('')` are both `0`, which would silently report an
 * empty cohort and pass every cap. Pure, so both branches are tested.
 */
export function summariseMasterFollowerRows(
  rows: readonly MasterFollowerCountRow[]
): MasterFollowerCount | null {
  const row = rows[0];
  if (!row) return null;

  const slotHolders = toCount(row.slot_holders);
  const grandfatheredActive = toCount(row.grandfathered_active);
  if (slotHolders === null || grandfatheredActive === null) return null;

  return Object.freeze({
    slotHolders,
    grandfatheredActive,
    capacityConsumers: slotHolders + grandfatheredActive
  });
}

function toCount(value: string | null): number | null {
  if (value === null || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Live cohort size for one master on one chain, or `null` if it could not be read.
 *
 * Filtered three ways, and each one is a scope rather than a decision:
 *
 *   1. `wallet_address = $1` — the master. Chain-prefixed, and checked against
 *      the requested chain before the query runs.
 *   2. `state = 'active'` — the capacity-consumer rule above. `winding_down` and
 *      `ended` are excluded here and the reasons differ; see the file header.
 *   3. `users.status = 'active'` — parity with `listFanoutCandidates`, which
 *      filters the same way. A suspended account is enumerated by nothing and
 *      places no order, so counting it would inflate the cohort. This is the one
 *      filter that makes the number differ from `fetchMasterMembershipOccupancy`,
 *      deliberately: that function counts ordinals, this counts orders.
 *
 * Served by `idx_uws_wallet_live (wallet_address, state) WHERE state <> 'ended'`
 * from `051`. The row count per master is bounded by the membership cap plus
 * whatever `056` grandfathered, so no new index is warranted.
 *
 * The prefix check runs **outside** the try, so a caller bug throws while a
 * database failure returns `null`.
 */
export async function fetchActiveMasterFollowerCount(params: {
  masterWalletAddress: string;
  chain: Chain;
}): Promise<MasterFollowerCount | null> {
  assertMasterAddressMatchesChain(params.masterWalletAddress, params.chain);

  try {
    const rows = await query<MasterFollowerCountRow>(
      `SELECT
         COUNT(*) FILTER (WHERE subscription.membership_slot IS NOT NULL)::text
           AS slot_holders,
         COUNT(*) FILTER (
           WHERE subscription.membership_slot IS NULL
             AND subscription.membership_grandfathered
         )::text AS grandfathered_active
       FROM user_wallet_subscriptions subscription
       JOIN users account
         ON account.id = subscription.user_id
        AND account.status = 'active'
      WHERE subscription.wallet_address = $1
        AND subscription.state = 'active'`,
      [params.masterWalletAddress]
    );
    return summariseMasterFollowerRows(rows);
  } catch (error) {
    console.error(
      `[db] active follower count failed for ${params.masterWalletAddress} on ${params.chain}; `
        + 'reporting unknown rather than zero:',
      error instanceof Error ? error.message : error
    );
    return null;
  }
}

/**
 * The single number `MasterCapacityInput.activeFollowerCount` takes.
 *
 * A thin projection of `fetchActiveMasterFollowerCount` so the common call site
 * cannot accidentally pass `slotHolders` — which is the under-count described in
 * the file header and the permissive direction for a cap.
 */
export async function countActiveMasterFollowers(params: {
  masterWalletAddress: string;
  chain: Chain;
}): Promise<number | null> {
  const counted = await fetchActiveMasterFollowerCount(params);
  return counted === null ? null : counted.capacityConsumers;
}
