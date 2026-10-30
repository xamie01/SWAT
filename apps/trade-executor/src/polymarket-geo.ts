/**
 * Polymarket Geo-Eligibility Enforcement for Unattended Execution (S4-P16).
 *
 * Polymarket requires builders to verify user location before submitting orders.
 * In automated copy-trading, orders run without the user present, so the server's
 * IP cannot be checked at execution time.
 *
 * Implements the decided policy (7-day staleness window, ADR-0003 §4.2.5):
 *  - Interactive sessions capture `geo_verified_at` (backed by Cloudflare CF-IPCountry).
 *  - Automated execution validates `NOW() - geo_verified_at <= 7 days`.
 *  - Stale accounts fail closed with stable code `polymarket-geo-eligibility-stale`
 *    and skip-with-reason rather than executing silently.
 */

export const DEFAULT_POLYMARKET_GEO_STALENESS_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export type GeoEligibilityResult =
  | { readonly eligible: true; readonly ageDays: number }
  | {
      readonly eligible: false;
      readonly code: 'polymarket-geo-unverified' | 'polymarket-geo-eligibility-stale';
      readonly reason: string;
      readonly ageDays?: number;
    };

export function checkPolymarketGeoEligibility(params: {
  readonly geoVerifiedAt?: Date | null;
  readonly maxAgeMs?: number;
  readonly now?: Date;
}): GeoEligibilityResult {
  if (!params.geoVerifiedAt || Number.isNaN(params.geoVerifiedAt.getTime())) {
    return {
      eligible: false,
      code: 'polymarket-geo-unverified',
      reason: 'Account has no recorded geo-eligibility verification'
    };
  }

  const now = params.now ?? new Date();
  const maxAgeMs = params.maxAgeMs ?? Number(process.env.POLYMARKET_GEO_STALENESS_MS ?? DEFAULT_POLYMARKET_GEO_STALENESS_MS);
  const diffMs = now.getTime() - params.geoVerifiedAt.getTime();
  const ageDays = Math.max(0, Math.floor(diffMs / (24 * 60 * 60 * 1000)));

  if (diffMs > maxAgeMs) {
    return {
      eligible: false,
      code: 'polymarket-geo-eligibility-stale',
      reason: `Geo-eligibility verification has expired (${ageDays} days old, max 7 days); user must re-authenticate`,
      ageDays
    };
  }

  return {
    eligible: true,
    ageDays
  };
}
