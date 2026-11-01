import type { LpPool } from '@swat/db';
import {
  EXCESSIVE_TAX_FLAG,
  FREEZE_AUTHORITY_FLAG,
  HONEYPOT_DETECTED_FLAG,
  LIQUIDITY_UNLOCKED_FLAG,
  MINT_AUTHORITY_FLAG
} from '../risk/types.js';

export const MAX_NEW_LAUNCH_AGE_HOURS = 48;
export const MAX_SAFE_RISK_SCORE = 30;

export const CRITICAL_RUG_FLAGS: readonly string[] = [
  HONEYPOT_DETECTED_FLAG,
  MINT_AUTHORITY_FLAG,
  LIQUIDITY_UNLOCKED_FLAG,
  FREEZE_AUTHORITY_FLAG,
  EXCESSIVE_TAX_FLAG
];

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
export function evaluateRugShield(pool: LpPool): {
  readonly passed: boolean;
  readonly rejectionReasons: readonly string[];
} {
  const reasons: string[] = [];

  if (pool.riskScore === null) {
    reasons.push('risk_audit_pending: pool has not completed pre-flight risk checks');
  } else if (pool.riskScore > MAX_SAFE_RISK_SCORE) {
    reasons.push(`high_risk_score: ${pool.riskScore} exceeds safety gate of ${MAX_SAFE_RISK_SCORE}`);
  }

  for (const flag of pool.riskFlags) {
    if (CRITICAL_RUG_FLAGS.includes(flag)) {
      reasons.push(`critical_flag_detected: ${flag}`);
    }
  }

  return {
    passed: reasons.length === 0,
    rejectionReasons: reasons
  };
}

/**
 * Scans, filters, and ranks newly launched pairs (< 48h) with high fee APR
 * and active volume-to-liquidity velocity.
 */
export function rankHotNewLaunches(
  pools: readonly LpPool[],
  now = new Date()
): readonly HotLaunchPool[] {
  const analyzed: HotLaunchPool[] = [];

  for (const pool of pools) {
    const ageMs = Math.max(0, now.getTime() - pool.createdAt.getTime());
    const ageHours = ageMs / (1000 * 3600);
    const isNewLaunch = ageHours <= MAX_NEW_LAUNCH_AGE_HOURS;

    const activeLiquidity = pool.activeTvl ?? pool.tvl ?? 0;
    const volume = pool.volume24h ?? 0;
    const volumeToActiveLiquidity = activeLiquidity > 0 ? volume / activeLiquidity : 0;

    // Volatility surge multiplier for discrete bins (Meteora DLMM fee surge)
    const volatilitySurgeIndex = Math.min(10, Math.max(1, volumeToActiveLiquidity / 2));
    const dailyFeeYieldPct = pool.feeApr24h !== null ? (pool.feeApr24h / 365) * 100 : 0;

    const shield = evaluateRugShield(pool);

    // Multi-factor rank: velocity of fees (V/L), fee APR, and safety score
    const safetyComponent = pool.riskScore !== null ? Math.max(0, 100 - pool.riskScore) : 0;
    const aprComponent = pool.feeApr24h ?? 0;
    const velocityComponent = volumeToActiveLiquidity * 10;
    const rankScore = velocityComponent * 0.4 + aprComponent * 0.4 + safetyComponent * 0.2;

    analyzed.push({
      ...pool,
      ageHours: Number(ageHours.toFixed(1)),
      isNewLaunch,
      volumeToActiveLiquidity: Number(volumeToActiveLiquidity.toFixed(2)),
      volatilitySurgeIndex: Number(volatilitySurgeIndex.toFixed(2)),
      dailyFeeYieldPct: Number(dailyFeeYieldPct.toFixed(2)),
      rugShieldPassed: shield.passed,
      rejectionReasons: shield.rejectionReasons,
      rankScore: Number(rankScore.toFixed(2))
    });
  }

  // Filter for clean new launches and sort descending by rankScore
  return analyzed
    .filter((p) => p.isNewLaunch && p.rugShieldPassed)
    .sort((a, b) => b.rankScore - a.rankScore);
}
