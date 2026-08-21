import {
  DEFAULT_RISK_CONFIG,
  MAX_SLIPPAGE_BPS,
  MIN_SLIPPAGE_BPS,
  capabilitiesFor,
  isValidSlippageBps,
  resolveSlippageBps,
  tierAllowsChain,
  type Chain,
  type UserTier
} from '@swat/shared';
import { query } from './client.js';
import { withTransaction } from './transaction.js';
import {
  DEFAULT_MAX_CONCURRENT_POSITIONS,
  clampConcurrentPositionCap
} from './position-cap.js';
import type { UserScope } from './tenancy.js';

/**
 * Per-user risk and execution preferences (`S4-9`, migration `049`).
 *
 * Two tables, so two shapes: `user_execution_settings` is the per-user row and
 * `user_chain_execution_settings` is the (user, chain) pair carrying mode and
 * slippage tolerance. They are read separately because the fan-out enumeration
 * (`S4-13`) wants the per-chain rows for many users and the withdrawal path wants
 * one user's caps; joining them here would make each caller pay for the other's
 * columns.
 *
 * Three properties this module exists to hold:
 *
 *   * **A missing row means defaults, not "not configured".** No row is created at
 *     signup, so `getUserExecutionSettings` never returns null — it returns
 *     `DEFAULT_USER_EXECUTION_SETTINGS` with `persisted: false`. A nullable return
 *     would push a `?? default` onto every call site, and the one that forgot it
 *     would size a trade against `undefined`.
 *   * **The DDL owns the default values on the write path.** Both upserts insert a
 *     bare `(user_id)` row and let the column defaults fill it, rather than
 *     restating `80` / `3600` / `1000` in a `COALESCE`. The TypeScript constant
 *     below exists only for the *missing-row read*, and
 *     `user-execution-settings.test.ts` asserts it equals both `DEFAULT_RISK_CONFIG`
 *     and the literals in `049` so the two copies cannot drift apart quietly.
 *   * **`live` is a request, never a grant.** The tier gate here is the *user's*
 *     entitlement; `resolveChainMode` (`execution-config.ts`) still clamps on top
 *     with `LIVE_ENABLED_CHAINS` and the certification record. A user on the right
 *     tier asking for `live` on an uncertified chain gets paper.
 */

/**
 * The per-chain mode a *user* may request.
 *
 * Deliberately narrower than `ExecutionMode` in `@swat/shared`, which also has
 * `live+shadow`. That is an operator diagnostic — it executes live and records a
 * parallel shadow fill — and exposing it as a user preference would mean a user
 * could select a mode whose second half nobody explains to them. `chk_uces_mode`
 * says the same three values.
 */
export type UserChainMode = 'off' | 'paper' | 'live';

export const USER_CHAIN_MODES: readonly UserChainMode[] = ['off', 'paper', 'live'] as const;

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

export interface UserChainExecutionSettings {
  readonly chain: Chain;
  readonly mode: UserChainMode;
  /** `null` means "use the chain default" — see `resolveUserSlippageBps`. */
  readonly maxSlippageBps: number | null;
  readonly updatedAt: Date;
}

interface SettingsRow {
  auto_execute: boolean;
  min_signal_score: number;
  max_position_pct: number | string;
  max_daily_exposure_pct: number | string;
  stop_loss_pct: number | string;
  rebuy_cooldown_seconds: number;
  max_daily_withdrawal_usd: number | string;
  // SMALLINT, so always a number — no NUMERIC text fallback to guard against.
  max_concurrent_positions: number;
  killed: boolean;
  updated_at: Date;
}

interface ChainSettingsRow {
  chain: Chain;
  mode: UserChainMode;
  max_slippage_bps: number | null;
  updated_at: Date;
}

const SETTINGS_COLUMNS = `auto_execute, min_signal_score, max_position_pct,
       max_daily_exposure_pct, stop_loss_pct, rebuy_cooldown_seconds,
       max_daily_withdrawal_usd, max_concurrent_positions, killed, updated_at`;

const CHAIN_SETTINGS_COLUMNS = 'chain, mode, max_slippage_bps, updated_at';

/**
 * `NUMERIC` arrives as a `number` from `configurePostgresNumericParsers` when it
 * fits in a float64 without drift and as the original text when it does not.
 *
 * A risk limit that large is a bad write, not a number to round: re-parsing the
 * text with `Number()` would reintroduce exactly the drift that parser exists to
 * prevent, and the value is multiplied into position sizes. Refusing is louder.
 */
function toLimitNumber(value: number | string, column: string): number {
  if (typeof value === 'number') return value;
  throw new Error(
    `user_execution_settings.${column} is not representable as a number: ${value}`
  );
}

function toSettings(row: SettingsRow): UserExecutionSettings {
  return {
    autoExecute: row.auto_execute,
    minSignalScore: row.min_signal_score,
    maxPositionPct: toLimitNumber(row.max_position_pct, 'max_position_pct'),
    maxDailyExposurePct: toLimitNumber(row.max_daily_exposure_pct, 'max_daily_exposure_pct'),
    stopLossPct: toLimitNumber(row.stop_loss_pct, 'stop_loss_pct'),
    rebuyCooldownSeconds: row.rebuy_cooldown_seconds,
    maxDailyWithdrawalUsd: toLimitNumber(
      row.max_daily_withdrawal_usd,
      'max_daily_withdrawal_usd'
    ),
    maxConcurrentPositions: row.max_concurrent_positions,
    killed: row.killed,
    persisted: true,
    updatedAt: row.updated_at
  };
}

function toChainSettings(row: ChainSettingsRow): UserChainExecutionSettings {
  return {
    chain: row.chain,
    mode: row.mode,
    maxSlippageBps: row.max_slippage_bps,
    updatedAt: row.updated_at
  };
}

/**
 * A requested setting is out of range or internally inconsistent.
 *
 * Distinct from a generic error so the API maps it to 400: every case is a
 * malformed request, not a server fault. Compare `LiveExecutionNotEntitledError`,
 * which is a 403 — the request is well formed and the answer is still no.
 */
export class InvalidExecutionSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidExecutionSettingsError';
  }
}

/** The user's tier does not permit live execution on this chain. Maps to 403. */
export class LiveExecutionNotEntitledError extends Error {
  constructor(
    readonly tier: UserTier,
    readonly chain: Chain
  ) {
    super(`Tier ${tier} may not enable live execution on ${chain}`);
    this.name = 'LiveExecutionNotEntitledError';
  }
}

/**
 * Whether this tier may run live at all, on this chain, right now.
 *
 * Expressed through `capabilitiesFor` and `tierAllowsChain` rather than a second
 * `tier >= 'operator'` comparison. `tiers.ts` already owns the ordering
 * (`tierAtLeast`) and the matrix (`TIER_CAPABILITIES.*.liveExecution`), and
 * `capabilitiesFor` additionally applies the expiry degradation — a lapsed
 * operator tier reads as `free`, so an expired subscription stops live execution
 * without this module knowing what `tier_expires_at` means. A rank comparison here
 * would silently keep executing for expired tiers.
 *
 * `tierExpiresAt === null` is **lifetime**, not expired; `effectiveTier` is the
 * only place that decision is encoded.
 */
export function tierMayExecuteLive(
  tier: UserTier,
  tierExpiresAt: Date | null,
  chain: Chain,
  now: Date = new Date()
): boolean {
  const capabilities = capabilitiesFor(tier, tierExpiresAt, now);
  return capabilities.liveExecution && tierAllowsChain(capabilities, chain);
}

export function assertTierMayExecuteLive(
  tier: UserTier,
  tierExpiresAt: Date | null,
  chain: Chain,
  now: Date = new Date()
): void {
  if (!tierMayExecuteLive(tier, tierExpiresAt, chain, now)) {
    throw new LiveExecutionNotEntitledError(tier, chain);
  }
}

export interface UserExecutionSettingsPatch {
  readonly autoExecute?: boolean;
  readonly minSignalScore?: number;
  readonly maxPositionPct?: number;
  readonly maxDailyExposurePct?: number;
  readonly stopLossPct?: number;
  readonly rebuyCooldownSeconds?: number;
  readonly maxDailyWithdrawalUsd?: number;
  /**
   * Clamped into the platform range on write rather than rejected (`S4-M4`), so
   * the UI can show what the user will actually get. A non-integer still throws —
   * that is not a wish about position counts.
   */
  readonly maxConcurrentPositions?: number;
  readonly killed?: boolean;
}

function assertPercent(value: number, field: string): void {
  if (!Number.isFinite(value) || value <= 0 || value > 100) {
    throw new InvalidExecutionSettingsError(
      `${field} must be a percentage in (0, 100], got ${value}`
    );
  }
}

/**
 * Field-level bounds, mirroring the column `CHECK`s in `049`.
 *
 * Pure and exported so the API can validate a request body before it holds a
 * connection, and so the bounds are testable without a database. The database
 * remains the guarantee; this exists so a caller bug surfaces as a message naming
 * the field rather than as a 23514 naming a constraint the caller has never heard
 * of. It cannot check `chk_ues_position_within_daily`, which needs the row the
 * patch is being applied to — `upsertUserExecutionSettings` does that under lock.
 */
export function assertValidExecutionSettingsPatch(patch: UserExecutionSettingsPatch): void {
  if (patch.maxConcurrentPositions !== undefined) {
    // Throws on a non-integer and clamps an out-of-range integer. Called here so a
    // bad *shape* is refused before the transaction opens, while an out-of-range
    // but coherent number is still accepted and clamped on write (S4-M4).
    clampConcurrentPositionCap(patch.maxConcurrentPositions);
  }
  if (patch.minSignalScore !== undefined) {
    const score = patch.minSignalScore;
    if (!Number.isInteger(score) || score < 0 || score > 100) {
      throw new InvalidExecutionSettingsError(
        `minSignalScore must be an integer in 0..100, got ${score}`
      );
    }
  }
  if (patch.maxPositionPct !== undefined) assertPercent(patch.maxPositionPct, 'maxPositionPct');
  if (patch.maxDailyExposurePct !== undefined) {
    assertPercent(patch.maxDailyExposurePct, 'maxDailyExposurePct');
  }
  if (patch.stopLossPct !== undefined) assertPercent(patch.stopLossPct, 'stopLossPct');
  if (patch.rebuyCooldownSeconds !== undefined) {
    const seconds = patch.rebuyCooldownSeconds;
    if (!Number.isInteger(seconds) || seconds < 0) {
      throw new InvalidExecutionSettingsError(
        `rebuyCooldownSeconds must be a non-negative integer, got ${seconds}`
      );
    }
  }
  if (patch.maxDailyWithdrawalUsd !== undefined) {
    const usd = patch.maxDailyWithdrawalUsd;
    if (!Number.isFinite(usd) || usd < 0) {
      throw new InvalidExecutionSettingsError(
        `maxDailyWithdrawalUsd must be a non-negative finite number, got ${usd}`
      );
    }
  }
  // A patch that names both must already be ordered; naming one is checked against
  // the stored row.
  if (
    patch.maxPositionPct !== undefined
    && patch.maxDailyExposurePct !== undefined
    && patch.maxPositionPct > patch.maxDailyExposurePct
  ) {
    throw new InvalidExecutionSettingsError(
      `maxPositionPct (${patch.maxPositionPct}) may not exceed `
        + `maxDailyExposurePct (${patch.maxDailyExposurePct})`
    );
  }
}

/** Drops keys whose value is `undefined`, so a spread cannot null out a column. */
function definedOnly<T extends object>(patch: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined)
  ) as Partial<T>;
}

/**
 * One user's settings, or the defaults when no row exists.
 *
 * Never null. See the module note: a nullable return would put `?? defaults` at
 * every call site and the one that forgot would size against `undefined`.
 */export async function getUserExecutionSettings(
  scope: UserScope
): Promise<UserExecutionSettings> {
  const rows = await query<SettingsRow>(
    `SELECT ${SETTINGS_COLUMNS} FROM user_execution_settings WHERE user_id = $1`,
    [scope.userId]
  );
  return rows[0] ? toSettings(rows[0]) : DEFAULT_USER_EXECUTION_SETTINGS;
}

/**
 * Applies a partial update, creating the row on first write.
 *
 * The insert names only `user_id` so every unset column takes its DDL default —
 * the numbers stay in one place, and adding a column to `049` does not require
 * editing this statement. The `FOR UPDATE` read then serialises two concurrent
 * patches: without it, one patch raising `max_position_pct` and another lowering
 * `max_daily_exposure_pct` could each pass the cross-field check against the
 * pre-state and commit a pair that violates it — the database would still catch
 * that pair, but as a 23514 on whichever committed second rather than as an error
 * naming both values.
 */
export async function upsertUserExecutionSettings(
  scope: UserScope,
  patch: UserExecutionSettingsPatch
): Promise<UserExecutionSettings> {
  assertValidExecutionSettingsPatch(patch);

  return withTransaction(async (client) => {
    await client.query(
      `INSERT INTO user_execution_settings (user_id) VALUES ($1)
       ON CONFLICT (user_id) DO NOTHING`,
      [scope.userId]
    );
    const current = await client.query<SettingsRow>(
      `SELECT ${SETTINGS_COLUMNS} FROM user_execution_settings
        WHERE user_id = $1
        FOR UPDATE`,
      [scope.userId]
    );
    const merged: UserExecutionSettings = {
      ...toSettings(current.rows[0]!),
      // Only *defined* keys override. A plain spread would let an explicit
      // `{ killed: undefined }` — which a hand-built patch object produces easily —
      // overwrite a stored value with undefined, which `pg` sends as NULL and the
      // NOT NULL column then rejects with an error naming the column rather than
      // the caller's mistake.
      ...definedOnly(patch)
    };

    if (merged.maxPositionPct > merged.maxDailyExposurePct) {
      throw new InvalidExecutionSettingsError(
        `maxPositionPct (${merged.maxPositionPct}) may not exceed `
          + `maxDailyExposurePct (${merged.maxDailyExposurePct})`
      );
    }

    const updated = await client.query<SettingsRow>(
      `UPDATE user_execution_settings
          SET auto_execute             = $2,
              min_signal_score         = $3,
              max_position_pct         = $4,
              max_daily_exposure_pct   = $5,
              stop_loss_pct            = $6,
              rebuy_cooldown_seconds   = $7,
              max_daily_withdrawal_usd = $8,
              max_concurrent_positions = $9,
              killed                   = $10,
              updated_at               = NOW()
        WHERE user_id = $1
        RETURNING ${SETTINGS_COLUMNS}`,
      [
        scope.userId,
        merged.autoExecute,
        merged.minSignalScore,
        merged.maxPositionPct,
        merged.maxDailyExposurePct,
        merged.stopLossPct,
        merged.rebuyCooldownSeconds,
        merged.maxDailyWithdrawalUsd,
        // Clamped here, not merely validated: the platform ceiling is a platform
        // decision, so a caller that skips the clamp helper still cannot store a
        // value past it. `049` mirrors this with a CHECK, making it two layers.
        clampConcurrentPositionCap(merged.maxConcurrentPositions).cap,
        merged.killed
      ]
    );
    return toSettings(updated.rows[0]!);
  });
}

/**
 * Sets the per-user kill switch in one write.
 *
 * Separate from `upsertUserExecutionSettings` because "stop everything now" must
 * not be able to fail on an unrelated field's validation, and because it has to be
 * greppable in the audit log as one event rather than as a settings patch that
 * happened to include `killed`. It is deliberately *not* derived from setting every
 * chain to `off`: the switch must survive the user later re-enabling one chain.
 */
export async function setUserKillSwitch(
  scope: UserScope,
  killed: boolean
): Promise<UserExecutionSettings> {
  const rows = await query<SettingsRow>(
    `INSERT INTO user_execution_settings (user_id, killed)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE
       SET killed = EXCLUDED.killed, updated_at = NOW()
     RETURNING ${SETTINGS_COLUMNS}`,
    [scope.userId, killed]
  );
  return toSettings(rows[0]!);
}

export async function listUserChainExecutionSettings(
  scope: UserScope
): Promise<UserChainExecutionSettings[]> {
  const rows = await query<ChainSettingsRow>(
    `SELECT ${CHAIN_SETTINGS_COLUMNS} FROM user_chain_execution_settings
      WHERE user_id = $1
      ORDER BY chain`,
    [scope.userId]
  );
  return rows.map(toChainSettings);
}

/** One chain's row, or null when the user has never touched that chain. */
export async function getUserChainExecutionSettings(
  scope: UserScope,
  chain: Chain
): Promise<UserChainExecutionSettings | null> {
  const rows = await query<ChainSettingsRow>(
    `SELECT ${CHAIN_SETTINGS_COLUMNS} FROM user_chain_execution_settings
      WHERE user_id = $1 AND chain = $2`,
    [scope.userId, chain]
  );
  return rows[0] ? toChainSettings(rows[0]) : null;
}

export interface UpsertUserChainExecutionSettingsInput {
  readonly chain: Chain;
  /** Omit to leave the stored mode unchanged. */
  readonly mode?: UserChainMode;
  /**
   * `null` clears the override back to the chain default; **omit** to leave the
   * stored value unchanged. The two are different intents and the column
   * distinguishes them, so the input has to as well.
   */
  readonly maxSlippageBps?: number | null;
  /** From the session's user row, so the tier gate cannot be bypassed by a payload. */
  readonly tier: UserTier;
  readonly tierExpiresAt: Date | null;
}

/**
 * Applies a partial per-chain update, creating the row on first write.
 *
 * Requesting `live` is gated on the user's tier here (`operator+` via the
 * capability matrix). That is *not* sufficient for a live trade: `resolveChainMode`
 * still requires the chain in `LIVE_ENABLED_CHAINS` and an active certification,
 * and downgrades to paper otherwise. Storing `live` is a request; the executor
 * decides.
 */
export async function upsertUserChainExecutionSettings(
  scope: UserScope,
  input: UpsertUserChainExecutionSettingsInput
): Promise<UserChainExecutionSettings> {
  if (input.mode !== undefined && !USER_CHAIN_MODES.includes(input.mode)) {
    throw new InvalidExecutionSettingsError(
      `mode must be one of ${USER_CHAIN_MODES.join(', ')}, got ${input.mode}`
    );
  }
  if (input.mode === 'live') {
    assertTierMayExecuteLive(input.tier, input.tierExpiresAt, input.chain);
  }

  const setsSlippage = input.maxSlippageBps !== undefined;
  if (setsSlippage && input.maxSlippageBps !== null && !isValidSlippageBps(input.maxSlippageBps)) {
    // Bounds live in `slippage.ts` and are mirrored by chk_uces_max_slippage_bps.
    throw new InvalidExecutionSettingsError(
      `maxSlippageBps must be an integer in ${MIN_SLIPPAGE_BPS}..${MAX_SLIPPAGE_BPS} `
        + `or null, got ${input.maxSlippageBps}`
    );
  }

  return withTransaction(async (client) => {
    // Same reasoning as `upsertUserExecutionSettings`: the insert names no
    // defaulted column, so `mode`'s 'off' default is stated once, in `049`.
    await client.query(
      `INSERT INTO user_chain_execution_settings (user_id, chain) VALUES ($1, $2)
       ON CONFLICT (user_id, chain) DO NOTHING`,
      [scope.userId, input.chain]
    );
    const updated = await client.query<ChainSettingsRow>(
      `UPDATE user_chain_execution_settings
          SET mode             = COALESCE($3, mode),
              max_slippage_bps = CASE WHEN $4::boolean THEN $5::integer
                                      ELSE max_slippage_bps END,
              updated_at       = NOW()
        WHERE user_id = $1 AND chain = $2
        RETURNING ${CHAIN_SETTINGS_COLUMNS}`,
      [
        scope.userId,
        input.chain,
        input.mode ?? null,
        setsSlippage,
        input.maxSlippageBps ?? null
      ]
    );
    return toChainSettings(updated.rows[0]!);
  });
}

/**
 * The tolerance for one order, in bps.
 *
 * A thin adapter over `resolveSlippageBps` so the sizing path never has to reach
 * past a possibly-absent row: a user with no row for the chain, and a user whose
 * row holds `null`, both mean "use the chain default" and must resolve the same
 * way.
 */
export function resolveUserSlippageBps(
  chain: Chain,
  chainSettings: Pick<UserChainExecutionSettings, 'maxSlippageBps'> | null | undefined
): number {
  return resolveSlippageBps(chain, chainSettings?.maxSlippageBps ?? null);
}

/**
 * The mode the user is asking for on one chain, after their own kill switch.
 *
 * The kill switch is applied here rather than at each call site because a switch
 * that has to be remembered is not a switch. Absence of a row is `off`: a user who
 * has never configured a chain has not opted into trading it (D13).
 *
 * The platform gates are still above this — pass the result through
 * `resolveChainMode` before executing anything.
 */
export function requestedUserChainMode(
  settings: Pick<UserExecutionSettings, 'killed'>,
  chainSettings: Pick<UserChainExecutionSettings, 'mode'> | null | undefined
): UserChainMode {
  if (settings.killed) return 'off';
  return chainSettings?.mode ?? 'off';
}
