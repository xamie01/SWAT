import { type Chain, type UserTier } from '@swat/shared';
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
export declare const USER_CHAIN_MODES: readonly UserChainMode[];
/** Matches the seeded `signals.auto_execute_min_score` in `001_init.sql`. */
export declare const DEFAULT_MIN_SIGNAL_SCORE = 80;
/** 3600s == the 60-minute `REBUY_COOLDOWN_MINUTES` default the operator path uses. */
export declare const DEFAULT_REBUY_COOLDOWN_SECONDS = 3600;
/**
 * Deliberately low (D11). Raising a user's cap is an audited admin action, which
 * is why the value lives on the row rather than in a constant — but a *new* user
 * still needs a number, and this is it.
 */
export declare const DEFAULT_MAX_DAILY_WITHDRAWAL_USD = 1000;
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
export declare const DEFAULT_USER_EXECUTION_SETTINGS: UserExecutionSettings;
export interface UserChainExecutionSettings {
    readonly chain: Chain;
    readonly mode: UserChainMode;
    /** `null` means "use the chain default" — see `resolveUserSlippageBps`. */
    readonly maxSlippageBps: number | null;
    readonly updatedAt: Date;
}
/**
 * A requested setting is out of range or internally inconsistent.
 *
 * Distinct from a generic error so the API maps it to 400: every case is a
 * malformed request, not a server fault. Compare `LiveExecutionNotEntitledError`,
 * which is a 403 — the request is well formed and the answer is still no.
 */
export declare class InvalidExecutionSettingsError extends Error {
    constructor(message: string);
}
/** The user's tier does not permit live execution on this chain. Maps to 403. */
export declare class LiveExecutionNotEntitledError extends Error {
    readonly tier: UserTier;
    readonly chain: Chain;
    constructor(tier: UserTier, chain: Chain);
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
export declare function tierMayExecuteLive(tier: UserTier, tierExpiresAt: Date | null, chain: Chain, now?: Date): boolean;
export declare function assertTierMayExecuteLive(tier: UserTier, tierExpiresAt: Date | null, chain: Chain, now?: Date): void;
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
export declare function assertValidExecutionSettingsPatch(patch: UserExecutionSettingsPatch): void;
/**
 * One user's settings, or the defaults when no row exists.
 *
 * Never null. See the module note: a nullable return would put `?? defaults` at
 * every call site and the one that forgot would size against `undefined`.
 */ export declare function getUserExecutionSettings(scope: UserScope): Promise<UserExecutionSettings>;
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
export declare function upsertUserExecutionSettings(scope: UserScope, patch: UserExecutionSettingsPatch): Promise<UserExecutionSettings>;
/**
 * Sets the per-user kill switch in one write.
 *
 * Separate from `upsertUserExecutionSettings` because "stop everything now" must
 * not be able to fail on an unrelated field's validation, and because it has to be
 * greppable in the audit log as one event rather than as a settings patch that
 * happened to include `killed`. It is deliberately *not* derived from setting every
 * chain to `off`: the switch must survive the user later re-enabling one chain.
 */
export declare function setUserKillSwitch(scope: UserScope, killed: boolean): Promise<UserExecutionSettings>;
export declare function listUserChainExecutionSettings(scope: UserScope): Promise<UserChainExecutionSettings[]>;
/** One chain's row, or null when the user has never touched that chain. */
export declare function getUserChainExecutionSettings(scope: UserScope, chain: Chain): Promise<UserChainExecutionSettings | null>;
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
export declare function upsertUserChainExecutionSettings(scope: UserScope, input: UpsertUserChainExecutionSettingsInput): Promise<UserChainExecutionSettings>;
/**
 * The tolerance for one order, in bps.
 *
 * A thin adapter over `resolveSlippageBps` so the sizing path never has to reach
 * past a possibly-absent row: a user with no row for the chain, and a user whose
 * row holds `null`, both mean "use the chain default" and must resolve the same
 * way.
 */
export declare function resolveUserSlippageBps(chain: Chain, chainSettings: Pick<UserChainExecutionSettings, 'maxSlippageBps'> | null | undefined): number;
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
export declare function requestedUserChainMode(settings: Pick<UserExecutionSettings, 'killed'>, chainSettings: Pick<UserChainExecutionSettings, 'mode'> | null | undefined): UserChainMode;
//# sourceMappingURL=user-execution-settings.d.ts.map