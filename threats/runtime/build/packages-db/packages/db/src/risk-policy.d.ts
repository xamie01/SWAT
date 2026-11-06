import type { Chain } from '@swat/shared';
declare const RISK_POLICY_CACHE_TTL_MS = 30000;
export interface RiskPolicy {
    maxPositionPct: number;
    maxDailyExposurePct: number;
    stopLossPct: number;
    maxConsecutiveFailures: number;
    minLiquidityUsd: number;
}
/**
 * Hard entry cap. Sized for a few thousand active (user, chain) pairs; well past
 * that the DB round trip is cheaper than the resident memory.
 */
declare const RISK_POLICY_CACHE_MAX_ENTRIES = 5000;
export declare function resolveRiskPolicy(account: string, chain: Chain): Promise<RiskPolicy>;
export declare function clearRiskPolicyCache(): void;
/** Entry count. Test-only — lets a test assert the cache is actually bounded. */
export declare function riskPolicyCacheSize(): number;
export { RISK_POLICY_CACHE_MAX_ENTRIES, RISK_POLICY_CACHE_TTL_MS };
//# sourceMappingURL=risk-policy.d.ts.map