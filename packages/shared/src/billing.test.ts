import { describe, expect, it } from 'vitest';
import {
  BILLING_PLANS,
  calculateTierExtension,
  generateBillingMemo,
  resolveBillingPlan
} from './billing.js';

describe('billing module', () => {
  it('resolves valid billing plans and rejects unknown ones', () => {
    expect(resolveBillingPlan('operator_monthly')).toEqual(BILLING_PLANS.operator_monthly);
    expect(resolveBillingPlan('ultra_monthly')).toEqual(BILLING_PLANS.ultra_monthly);
    expect(resolveBillingPlan('lifetime')).toEqual(BILLING_PLANS.lifetime);
    expect(resolveBillingPlan('unknown_plan')).toBeNull();
  });

  it('correctly sets prices per user specification', () => {
    expect(BILLING_PLANS.operator_monthly.priceUsdc).toBe(35);
    expect(BILLING_PLANS.ultra_monthly.priceUsdc).toBe(150);
    expect(BILLING_PLANS.lifetime.priceUsdc).toBe(1999);
  });

  describe('calculateTierExtension', () => {
    const fixedNow = new Date('2026-10-30T00:00:00.000Z');

    it('grants lifetime pass with null expiration and ultra tier', () => {
      const result = calculateTierExtension({
        currentTier: 'free',
        currentExpiry: null,
        targetTier: 'ultra',
        durationDays: null,
        now: fixedNow
      });
      expect(result).toEqual({ tier: 'ultra', expiresAt: null });
    });

    it('preserves existing lifetime status if a user sends payment', () => {
      const result = calculateTierExtension({
        currentTier: 'ultra',
        currentExpiry: null,
        targetTier: 'ultra',
        durationDays: 30,
        now: fixedNow
      });
      expect(result).toEqual({ tier: 'ultra', expiresAt: null });
    });

    it('stacks time when an active user renews on the same tier', () => {
      // User currently has 10 days remaining
      const currentExpiry = new Date('2026-11-09T00:00:00.000Z');
      const result = calculateTierExtension({
        currentTier: 'operator',
        currentExpiry,
        targetTier: 'operator',
        durationDays: 30,
        now: fixedNow
      });
      // 10 days + 30 days = 40 days (Nov 9 + 30 days = Dec 9)
      expect(result.tier).toBe('operator');
      expect(result.expiresAt).toEqual(new Date('2026-12-09T00:00:00.000Z'));
    });

    it('calculates fresh duration from now when user upgrades from operator to ultra', () => {
      const currentExpiry = new Date('2026-11-09T00:00:00.000Z');
      const result = calculateTierExtension({
        currentTier: 'operator',
        currentExpiry,
        targetTier: 'ultra',
        durationDays: 30,
        now: fixedNow
      });
      expect(result.tier).toBe('ultra');
      expect(result.expiresAt).toEqual(new Date('2026-11-29T00:00:00.000Z'));
    });

    it('calculates fresh duration from now when expired user subscribes', () => {
      // User expired 5 days ago
      const expiredAt = new Date('2026-10-25T00:00:00.000Z');
      const result = calculateTierExtension({
        currentTier: 'free',
        currentExpiry: expiredAt,
        targetTier: 'operator',
        durationDays: 30,
        now: fixedNow
      });
      expect(result.tier).toBe('operator');
      expect(result.expiresAt).toEqual(new Date('2026-11-29T00:00:00.000Z'));
    });
  });

  describe('generateBillingMemo', () => {
    it('generates consistent formatted memos starting with SWAT-', () => {
      const memo1 = generateBillingMemo('e2d098bc-6435-4927-a006-258dc711ba05');
      const memo2 = generateBillingMemo('e2d098bc-6435-4927-a006-258dc711ba05');
      expect(memo1.startsWith('SWAT-')).toBe(true);
      expect(memo2.startsWith('SWAT-')).toBe(true);
      expect(memo1.length).toBe(13); // SWAT- (5) + E2D0 (4) + 4 hex (4) = 13
    });
  });
});
