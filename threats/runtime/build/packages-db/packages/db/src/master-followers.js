import { getChainPrefix } from '@swat/shared';
import { query } from './client.js';
/** A caller asked for a count keyed on two facts that disagree. Loud, not `null`. */
export class MasterFollowerInputError extends Error {
    constructor(message) {
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
export function assertMasterAddressMatchesChain(masterWalletAddress, chain) {
    const address = masterWalletAddress.trim();
    if (!address) {
        throw new MasterFollowerInputError('countActiveMasterFollowers requires a chain-prefixed master wallet address');
    }
    // `getChainPrefix` is the canonical reader of the prefix — it walks `CHAINS`
    // rather than splitting on ':', so an unsupported prefix reads as `null` here
    // instead of as some third chain.
    const prefixed = getChainPrefix(address);
    if (prefixed !== chain) {
        throw new MasterFollowerInputError(`master wallet address ${address} is not on ${chain} (prefix reads as `
            + `${prefixed ?? 'no supported chain'}). user_wallet_subscriptions has no chain `
            + 'column, so the prefix is the only thing that makes (master, chain) a coherent key.');
    }
}
/**
 * Turns the count row into the figure the cap reads, or `null` if it cannot.
 *
 * A count that will not parse as a non-negative integer is **unknown**, not zero:
 * `Number(null)` and `Number('')` are both `0`, which would silently report an
 * empty cohort and pass every cap. Pure, so both branches are tested.
 */
export function summariseMasterFollowerRows(rows) {
    const row = rows[0];
    if (!row)
        return null;
    const slotHolders = toCount(row.slot_holders);
    const grandfatheredActive = toCount(row.grandfathered_active);
    if (slotHolders === null || grandfatheredActive === null)
        return null;
    return Object.freeze({
        slotHolders,
        grandfatheredActive,
        capacityConsumers: slotHolders + grandfatheredActive
    });
}
function toCount(value) {
    if (value === null || value.trim() === '')
        return null;
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
export async function fetchActiveMasterFollowerCount(params) {
    assertMasterAddressMatchesChain(params.masterWalletAddress, params.chain);
    try {
        const rows = await query(`SELECT
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
        AND subscription.state = 'active'`, [params.masterWalletAddress]);
        return summariseMasterFollowerRows(rows);
    }
    catch (error) {
        console.error(`[db] active follower count failed for ${params.masterWalletAddress} on ${params.chain}; `
            + 'reporting unknown rather than zero:', error instanceof Error ? error.message : error);
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
export async function countActiveMasterFollowers(params) {
    const counted = await fetchActiveMasterFollowerCount(params);
    return counted === null ? null : counted.capacityConsumers;
}
//# sourceMappingURL=master-followers.js.map