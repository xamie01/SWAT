import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { chainSchema, type Chain } from '@swat/shared';
import { requireUser } from '../auth/plugin.js';

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
  readonly upsertUserExecutionSettings: (
    scope: ScopeLike,
    patch: ExecutionSettingsPatchInput
  ) => Promise<StoredExecutionSettings>;
  readonly setUserKillSwitch: (
    scope: ScopeLike,
    killed: boolean
  ) => Promise<StoredExecutionSettings>;
  readonly listUserChainExecutionSettings: (
    scope: ScopeLike
  ) => Promise<readonly StoredChainExecutionSettings[]>;
  readonly upsertUserChainExecutionSettings: (
    scope: ScopeLike,
    input: ChainExecutionSettingsInput
  ) => Promise<StoredChainExecutionSettings>;
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
export const REQUIRED_DEPENDENCIES = [
  'getUserExecutionSettings',
  'upsertUserExecutionSettings',
  'setUserKillSwitch',
  'listUserChainExecutionSettings',
  'upsertUserChainExecutionSettings',
  'listUserBalances',
  'resolveKnownBalanceUsd',
  'assessPositionCap'
] as const;

/**
 * Which of `REQUIRED_DEPENDENCIES` a module namespace does not provide as a
 * function.
 *
 * Pure and exported so it is testable without importing `@swat/db` — which cannot
 * be imported in a unit test at all, since its barrel throws
 * `DATABASE_URL is required` on evaluation.
 */
export function missingExecutionSettingsDependencies(
  namespace: Readonly<Record<string, unknown>>
): readonly string[] {
  return REQUIRED_DEPENDENCIES.filter((name) => typeof namespace[name] !== 'function');
}

export type ResolvedExecutionSettingsDependencies =
  | { readonly ok: true; readonly dependencies: ExecutionSettingsDependencies }
  | { readonly ok: false; readonly missing: readonly string[] };

/**
 * What `registerExecutionSettingsRoutes` accepts in place of resolving `@swat/db`
 * itself: either the dependencies, or an already-resolved result.
 *
 * The second arm exists so the unwired-deployment behaviour (503, not 500) is
 * testable deterministically. Asserting it through the real resolver would make
 * the test pass only for as long as the barrel stays broken, and silently invert
 * the day somebody fixes it.
 */
export type ExecutionSettingsWiring =
  | ExecutionSettingsDependencies
  | ResolvedExecutionSettingsDependencies;

function normaliseWiring(
  wiring: ExecutionSettingsWiring
): ResolvedExecutionSettingsDependencies {
  // `ExecutionSettingsDependencies` has no `ok`, so the key is an unambiguous tag.
  return 'ok' in wiring ? wiring : { ok: true, dependencies: wiring };
}

/**
 * Human-readable instruction for the packaging defect, used in the boot log and
 * in the 503 body so whoever sees either knows the exact fix.
 */
export function missingDependenciesMessage(missing: readonly string[]): string {
  return (
    `@swat/db does not export ${missing.join(', ')}. `
    + "Add `export * from './user-execution-settings.js';` and "
    + "`export * from './user-balances.js';` to packages/db/src/index.ts, "
    + 'then rebuild @swat/db.'
  );
}

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
export async function resolveExecutionSettingsDependencies(): Promise<
  ResolvedExecutionSettingsDependencies
> {
  const namespace = (await import('@swat/db')) as unknown as Record<string, unknown>;
  const missing = missingExecutionSettingsDependencies(namespace);
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, dependencies: namespace as unknown as ExecutionSettingsDependencies };
}

/**
 * The global patch schema.
 *
 * `.strict()` on purpose. A settings PATCH is the one place where an ignored
 * unknown key is actively dangerous: `maxPositionPCT: 1` would be silently
 * dropped and the user told their risk limit had been saved. Rejecting the body is
 * the only answer that cannot mislead — and it is also what closes the
 * `"userId": "<someone else>"` shape, which is refused rather than merely ignored.
 *
 * Bounds are deliberately NOT restated here. `assertValidExecutionSettingsPatch`
 * in `packages/db` owns them, mirrored by the column CHECKs in `049`, and a second
 * copy would drift. What this schema owns is *types*: a string where a number
 * belongs must not reach SQL.
 *
 * **`killed` is deliberately absent.** See the kill-switch route.
 */
const patchSchema = z
  .object({
    autoExecute: z.boolean().optional(),
    minSignalScore: z.number().optional(),
    maxPositionPct: z.number().optional(),
    maxDailyExposurePct: z.number().optional(),
    stopLossPct: z.number().optional(),
    rebuyCooldownSeconds: z.number().optional(),
    maxDailyWithdrawalUsd: z.number().optional(),
    maxConcurrentPositions: z.number().optional()
  })
  .strict();

const killSwitchSchema = z.object({ killed: z.boolean() }).strict();

const chainPatchSchema = z
  .object({
    mode: z.enum(['off', 'paper', 'live']).optional(),
    // `.nullable()` AND `.optional()`, because the column distinguishes them:
    // `null` clears the override back to the chain default, an absent key leaves
    // the stored value alone. Collapsing the two would make "use the default" and
    // "don't touch it" the same request.
    maxSlippageBps: z.number().int().nullable().optional()
  })
  .strict();

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
export function settingsErrorStatus(error: unknown): 400 | 403 | null {
  if (!(error instanceof Error)) return null;
  if (error.name === 'InvalidExecutionSettingsError') return 400;
  if (error.name === 'InvalidPositionCapError') return 400;
  if (error.name === 'LiveExecutionNotEntitledError') return 403;
  return null;
}

function sendSettingsError(reply: FastifyReply, error: unknown): FastifyReply {
  const status = settingsErrorStatus(error);
  if (status === null) throw error;
  const message = error instanceof Error ? error.message : 'Invalid request';
  return reply
    .code(status)
    .send({ error: status === 400 ? 'Bad Request' : 'Forbidden', message });
}

/**
 * Per-chain USD totals for `assessPositionCap`.
 *
 * Grouped here, summed by `resolveKnownBalanceUsd`, which returns `null` on any
 * stale or unpriced row rather than a partial total. A chain absent from the result
 * is *unknown* to the assessment and lands in its `unassessed` list. The one thing
 * that must never happen is an unknown balance reading as a passing check.
 */
function balancesUsdByChain(
  deps: ExecutionSettingsDependencies,
  balances: readonly StoredBalance[]
): Partial<Record<Chain, number | null>> {
  const grouped = new Map<Chain, StoredBalance[]>();
  for (const balance of balances) {
    const existing = grouped.get(balance.chain);
    if (existing) existing.push(balance);
    else grouped.set(balance.chain, [balance]);
  }
  const result: Partial<Record<Chain, number | null>> = {};
  for (const [chain, rows] of grouped) {
    result[chain] = deps.resolveKnownBalanceUsd(rows);
  }
  return result;
}

/**
 * The derived cap warning (`S4-M4`, `S6-25`), returned at the point of
 * configuration rather than discovered later in a skip reason.
 *
 * `null` means **not assessed**, never "assessed and fine" — the caller renders
 * nothing rather than a reassuring absence of warnings. Degrading to `null` instead
 * of propagating is deliberate for exactly one class of failure, the balance cache:
 * the warning is advisory by construction, so a settings page that will not render
 * because `user_balances` hiccuped is strictly worse than one that renders without
 * the hint. The failure is logged.
 */
async function assessStoredCap(
  deps: ExecutionSettingsDependencies,
  scope: ScopeLike,
  settings: StoredExecutionSettings,
  requestedCap: number,
  log: { warn: (obj: unknown, message: string) => void }
): Promise<PositionCapAssessmentLike | null> {
  try {
    const balances = await deps.listUserBalances(scope);
    return deps.assessPositionCap({
      requestedCap,
      balancesUsd: balancesUsdByChain(deps, balances),
      maxPositionPct: settings.maxPositionPct
    });
  } catch (error) {
    log.warn({ err: error }, 'position cap assessment unavailable');
    return null;
  }
}

export async function registerExecutionSettingsRoutes(
  app: FastifyInstance,
  wiring?: ExecutionSettingsWiring
): Promise<void> {
  const resolved = wiring
    ? normaliseWiring(wiring)
    : await resolveExecutionSettingsDependencies();
  const deps: ExecutionSettingsDependencies | null = resolved.ok ? resolved.dependencies : null;
  const unavailable = resolved.ok ? null : missingDependenciesMessage(resolved.missing);
  if (unavailable) app.log.error({ missing: resolved.ok ? [] : resolved.missing }, unavailable);

  /**
   * Asserts the db layer is actually wired.
   *
   * Called *after* `requireUser` in every handler, so an anonymous caller gets 401
   * rather than a 503 that discloses which capabilities this deployment is missing.
   */
  function available(reply: FastifyReply): ExecutionSettingsDependencies | null {
    if (deps) return deps;
    reply.code(503).send({ error: 'Service Unavailable', message: unavailable });
    return null;
  }

  /**
   * Global settings, per-chain rows and the derived cap warning in one response.
   *
   * Two reads, never a join. `user_execution_settings` and
   * `user_chain_execution_settings` are separate tables read separately on purpose
   * — the fan-out enumeration wants the per-chain rows for many users while the
   * withdrawal path wants one user's caps — so they are composed here, at the one
   * caller that genuinely needs both, rather than joined in SQL where every other
   * caller would start paying for the other table's columns.
   */
  app.get('/v1/me/execution-settings', async (request, reply) => {
    const scope = requireUser(request, reply);
    if (!scope) return;
    const wired = available(reply);
    if (!wired) return;
    const [settings, chains] = await Promise.all([
      wired.getUserExecutionSettings(scope),
      wired.listUserChainExecutionSettings(scope)
    ]);
    const positionCap = await assessStoredCap(
      wired,
      scope,
      settings,
      settings.maxConcurrentPositions,
      request.log
    );
    return reply.send({ settings, chains, positionCap });
  });

  /**
   * Patches the global row.
   *
   * An **empty body is a 400**, not a no-op. The insert side of
   * `upsertUserExecutionSettings` creates the row, which flips `persisted` to true
   * — and `persisted` is the evidence that the user explicitly accepted these
   * limits (D13). A `PATCH {}` would manufacture that evidence without the user
   * having chosen anything.
   *
   * The response re-assesses the cap against the value the *request* asked for, so
   * `clampedByCeiling` / `clampedByFloor` are meaningful: a user who typed 500 is
   * told the stored value is 50, and why, at the slider — instead of finding out
   * from a skip reason days later.
   */
  app.patch('/v1/me/execution-settings', async (request, reply) => {
    const scope = requireUser(request, reply);
    if (!scope) return;
    const principal = request.principal;
    const wired = available(reply);
    if (!wired) return;

    const parsed = patchSchema.safeParse(request.body);
    if (!parsed.success) {
      const namedKilled =
        typeof request.body === 'object'
        && request.body !== null
        && 'killed' in (request.body as Record<string, unknown>);
      return reply.code(400).send({
        error: 'Bad Request',
        message: namedKilled
          ? 'killed is set through PUT /v1/me/execution-settings/kill-switch'
          : 'Invalid execution settings payload',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message
        }))
      });
    }
    if (Object.keys(parsed.data).length === 0) {
      return reply
        .code(400)
        .send({ error: 'Bad Request', message: 'No execution settings fields supplied' });
    }

    // API-08: Raising maxDailyWithdrawalUsd requires administrator role
    if (parsed.data.maxDailyWithdrawalUsd !== undefined) {
      const current = await wired.getUserExecutionSettings(scope);
      if (parsed.data.maxDailyWithdrawalUsd > (current.maxDailyWithdrawalUsd ?? 0)) {
        if (principal?.kind !== 'user' || principal.user.role !== 'admin') {
          return reply.code(403).send({
            error: 'Forbidden',
            message: 'Only administrators can increase the maximum daily withdrawal ceiling.'
          });
        }
      }
    }

    let settings: StoredExecutionSettings;
    try {
      settings = await wired.upsertUserExecutionSettings(scope, parsed.data);
    } catch (error) {
      return sendSettingsError(reply, error);
    }

    const positionCap = await assessStoredCap(
      wired,
      scope,
      settings,
      parsed.data.maxConcurrentPositions ?? settings.maxConcurrentPositions,
      request.log
    );
    return reply.send({ settings, positionCap });
  });

  /**
   * The per-user kill switch (`S6-8`), on its own path.
   *
   * It gets its own endpoint for the same reason it gets its own db helper: "stop
   * everything now" must not be able to fail on an unrelated field's validation.
   * Folded into the global PATCH, a body of
   * `{ killed: true, maxPositionPct: 150 }` returns 400 with nothing stopped —
   * precisely the outcome `setUserKillSwitch` exists to make impossible. So
   * `killed` is excluded from `patchSchema` and a body naming it is refused with a
   * pointer here; there is exactly one way to halt an account, and it validates one
   * boolean.
   *
   * `PUT`, not `POST`: the request states the desired state and is idempotent, so a
   * client retrying after a timeout cannot toggle the switch back on.
   *
   * Registered before `/chains/:chain`. The two do not actually collide, but the
   * house rule here is static-before-parameterised (see `/v1/signals/stats` in
   * `index.ts`), and a later `:something` sibling under this prefix would shadow
   * this path.
   */
  app.put('/v1/me/execution-settings/kill-switch', async (request, reply) => {
    const scope = requireUser(request, reply);
    if (!scope) return;
    const wired = available(reply);
    if (!wired) return;
    const parsed = killSwitchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'Bad Request', message: 'Body must be exactly { killed: boolean }' });
    }
    try {
      const settings = await wired.setUserKillSwitch(scope, parsed.data.killed);
      return reply.send({ settings });
    } catch (error) {
      return sendSettingsError(reply, error);
    }
  });

  /**
   * Patches one chain's mode and slippage override.
   *
   * The chain comes from the path and is validated against `chainSchema` rather
   * than trusted — it reaches a `VARCHAR(32)` guarded by `chk_uces_chain`, and an
   * unvalidated value would surface as a 23514 naming a constraint the caller has
   * never heard of.
   *
   * `tier` and `tierExpiresAt` come from `request.principal.user`, never from the
   * body: they are the *entitlement* the live-mode gate reads, so accepting them
   * from a payload would let any user grant themselves live execution by typing
   * `"tier": "ultra"`. `.strict()` refuses such a body outright rather than
   * quietly dropping the key. Storing `live` is still only a request —
   * `resolveChainMode` clamps it against `LIVE_ENABLED_CHAINS` and the chain
   * certification before anything executes.
   */
  const handleChainSettings = async (request: FastifyRequest, reply: FastifyReply) => {
    const scope = requireUser(request, reply);
    if (!scope) return;
    const principal = request.principal;
    if (principal?.kind !== 'user') return reply.code(401).send({ error: 'Unauthorized' });
    const wired = available(reply);
    if (!wired) return;

    const chainParsed = chainSchema.safeParse((request.params as { chain?: unknown }).chain);
    if (!chainParsed.success) {
      return reply.code(400).send({ error: 'Bad Request', message: 'Unknown chain' });
    }
    const bodyParsed = chainPatchSchema.safeParse(request.body ?? {});
    if (!bodyParsed.success) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: 'Invalid chain execution settings payload',
        issues: bodyParsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message
        }))
      });
    }
    if (Object.keys(bodyParsed.data).length === 0) {
      return reply
        .code(400)
        .send({ error: 'Bad Request', message: 'No chain execution settings fields supplied' });
    }

    // Built key-by-key rather than spread, because `upsertUserChainExecutionSettings`
    // reads `maxSlippageBps !== undefined` to tell "clear the override" (`null`)
    // from "leave it alone" (absent). A spread of a parsed object that happened to
    // carry an explicit `undefined` would collapse the two.
    const input: {
      chain: Chain;
      tier: string;
      tierExpiresAt: Date | null;
      mode?: 'off' | 'paper' | 'live';
      maxSlippageBps?: number | null;
    } = {
      chain: chainParsed.data,
      tier: principal.user.tier,
      tierExpiresAt: principal.user.tierExpiresAt
    };
    if (bodyParsed.data.mode !== undefined) input.mode = bodyParsed.data.mode;
    if ('maxSlippageBps' in bodyParsed.data) {
      input.maxSlippageBps = bodyParsed.data.maxSlippageBps ?? null;
    }

    try {
      const chain = await wired.upsertUserChainExecutionSettings(scope, input);
      return reply.send({ chain });
    } catch (error) {
      return sendSettingsError(reply, error);
    }
  };

  app.patch('/v1/me/execution-settings/chains/:chain', handleChainSettings);
  app.put('/v1/me/execution-settings/chains/:chain', handleChainSettings);
}
