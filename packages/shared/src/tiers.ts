import type { Chain } from './types.js';

/**
 * Tier capability matrix — the single source of truth for quotas, features, and
 * chain access, consumed by both API guards and frontend gating (SaaS Phase 2).
 *
 * **Capability only, never price.** Stage 5 owns billing, so a price change never
 * has to touch quota logic and a quota change never has to touch a payment path.
 */

export type UserTier = 'free' | 'operator' | 'ultra' | 'unlimited';

export const USER_TIERS: readonly UserTier[] = ['free', 'operator', 'ultra', 'unlimited'] as const;

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

const FREE: TierCapabilities = {
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

const OPERATOR: TierCapabilities = {
  tier: 'operator',
  trackedWallets: 25,
  tokenBackfillsPerDay: 25,
  backfillDepthDays: 180,
  chains: ['solana', 'polygon', 'robinhood-chain'],
  signalDelaySeconds: 0,
  liveExecution: true,
  apiKeys: 3,
  backfillPriority: 5
};

const ULTRA: TierCapabilities = {
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

const UNLIMITED: TierCapabilities = {
  ...ULTRA,
  tier: 'unlimited'
};

export const TIER_CAPABILITIES: Readonly<Record<UserTier, TierCapabilities>> = {
  free: FREE,
  operator: OPERATOR,
  ultra: ULTRA,
  unlimited: UNLIMITED
};

/** Ordering for "at least this tier" comparisons. */
const TIER_RANK: Readonly<Record<UserTier, number>> = {
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
export function effectiveTier(tier: UserTier | string, expiresAt: Date | null, now = new Date()): UserTier {
  const normalized: UserTier =
    tier === 'unlimited' || tier === 'lifetime' ? 'unlimited' :
    tier === 'operator' ? 'operator' :
    tier === 'ultra' ? 'ultra' :
    tier === 'free' ? 'free' : 'free';

  if (expiresAt === null) return normalized;
  return expiresAt.getTime() < now.getTime() ? 'free' : normalized;
}

export function capabilitiesFor(tier: UserTier | string, expiresAt: Date | null = null, now = new Date()): TierCapabilities {
  return TIER_CAPABILITIES[effectiveTier(tier, expiresAt, now)] ?? TIER_CAPABILITIES.free;
}

export function tierAtLeast(tier: UserTier, minimum: UserTier): boolean {
  return TIER_RANK[tier] >= TIER_RANK[minimum];
}

/** True when `used` is already at or over the limit. `null` quota is never exceeded. */
export function quotaExceeded(quota: Quota, used: number): boolean {
  return quota !== null && used >= quota;
}

export function tierAllowsChain(capabilities: TierCapabilities, chain: Chain): boolean {
  return capabilities.chains === null || capabilities.chains.includes(chain);
}
