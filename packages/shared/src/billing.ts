import type { UserTier } from './tiers.js';

export type BillingPlanId = 'operator_monthly' | 'ultra_monthly' | 'lifetime';
export type BillingChain = 'solana' | 'polygon';

export interface BillingPlan {
  readonly id: BillingPlanId;
  readonly name: string;
  readonly tier: UserTier;
  readonly priceUsdc: number;
  /** Duration in calendar days. `null` indicates perpetual/lifetime access. */
  readonly durationDays: number | null;
  readonly description: string;
}

export const BILLING_PLANS: Readonly<Record<BillingPlanId, BillingPlan>> = {
  operator_monthly: {
    id: 'operator_monthly',
    name: 'Operator Monthly',
    tier: 'operator',
    priceUsdc: 35,
    durationDays: 30,
    description: 'Autonomous live copy trading, 25 tracked wallets across Solana, Robinhood, and Polymarket, instant signals.'
  },
  ultra_monthly: {
    id: 'ultra_monthly',
    name: 'Ultra Monthly',
    tier: 'ultra',
    priceUsdc: 150,
    durationDays: 30,
    description: 'Unlimited tracked wallets, dynamic custom EVM chains, maximum contract backfill depth, priority execution.'
  },
  lifetime: {
    id: 'lifetime',
    name: 'Lifetime Pass',
    tier: 'ultra',
    priceUsdc: 1999,
    durationDays: null,
    description: 'Perpetual Ultra tier access. Pay once in USDC, never pay monthly subscriptions again.'
  }
} as const;

export const USDC_MINTS = {
  solana: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  polygon: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'
} as const;

export const USDC_DECIMALS = 6;

/** Grace period window in days before an unpaid expired tier is downgraded. */
export const BILLING_GRACE_PERIOD_DAYS = 3;

/** Days before expiration to start surfacing renewal reminders. */
export const BILLING_RENEWAL_ALERT_DAYS = 7;

/** Returns the plan configuration by ID, or null if invalid. */
export function resolveBillingPlan(planId: string): BillingPlan | null {
  if (planId in BILLING_PLANS) {
    return BILLING_PLANS[planId as BillingPlanId];
  }
  return null;
}

/**
 * Computes the new tier and expiration date resulting from a verified payment.
 *
 * Rules:
 *  1. Lifetime pass (`durationDays === null`): returns target tier (`ultra`) with `expiresAt = null`.
 *  2. Existing lifetime user (`currentExpiry === null` and `currentTier === 'ultra'`):
 *     keeps lifetime access unchanged.
 *  3. Same tier renewal / stacking: extends from the *current* expiration date by `durationDays`.
 *  4. Upgrade from lower tier (e.g. Free or Operator -> Ultra): starts from `now + durationDays`.
 *  5. Expired user (or Free tier): starts from `now + durationDays`.
 */
export function calculateTierExtension(input: {
  currentTier: UserTier;
  currentExpiry: Date | null;
  targetTier: UserTier;
  durationDays: number | null;
  now?: Date;
}): { tier: UserTier; expiresAt: Date | null } {
  const { currentTier, currentExpiry, targetTier, durationDays, now = new Date() } = input;

  // 1. Lifetime purchase -> perpetual access
  if (durationDays === null) {
    return { tier: targetTier, expiresAt: null };
  }

  // 2. Already lifetime -> preserve lifetime
  if (currentExpiry === null && currentTier === 'ultra') {
    return { tier: 'ultra', expiresAt: null };
  }

  const msPerDay = 24 * 60 * 60 * 1000;
  const durationMs = durationDays * msPerDay;

  // 3. Active user on the same tier -> stack time onto current expiry
  const hasActiveTime = currentExpiry !== null && currentExpiry.getTime() > now.getTime();
  if (hasActiveTime && currentTier === targetTier) {
    return {
      tier: targetTier,
      expiresAt: new Date(currentExpiry.getTime() + durationMs)
    };
  }

  // 4. Upgrade or expired user -> fresh duration from now
  return {
    tier: targetTier,
    expiresAt: new Date(now.getTime() + durationMs)
  };
}

/**
 * Generates an 8-character human-readable deposit reference memo for a user.
 * Format: `SWAT-<6 HEX CHARS>` (e.g. `SWAT-8F3A2B`)
 */
export function generateBillingMemo(userId: string): string {
  // Take stable slice of user UUID without dashes + timestamp salt
  const cleanId = userId.replace(/-/g, '').slice(0, 4).toUpperCase();
  const salt = Math.floor(Math.random() * 0xffff)
    .toString(16)
    .padStart(4, '0')
    .toUpperCase();
  return `SWAT-${cleanId}${salt}`;
}

/** Canonical ledger identity; Solana signatures are case-sensitive. */
export function canonicalPaymentHash(chain: BillingChain, value: string): string {
  const hash = value.trim();
  if (chain === 'polygon' && /^0x[0-9a-fA-F]{64}$/.test(hash)) return hash.toLowerCase();
  if (chain === 'solana' && /^[1-9A-HJ-NP-Za-km-z]{87,88}$/.test(hash)) return hash;
  throw new Error('Invalid payment transaction hash');
}
