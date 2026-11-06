import type { Chain } from './types.js';
/**
 * Tier capability matrix — the single source of truth for quotas, features, and
 * chain access, consumed by both API guards and frontend gating (SaaS Phase 2).
 *
 * **Capability only, never price.** Stage 5 owns billing, so a price change never
 * has to touch quota logic and a quota change never has to touch a payment path.
 */
export type UserTier = 'free' | 'operator' | 'ultra' | 'unlimited';
export declare const USER_TIERS: readonly UserTier[];
/**
 * `null` means unlimited — deliberately not `Infinity`.
 *
 * `Infinity` does not survive `JSON.stringify` (it becomes `null` anyway) or a
 * numeric database column, and it invites `if (!limit)` checks that treat it the
 * same as `0`. `null` forces an explicit branch at every call site.
 */
export type Quota = number | null;
export interface TierCapabilities {
    readonly tier: UserTier;
    /** Concurrent tracked-wallet subscriptions. */
    readonly trackedWallets: Quota;
    /** Token-contract backfills startable per rolling 24h. */
    readonly tokenBackfillsPerDay: Quota;
    /** How far back a backfill may reach. */
    readonly backfillDepthDays: number;
    /** Chains this tier may track. `null` = every registered chain (Stage 7). */
    readonly chains: readonly Chain[] | null;
    /**
     * Signal feed delay in seconds. The free tier is delayed on purpose; this is a
     * product decision recorded here because the feed query must implement it, and
     * retrofitting it into a hot path later is worse.
     */
    readonly signalDelaySeconds: number;
    /** Whether live execution may be enabled at all (Stage 4; platform gates still apply). */
    readonly liveExecution: boolean;
    readonly apiKeys: Quota;
    /** BullMQ job priority for backfills — LOWER runs sooner (D9). */
    readonly backfillPriority: number;
}
export declare const TIER_CAPABILITIES: Readonly<Record<UserTier, TierCapabilities>>;
/**
 * Resolves the tier a user is *actually* entitled to right now.
 *
 * An expired paid tier degrades to `free`. `expiresAt === null` means **lifetime**
 * (the USDC lifetime tier) and must never be read as expired — inverting that
 * check would silently downgrade every lifetime customer.
 */
export declare function effectiveTier(tier: UserTier | string, expiresAt: Date | null, now?: Date): UserTier;
export declare function capabilitiesFor(tier: UserTier | string, expiresAt?: Date | null, now?: Date): TierCapabilities;
export declare function tierAtLeast(tier: UserTier, minimum: UserTier): boolean;
/** True when `used` is already at or over the limit. `null` quota is never exceeded. */
export declare function quotaExceeded(quota: Quota, used: number): boolean;
export declare function tierAllowsChain(capabilities: TierCapabilities, chain: Chain): boolean;
//# sourceMappingURL=tiers.d.ts.map