import type { FastifyInstance } from 'fastify';
import { type Chain } from '@swat/shared';
/**
 * Per-user execution settings over HTTP (`S4-M4`, `S6-24`, `S6-25`).
 *
 * `packages/db` has held the whole layer since migration `049` —
 * `getUserExecutionSettings`, `upsertUserExecutionSettings`, `setUserKillSwitch`,
 * `listUserChainExecutionSettings`, `upsertUserChainExecutionSettings` — with no
 * caller anywhere in the repo. Every field was unreachable, which made the
 * per-user concurrent-position cap a column nobody could set.
 *
 * ## Why a separate file rather than `routes/me.ts`
 *
 * `registerMeRoutes` takes two BullMQ queues in its options. Settings need
 * neither, and folding them in would mean a settings test had to construct queue
 * plumbing to reach a validator. The split is along the dependency seam, not the
 * URL: these routes still live under `/v1/me/`, so the `USER_REACHABLE_PREFIXES`
 * allowlist in `auth/plugin.ts` already admits them and `registerAdminOnlyGlobals`
 * does not have to learn a new prefix.
 *
 * ## Why the db functions arrive as an argument
 *
 * `ExecutionSettingsDependencies` is the entire database surface these handlers
 * touch, injected. Two reasons, and the second is not hypothetical:
 *
 *   1. The route tests then exercise the real auth guard, the real zod schemas and
 *      the real status mapping with no Postgres and no Redis. A static
 *      `import … from '@swat/db'` is not free in a test: `@swat/db`'s barrel
 *      evaluates `client.ts`, which throws `DATABASE_URL is required` at import
 *      time. So the seam is what makes these routes testable at all.
 *   2. **`@swat/db` does not export this layer.** `packages/db/src/index.ts`
 *      re-exports `./position-cap.js` but *not* `./user-execution-settings.js` and
 *      *not* `./user-balances.js`; the built `packages/db/dist/index.d.ts` is older
 *      still and has no `position-cap` either. So
 *      `import { getUserExecutionSettings } from '@swat/db'` neither type-checks
 *      nor resolves today. `resolveExecutionSettingsDependencies` looks the
 *      functions up by name at boot and reports precisely which are missing; see
 *      its doc comment for what happens then.
 */
/** Mirrors `UserExecutionSettings` in `packages/db/src/user-execution-settings.ts`. */
export interface StoredExecutionSettings {
    readonly autoExecute: boolean;
    readonly minSignalScore: number;
    readonly maxPositionPct: number;
    readonly maxDailyExposurePct: number;
    readonly stopLossPct: number;
    readonly rebuyCooldownSeconds: number;
    readonly maxDailyWithdrawalUsd: number;
    readonly maxConcurrentPositions: number;
    readonly killed: boolean;
    readonly persisted: boolean;
    readonly updatedAt: Date | null;
}
/** Mirrors `UserChainExecutionSettings`. */
export interface StoredChainExecutionSettings {
    readonly chain: Chain;
    readonly mode: 'off' | 'paper' | 'live';
    readonly maxSlippageBps: number | null;
    readonly updatedAt: Date;
}
/**
 * The subset of `UserBalance` this route reads.
 *
 * Deliberately not the whole record: the rows are grouped by chain and handed
 * straight back to `resolveKnownBalanceUsd`, which is the only thing allowed to
 * decide whether a set of rows adds up to a number the caller may use.
 */
export interface StoredBalance {
    readonly chain: Chain;
    readonly usd: number | null;
    readonly fetchedAt: Date;
}
/** Mirrors `PositionCapAssessment` in `packages/db/src/position-cap.ts`. */
export interface PositionCapAssessmentLike {
    readonly requestedCap: number;
    readonly effectiveCap: number;
    readonly clampedByCeiling: boolean;
    readonly clampedByFloor: boolean;
    readonly ceiling: number;
    readonly warnings: readonly unknown[];
    readonly unassessed: readonly unknown[];
}
export interface ExecutionSettingsPatchInput {
    readonly autoExecute?: boolean;
    readonly minSignalScore?: number;
    readonly maxPositionPct?: number;
    readonly maxDailyExposurePct?: number;
    readonly stopLossPct?: number;
    readonly rebuyCooldownSeconds?: number;
    readonly maxDailyWithdrawalUsd?: number;
    readonly maxConcurrentPositions?: number;
}
export interface ChainExecutionSettingsInput {
    readonly chain: Chain;
    readonly mode?: 'off' | 'paper' | 'live';
    readonly maxSlippageBps?: number | null;
    /** From the session's user row. Never from a payload. */
    readonly tier: string;
    readonly tierExpiresAt: Date | null;
}
/**
 * A `UserScope`, structurally.
 *
 * Declared here rather than imported so this module compiles against the current
 * `@swat/db` build. The scope handed to every function below still comes from
 * `requireUser`, i.e. from `forUser()`, which is the only constructor for a real
 * `UserScope`.
 */
export interface ScopeLike {
    readonly userId: string;
}
export interface ExecutionSettingsDependencies {
    readonly getUserExecutionSettings: (scope: ScopeLike) => Promise<StoredExecutionSettings>;
    readonly upsertUserExecutionSettings: (scope: ScopeLike, patch: ExecutionSettingsPatchInput) => Promise<StoredExecutionSettings>;
    readonly setUserKillSwitch: (scope: ScopeLike, killed: boolean) => Promise<StoredExecutionSettings>;
    readonly listUserChainExecutionSettings: (scope: ScopeLike) => Promise<readonly StoredChainExecutionSettings[]>;
    readonly upsertUserChainExecutionSettings: (scope: ScopeLike, input: ChainExecutionSettingsInput) => Promise<StoredChainExecutionSettings>;
    readonly listUserBalances: (scope: ScopeLike) => Promise<readonly StoredBalance[]>;
    readonly resolveKnownBalanceUsd: (balances: readonly StoredBalance[]) => number | null;
    readonly assessPositionCap: (input: {
        readonly requestedCap: number;
        readonly balancesUsd: Partial<Readonly<Record<Chain, number | null>>>;
        readonly maxPositionPct: number;
    }) => PositionCapAssessmentLike;
}
/**
 * Every name this module needs out of `@swat/db`.
 *
 * A list rather than eight destructured imports because the barrel does not carry
 * them yet — see the module comment. Each one is verified to exist in
 * `packages/db/src`:
 * `getUserExecutionSettings`, `upsertUserExecutionSettings`, `setUserKillSwitch`,
 * `listUserChainExecutionSettings`, `upsertUserChainExecutionSettings` in
 * `user-execution-settings.ts`; `listUserBalances`, `resolveKnownBalanceUsd` in
 * `user-balances.ts`; `assessPositionCap` in `position-cap.ts`.
 */
export declare const REQUIRED_DEPENDENCIES: readonly ["getUserExecutionSettings", "upsertUserExecutionSettings", "setUserKillSwitch", "listUserChainExecutionSettings", "upsertUserChainExecutionSettings", "listUserBalances", "resolveKnownBalanceUsd", "assessPositionCap"];
/**
 * Which of `REQUIRED_DEPENDENCIES` a module namespace does not provide as a
 * function.
 *
 * Pure and exported so it is testable without importing `@swat/db` — which cannot
 * be imported in a unit test at all, since its barrel throws
 * `DATABASE_URL is required` on evaluation.
 */
export declare function missingExecutionSettingsDependencies(namespace: Readonly<Record<string, unknown>>): readonly string[];
export type ResolvedExecutionSettingsDependencies = {
    readonly ok: true;
    readonly dependencies: ExecutionSettingsDependencies;
} | {
    readonly ok: false;
    readonly missing: readonly string[];
};
/**
 * What `registerExecutionSettingsRoutes` accepts in place of resolving `@swat/db`
 * itself: either the dependencies, or an already-resolved result.
 *
 * The second arm exists so the unwired-deployment behaviour (503, not 500) is
 * testable deterministically. Asserting it through the real resolver would make
 * the test pass only for as long as the barrel stays broken, and silently invert
 * the day somebody fixes it.
 */
export type ExecutionSettingsWiring = ExecutionSettingsDependencies | ResolvedExecutionSettingsDependencies;
/**
 * Human-readable instruction for the packaging defect, used in the boot log and
 * in the 503 body so whoever sees either knows the exact fix.
 */
export declare function missingDependenciesMessage(missing: readonly string[]): string;
/**
 * Picks the real db functions out of `@swat/db` by name.
 *
 * Three deliberate choices here, all forced by the same defect:
 *
 *   * **A dynamic `import()`, not a static one.** A static import would evaluate
 *     `client.ts` in every test that so much as touches this file. `index.ts`
 *     already imports `@swat/db` statically, so at boot this is a module-cache hit
 *     and costs nothing.
 *   * **Looked up through a `Record<string, unknown>` view.** Three of the eight
 *     names are absent from the barrel, so a named import or a `db.assessPositionCap`
 *     member access would be a compile error. This is neither, and it still cannot
 *     ship a silently broken route because every name is checked.
 *   * **Returns a result, does not throw.** The alternative — refusing to boot —
 *     would take the whole control plane down over a settings feature. The repo
 *     reserves boot-time refusal for security invariants (`API_KEY` in production);
 *     a missing barrel export is not one. So the failure is confined to these four
 *     routes, which answer 503 with the fix in the body, and is logged loudly once
 *     at registration. What is NOT acceptable, and what this exists to prevent, is
 *     a route that calls `undefined` and returns 500 while looking like a bug in
 *     this file.
 *
 * Delete this and use named imports once the barrel carries the two modules.
 */
export declare function resolveExecutionSettingsDependencies(): Promise<ResolvedExecutionSettingsDependencies>;
/**
 * Maps a db-layer validation error to a status code, by `name`.
 *
 * By `name` rather than `instanceof` because both error classes can exist twice in
 * one process while the barrel is incomplete — a class reached through a deep
 * import is not the class reached through the package root, and `instanceof` across
 * the two is false. Both classes set `this.name` explicitly, so the name is the
 * stable discriminator, and it keeps this module free of an import it cannot make.
 *
 * `InvalidExecutionSettingsError` and `InvalidPositionCapError` are **400**: a user
 * asking for 500 concurrent positions or a 150% stop loss has made a bad request,
 * not triggered a server fault. `LiveExecutionNotEntitledError` is **403** — the
 * request is well formed and the answer is still no. Anything else is rethrown so
 * Fastify turns it into a 500; reporting an unknown failure as a 400 would tell the
 * user their input was wrong and leave them retyping a valid value forever.
 */
export declare function settingsErrorStatus(error: unknown): 400 | 403 | null;
export declare function registerExecutionSettingsRoutes(app: FastifyInstance, wiring?: ExecutionSettingsWiring): Promise<void>;
//# sourceMappingURL=execution-settings.d.ts.map