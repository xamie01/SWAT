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
export declare const DEFAULT_POLYMARKET_GEO_STALENESS_MS: number;
export type GeoEligibilityResult = {
    readonly eligible: true;
    readonly ageDays: number;
} | {
    readonly eligible: false;
    readonly code: 'polymarket-geo-unverified' | 'polymarket-geo-eligibility-stale';
    readonly reason: string;
    readonly ageDays?: number;
};
export declare function checkPolymarketGeoEligibility(params: {
    readonly geoVerifiedAt?: Date | null;
    readonly maxAgeMs?: number;
    readonly now?: Date;
}): GeoEligibilityResult;
//# sourceMappingURL=polymarket-geo.d.ts.map