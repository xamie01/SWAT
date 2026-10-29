import { describe, expect, it } from 'vitest';
import {
  checkPolymarketGeoEligibility,
  DEFAULT_POLYMARKET_GEO_STALENESS_MS
} from './polymarket-geo.js';

describe('Polymarket Geo-Eligibility Enforcement (S4-P16)', () => {
  const now = new Date('2026-10-29T12:00:00Z');

  it('fails closed when geo_verified_at is missing or null', () => {
    const unverified = checkPolymarketGeoEligibility({ geoVerifiedAt: null, now });
    expect(unverified.eligible).toBe(false);
    expect(unverified.code).toBe('polymarket-geo-unverified');
    expect(unverified.reason).toContain('no recorded geo-eligibility');

    const undefinedRes = checkPolymarketGeoEligibility({ geoVerifiedAt: undefined, now });
    expect(undefinedRes.eligible).toBe(false);
    expect(undefinedRes.code).toBe('polymarket-geo-unverified');
  });

  it('admits an account verified within the 7-day staleness window', () => {
    const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
    const result = checkPolymarketGeoEligibility({ geoVerifiedAt: threeDaysAgo, now });
    expect(result.eligible).toBe(true);
    expect(result.ageDays).toBe(3);
  });

  it('refuses an account verified exactly at or beyond 7 days with polymarket-geo-eligibility-stale', () => {
    const eightDaysAgo = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000);
    const result = checkPolymarketGeoEligibility({ geoVerifiedAt: eightDaysAgo, now });
    expect(result.eligible).toBe(false);
    expect(result.code).toBe('polymarket-geo-eligibility-stale');
    expect(result.reason).toContain('expired (8 days old, max 7 days)');
  });

  it('honours a custom staleness override if passed', () => {
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const customWindowMs = 12 * 60 * 60 * 1000; // 12 hours
    const result = checkPolymarketGeoEligibility({
      geoVerifiedAt: oneDayAgo,
      maxAgeMs: customWindowMs,
      now
    });
    expect(result.eligible).toBe(false);
    expect(result.code).toBe('polymarket-geo-eligibility-stale');
  });
});
