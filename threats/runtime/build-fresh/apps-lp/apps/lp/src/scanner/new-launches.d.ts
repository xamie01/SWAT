import type { LpPool } from '@swat/db';
export declare const MAX_NEW_LAUNCH_AGE_HOURS = 48;
export declare const MAX_SAFE_RISK_SCORE = 30;
export declare const CRITICAL_RUG_FLAGS: readonly string[];
export interface HotLaunchPool extends LpPool {
    readonly ageHours: number;
    readonly isNewLaunch: boolean;
    readonly volumeToActiveLiquidity: number;
    readonly volatilitySurgeIndex: number;
    readonly dailyFeeYieldPct: number;
    readonly rugShieldPassed: boolean;
    readonly rejectionReasons: readonly string[];
    readonly rankScore: number;
}
/**
 * Evaluates whether a pool passes the institutional Rug Shield pre-flight audit.
 */
export declare function evaluateRugShield(pool: LpPool): {
    readonly passed: boolean;
    readonly rejectionReasons: readonly string[];
};
/**
 * Scans, filters, and ranks newly launched pairs (< 48h) with high fee APR
 * and active volume-to-liquidity velocity.
 */
export declare function rankHotNewLaunches(pools: readonly LpPool[], now?: Date): readonly HotLaunchPool[];
//# sourceMappingURL=new-launches.d.ts.map