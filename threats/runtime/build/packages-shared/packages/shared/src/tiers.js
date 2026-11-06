export const USER_TIERS = ['free', 'operator', 'ultra', 'unlimited'];
const FREE = {
    tier: 'free',
    trackedWallets: 3,
    tokenBackfillsPerDay: 5,
    backfillDepthDays: 30,
    chains: ['solana', 'polygon', 'robinhood-chain'],
    signalDelaySeconds: 900,
    liveExecution: false,
    apiKeys: 0,
    backfillPriority: 10
};
const OPERATOR = {
    tier: 'operator',
    trackedWallets: 25,
    tokenBackfillsPerDay: 25,
    backfillDepthDays: 180,
    chains: ['solana', 'polygon', 'robinhood-chain', 'base', 'ethereum', 'bsc'],
    signalDelaySeconds: 0,
    liveExecution: true,
    apiKeys: 3,
    backfillPriority: 5
};
const ULTRA = {
    tier: 'ultra',
    trackedWallets: null,
    tokenBackfillsPerDay: 100,
    backfillDepthDays: 730,
    // null = every registered chain, including Ultra's custom ones (Stage 7).
    chains: null,
    signalDelaySeconds: 0,
    liveExecution: true,
    apiKeys: 10,
    backfillPriority: 1
};
const UNLIMITED = {
    ...ULTRA,
    tier: 'unlimited'
};
export const TIER_CAPABILITIES = {
    free: FREE,
    operator: OPERATOR,
    ultra: ULTRA,
    unlimited: UNLIMITED
};
/** Ordering for "at least this tier" comparisons. */
const TIER_RANK = {
    free: 0,
    operator: 1,
    ultra: 2,
    unlimited: 2
};
/**
 * Resolves the tier a user is *actually* entitled to right now.
 *
 * An expired paid tier degrades to `free`. `expiresAt === null` means **lifetime**
 * (the USDC lifetime tier) and must never be read as expired — inverting that
 * check would silently downgrade every lifetime customer.
 */
export function effectiveTier(tier, expiresAt, now = new Date()) {
    const normalized = tier === 'unlimited' || tier === 'lifetime' ? 'unlimited' :
        tier === 'operator' ? 'operator' :
            tier === 'ultra' ? 'ultra' :
                tier === 'free' ? 'free' : 'free';
    if (expiresAt === null)
        return normalized;
    return expiresAt.getTime() < now.getTime() ? 'free' : normalized;
}
export function capabilitiesFor(tier, expiresAt = null, now = new Date()) {
    return TIER_CAPABILITIES[effectiveTier(tier, expiresAt, now)] ?? TIER_CAPABILITIES.free;
}
export function tierAtLeast(tier, minimum) {
    return TIER_RANK[tier] >= TIER_RANK[minimum];
}
/** True when `used` is already at or over the limit. `null` quota is never exceeded. */
export function quotaExceeded(quota, used) {
    return quota !== null && used >= quota;
}
export function tierAllowsChain(capabilities, chain) {
    return capabilities.chains === null || capabilities.chains.includes(chain);
}
//# sourceMappingURL=tiers.js.map