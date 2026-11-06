import { USER_TIERS } from '@swat/shared';
import { query } from './client.js';
import { isCrossTenant } from './tenancy.js';
import { BALANCE_MAX_STALENESS_MS, resolveKnownBalanceUsd } from './user-balances.js';
import { DEFAULT_USER_EXECUTION_SETTINGS } from './user-execution-settings.js';
/**
 * `NUMERIC` arrives as a `number` when it fits a float64 without drift and as
 * the original text when it does not, per `configurePostgresNumericParsers`.
 *
 * Duplicated from `user-balances.ts` rather than imported because the function
 * there is module-private. The rule is identical and must stay so: re-parsing
 * the text half with `Number()` would reintroduce exactly the drift that parser
 * exists to prevent, so an unrepresentable value reads as `null` — unknown — and
 * `resolveKnownBalanceUsd` then refuses the whole user rather than sizing
 * against a rounded figure.
 */
function toSafeNumber(value) {
    if (value === null)
        return null;
    if (typeof value === 'number')
        return Number.isFinite(value) ? value : null;
    return null;
}
function toBalance(row) {
    return {
        userId: row.user_id,
        chain: row.chain,
        asset: row.asset,
        amount: toSafeNumber(row.amount),
        amountRaw: String(row.amount),
        decimals: row.decimals,
        usd: toSafeNumber(row.usd),
        usdPricedAt: row.usd_priced_at,
        fetchedAt: row.fetched_at,
        source: row.source
    };
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
function toTier(value) {
    return USER_TIERS.includes(value) ? value : 'free';
}
/**
 * A count that cannot be read must not read as zero.
 *
 * `openPositionCount` is compared with `>=` against the user's cap, so a `NaN`
 * would make the comparison false and *admit* — failing toward opening a
 * position past the cap. Throwing fails the whole fan-out closed instead, which
 * is the correct direction for an unreadable count on a money path.
 */
function toOpenPositionCount(value, userId) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error(`copy_positions open count for user ${userId} is not a non-negative integer: ${value}`);
    }
    return parsed;
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
export async function listFanoutCandidates(scope, input) {
    if (!isCrossTenant(scope)) {
        throw new Error('listFanoutCandidates spans tenants; pass crossTenantScope(reason)');
    }
    const rows = await query(`SELECT
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
     ORDER BY subscription.user_id`, [input.masterWalletAddress]);
    if (rows.length === 0)
        return [];
    const userIds = rows.map((row) => row.user_id);
    const balanceRows = await query(`SELECT user_id, chain, asset, amount, decimals, usd, usd_priced_at, fetched_at, source
       FROM user_balances
      WHERE chain = $1 AND user_id = ANY($2::uuid[])
      ORDER BY user_id, asset`, [input.chain, userIds]);
    const balancesByUser = new Map();
    for (const row of balanceRows) {
        const balance = toBalance(row);
        const existing = balancesByUser.get(balance.userId);
        if (existing)
            existing.push(balance);
        else
            balancesByUser.set(balance.userId, [balance]);
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
        maxConcurrentPositions: row.max_concurrent_positions ?? DEFAULT_USER_EXECUTION_SETTINGS.maxConcurrentPositions,
        openPositionCount: toOpenPositionCount(row.open_position_count, row.user_id),
        // Passed straight through, `null` included. A user with no balance row on
        // this chain gets `null` from `resolveKnownBalanceUsd([])` — unknown, not
        // zero — and is excluded as `balance-unknown`. Coalescing to 0 here would
        // report `balance-below-minimum` instead, which reads as "this user is
        // broke" when the truth is "we never priced them".
        knownBalanceUsd: resolveKnownBalanceUsd(balancesByUser.get(row.user_id) ?? [], now, maxAgeMs)
    }));
}
//# sourceMappingURL=fanout-candidates.js.map