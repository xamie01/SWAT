import { DEFAULT_RISK_CONFIG } from '@swat/shared';
import { DEFAULT_MAX_CONCURRENT_POSITIONS } from './position-cap.js';

/** Shared pool-free missing-row defaults; live preferences do not grant authority. */
/** Matches the seeded `signals.auto_execute_min_score` in `001_init.sql`. */
export const DEFAULT_MIN_SIGNAL_SCORE = 80;

/** 3600s == the 60-minute `REBUY_COOLDOWN_MINUTES` default the operator path uses. */
export const DEFAULT_REBUY_COOLDOWN_SECONDS = 3600;

/**
 * Deliberately low (D11). Raising a user's cap is an audited admin action, which
 * is why the value lives on the row rather than in a constant — but a *new* user
 * still needs a number, and this is it.
 */
export const DEFAULT_MAX_DAILY_WITHDRAWAL_USD = 1000;

export interface UserExecutionSettings {
  readonly autoExecute: boolean;
  readonly minSignalScore: number;
  readonly maxPositionPct: number;
  readonly maxDailyExposurePct: number;
  readonly stopLossPct: number;
  readonly rebuyCooldownSeconds: number;
  readonly maxDailyWithdrawalUsd: number;
  /**
   * How many positions the user may hold open at once (`S4-M4`).
   *
   * Read through here rather than left as a bare column because the platform
   * ceiling is enforced on write: a stored value is always already clamped, so a
   * consumer never has to wonder whether it is a user wish or an allowed limit.
   */
  readonly maxConcurrentPositions: number;
  /** The per-user kill switch (`S6-8`). When true, no chain executes. */
  readonly killed: boolean;
  /**
   * False when no row exists and every value above is a default.
   *
   * Carried so the API can distinguish "the user accepted the defaults" from "the
   * user never opened the settings page" — the disclosure obligations in D13
   * attach to an explicit opt-in, and that distinction is the evidence.
   */
  readonly persisted: boolean;
  /** Null exactly when `persisted` is false. */
  readonly updatedAt: Date | null;
}

/**
 * What a user with no row gets.
 *
 * The three risk percentages come from `DEFAULT_RISK_CONFIG` rather than being
 * retyped, so the operator path and a new tenant cannot start from different
 * numbers.
 */
export const DEFAULT_USER_EXECUTION_SETTINGS: UserExecutionSettings = Object.freeze({
  autoExecute: false,
  minSignalScore: DEFAULT_MIN_SIGNAL_SCORE,
  maxPositionPct: DEFAULT_RISK_CONFIG.maxPositionPct,
  maxDailyExposurePct: DEFAULT_RISK_CONFIG.maxDailyExposurePct,
  stopLossPct: DEFAULT_RISK_CONFIG.stopLossPct,
  rebuyCooldownSeconds: DEFAULT_REBUY_COOLDOWN_SECONDS,
  maxDailyWithdrawalUsd: DEFAULT_MAX_DAILY_WITHDRAWAL_USD,
  maxConcurrentPositions: DEFAULT_MAX_CONCURRENT_POSITIONS,
  killed: false,
  persisted: false,
  updatedAt: null
});

