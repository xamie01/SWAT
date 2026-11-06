import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
/**
 * `../auth/plugin.js` — which is where the real `requireUser` lives, and using the
 * real one is the whole point of a tenancy test — statically imports `@swat/db`,
 * whose barrel throws `DATABASE_URL is required` while being evaluated. Hoisted so
 * it runs before that import, and `??=` so CI's real value is left alone. No query
 * is ever issued: every db function these routes call is injected, `pg` connects
 * lazily, and `client.ts` skips its shutdown handlers under NODE_ENV=test.
 */
vi.hoisted(() => {
    process.env.DATABASE_URL ??= 'postgres://swat:swat@127.0.0.1:5432/swat_route_tests';
});
import { missingDependenciesMessage, missingExecutionSettingsDependencies, registerExecutionSettingsRoutes, REQUIRED_DEPENDENCIES } from './execution-settings.js';
/**
 * Route tests for the per-user execution-settings surface.
 *
 * No Postgres and no Redis: `registerExecutionSettingsRoutes` takes its database
 * surface as an argument, so what is under test here is the auth guard, the
 * schemas, the tenancy of the scope and the error→status mapping. The db layer's
 * own arithmetic is covered by `packages/db/src/position-cap.test.ts` and
 * `user-execution-settings.test.ts`.
 *
 * The auth guard is the *real* `requireUser`. The fake below only populates
 * `request.principal`, which is what `registerAuth` does after resolving a session
 * cookie; the scope is then derived by `requireUser` itself, from
 * `principal.user.id`. That is the point: a test that stubbed `requireUser` would
 * prove nothing about tenancy.
 */
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
function storedSettings(overrides = {}) {
    return {
        autoExecute: false,
        minSignalScore: 80,
        maxPositionPct: 5,
        maxDailyExposurePct: 25,
        stopLossPct: 20,
        rebuyCooldownSeconds: 3600,
        maxDailyWithdrawalUsd: 1000,
        maxConcurrentPositions: 5,
        killed: false,
        persisted: true,
        updatedAt: new Date('2026-08-01T00:00:00.000Z'),
        ...overrides
    };
}
const chainRow = {
    chain: 'polygon',
    mode: 'paper',
    maxSlippageBps: 150,
    updatedAt: new Date('2026-08-01T00:00:00.000Z')
};
/**
 * `X-Test-User` stands in for a resolved session cookie, and `X-Test-Tier` for the
 * tier on that user's row. Both are read only inside the fake `onRequest` hook —
 * the handlers never see them, exactly as they never see a session token.
 */
async function harness(overrides = {}) {
    const deps = {
        getUserExecutionSettings: vi.fn(async () => storedSettings()),
        upsertUserExecutionSettings: vi.fn(async (_scope, patch) => storedSettings(patch)),
        setUserKillSwitch: vi.fn(async (_scope, killed) => storedSettings({ killed })),
        listUserChainExecutionSettings: vi.fn(async () => [chainRow]),
        upsertUserChainExecutionSettings: vi.fn(async (_scope, input) => ({
            ...chainRow,
            chain: input.chain,
            mode: input.mode ?? chainRow.mode,
            maxSlippageBps: 'maxSlippageBps' in input ? input.maxSlippageBps ?? null : chainRow.maxSlippageBps
        })),
        listUserBalances: vi.fn(async () => [
            { chain: 'polygon', usd: 100, fetchedAt: new Date() }
        ]),
        resolveKnownBalanceUsd: vi.fn((balances) => balances.reduce((total, balance) => (total === null || balance.usd === null ? null : total + balance.usd), 0)),
        assessPositionCap: vi.fn((input) => ({
            requestedCap: input.requestedCap,
            effectiveCap: Math.min(input.requestedCap, 50),
            clampedByCeiling: input.requestedCap > 50,
            clampedByFloor: false,
            ceiling: 50,
            warnings: [],
            unassessed: []
        })),
        ...overrides
    };
    const app = Fastify();
    app.decorateRequest('principal', undefined);
    app.addHook('onRequest', async (request) => {
        const header = request.headers['x-test-user'];
        const userId = Array.isArray(header) ? header[0] : header;
        if (!userId)
            return;
        const tierHeader = request.headers['x-test-tier'];
        const tier = (Array.isArray(tierHeader) ? tierHeader[0] : tierHeader) ?? 'free';
        request.principal = {
            kind: 'user',
            sessionId: 'session-1',
            user: {
                id: userId,
                tier,
                tierExpiresAt: null,
                role: 'user',
                status: 'active'
            }
        };
    });
    await registerExecutionSettingsRoutes(app, deps);
    return { app, deps };
}
describe('GET /v1/me/execution-settings', () => {
    it('composes the two tables and the derived cap assessment', async () => {
        const { app, deps } = await harness();
        const response = await app.inject({
            method: 'GET',
            url: '/v1/me/execution-settings',
            headers: { 'x-test-user': USER_A }
        });
        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.settings.maxConcurrentPositions).toBe(5);
        expect(body.chains).toHaveLength(1);
        expect(body.positionCap).toMatchObject({ requestedCap: 5, effectiveCap: 5, ceiling: 50 });
        expect(deps.getUserExecutionSettings).toHaveBeenCalledWith({ userId: USER_A });
        expect(deps.listUserChainExecutionSettings).toHaveBeenCalledWith({ userId: USER_A });
        await app.close();
    });
    it('rejects an unauthenticated caller and never touches the database', async () => {
        const { app, deps } = await harness();
        const response = await app.inject({ method: 'GET', url: '/v1/me/execution-settings' });
        expect(response.statusCode).toBe(401);
        expect(deps.getUserExecutionSettings).not.toHaveBeenCalled();
        await app.close();
    });
    it('returns null — not an empty warning list — when balances cannot be read', async () => {
        const { app } = await harness({
            listUserBalances: vi.fn(async () => {
                throw new Error('balance cache unavailable');
            })
        });
        const response = await app.inject({
            method: 'GET',
            url: '/v1/me/execution-settings',
            headers: { 'x-test-user': USER_A }
        });
        expect(response.statusCode).toBe(200);
        expect(response.json().positionCap).toBeNull();
        await app.close();
    });
});
describe('PATCH /v1/me/execution-settings', () => {
    it('stores the patch under the session scope', async () => {
        const { app, deps } = await harness();
        const response = await app.inject({
            method: 'PATCH',
            url: '/v1/me/execution-settings',
            headers: { 'x-test-user': USER_A },
            payload: { maxConcurrentPositions: 12, autoExecute: true }
        });
        expect(response.statusCode).toBe(200);
        expect(deps.upsertUserExecutionSettings).toHaveBeenCalledWith({ userId: USER_A }, { maxConcurrentPositions: 12, autoExecute: true });
        await app.close();
    });
    /**
     * THE cross-tenant test.
     *
     * A user id in the body is not merely ignored — the request is refused. Ignoring
     * it would also be safe today, but it would leave a caller believing the field
     * did something, and the next person to add a field to `patchSchema` would have
     * no failing test if they widened it. The assertion that matters is the second
     * one: whatever the body said, the scope handed to the db is the *session's*
     * user, so `upsertUserExecutionSettings` was never invoked for USER_B.
     */
    it('refuses a body that names another user and never writes their row', async () => {
        const { app, deps } = await harness();
        const response = await app.inject({
            method: 'PATCH',
            url: '/v1/me/execution-settings',
            headers: { 'x-test-user': USER_A },
            payload: { userId: USER_B, user_id: USER_B, maxConcurrentPositions: 3 }
        });
        expect(response.statusCode).toBe(400);
        expect(deps.upsertUserExecutionSettings).not.toHaveBeenCalled();
        // And the same on the read side: A's GET is scoped to A, never to B.
        const read = await app.inject({
            method: 'GET',
            url: '/v1/me/execution-settings',
            headers: { 'x-test-user': USER_A }
        });
        expect(read.statusCode).toBe(200);
        for (const call of deps.getUserExecutionSettings.mock.calls) {
            expect(call[0]).toEqual({ userId: USER_A });
        }
        await app.close();
    });
    it('scopes two different sessions to two different users', async () => {
        const { app, deps } = await harness();
        await app.inject({
            method: 'PATCH',
            url: '/v1/me/execution-settings',
            headers: { 'x-test-user': USER_A },
            payload: { stopLossPct: 10 }
        });
        await app.inject({
            method: 'PATCH',
            url: '/v1/me/execution-settings',
            headers: { 'x-test-user': USER_B },
            payload: { stopLossPct: 30 }
        });
        expect(deps.upsertUserExecutionSettings.mock.calls.map((call) => call[0])).toEqual([
            { userId: USER_A },
            { userId: USER_B }
        ]);
        await app.close();
    });
    it('refuses an unknown field rather than silently dropping it', async () => {
        const { app, deps } = await harness();
        const response = await app.inject({
            method: 'PATCH',
            url: '/v1/me/execution-settings',
            headers: { 'x-test-user': USER_A },
            payload: { maxPositionPCT: 90 }
        });
        expect(response.statusCode).toBe(400);
        expect(deps.upsertUserExecutionSettings).not.toHaveBeenCalled();
        await app.close();
    });
    it('points killed at the kill-switch route instead of accepting it', async () => {
        const { app, deps } = await harness();
        const response = await app.inject({
            method: 'PATCH',
            url: '/v1/me/execution-settings',
            headers: { 'x-test-user': USER_A },
            payload: { killed: true }
        });
        expect(response.statusCode).toBe(400);
        expect(response.json().message).toContain('/v1/me/execution-settings/kill-switch');
        expect(deps.upsertUserExecutionSettings).not.toHaveBeenCalled();
        await app.close();
    });
    it('refuses an empty patch so persisted cannot be forged', async () => {
        const { app, deps } = await harness();
        const response = await app.inject({
            method: 'PATCH',
            url: '/v1/me/execution-settings',
            headers: { 'x-test-user': USER_A },
            payload: {}
        });
        expect(response.statusCode).toBe(400);
        expect(deps.upsertUserExecutionSettings).not.toHaveBeenCalled();
        await app.close();
    });
    it('reports a clamped cap at the point of configuration (S4-M4, S6-25)', async () => {
        const { app } = await harness();
        const response = await app.inject({
            method: 'PATCH',
            url: '/v1/me/execution-settings',
            headers: { 'x-test-user': USER_A },
            payload: { maxConcurrentPositions: 500 }
        });
        expect(response.statusCode).toBe(200);
        expect(response.json().positionCap).toMatchObject({
            requestedCap: 500,
            effectiveCap: 50,
            clampedByCeiling: true
        });
        await app.close();
    });
    it('surfaces the derived below-minimum warning on the write response', async () => {
        const warning = {
            chain: 'polygon',
            code: 'cap-spreads-balance-below-venue-minimum',
            perPositionUsd: 2,
            minOrderNotionalUsd: 5,
            approximate: true,
            maxCapClearingMinimum: 20,
            message: 'below the ~$5 minimum order size'
        };
        const { app } = await harness({
            assessPositionCap: vi.fn(() => ({
                requestedCap: 50,
                effectiveCap: 50,
                clampedByCeiling: false,
                clampedByFloor: false,
                ceiling: 50,
                warnings: [warning],
                unassessed: [{ chain: 'solana', reason: 'no-venue-minimum' }]
            }))
        });
        const response = await app.inject({
            method: 'PATCH',
            url: '/v1/me/execution-settings',
            headers: { 'x-test-user': USER_A },
            payload: { maxConcurrentPositions: 50 }
        });
        expect(response.statusCode).toBe(200);
        expect(response.json().positionCap.warnings).toEqual([warning]);
        expect(response.json().positionCap.unassessed).toHaveLength(1);
        await app.close();
    });
});
describe('error mapping', () => {
    function thrower(name, message) {
        return vi.fn(async () => {
            const error = new Error(message);
            error.name = name;
            throw error;
        });
    }
    it('maps InvalidExecutionSettingsError to 400', async () => {
        const { app } = await harness({
            upsertUserExecutionSettings: thrower('InvalidExecutionSettingsError', 'stopLossPct must be a percentage in (0, 100], got 500')
        });
        const response = await app.inject({
            method: 'PATCH',
            url: '/v1/me/execution-settings',
            headers: { 'x-test-user': USER_A },
            payload: { stopLossPct: 500 }
        });
        expect(response.statusCode).toBe(400);
        expect(response.json().message).toContain('500');
        await app.close();
    });
    it('maps InvalidPositionCapError to 400', async () => {
        const { app } = await harness({
            upsertUserExecutionSettings: thrower('InvalidPositionCapError', 'maxConcurrentPositions must be an integer, got 2.5')
        });
        const response = await app.inject({
            method: 'PATCH',
            url: '/v1/me/execution-settings',
            headers: { 'x-test-user': USER_A },
            payload: { maxConcurrentPositions: 2.5 }
        });
        expect(response.statusCode).toBe(400);
        await app.close();
    });
    it('maps LiveExecutionNotEntitledError to 403', async () => {
        const { app } = await harness({
            upsertUserChainExecutionSettings: thrower('LiveExecutionNotEntitledError', 'Tier free may not enable live execution on polygon')
        });
        const response = await app.inject({
            method: 'PATCH',
            url: '/v1/me/execution-settings/chains/polygon',
            headers: { 'x-test-user': USER_A },
            payload: { mode: 'live' }
        });
        expect(response.statusCode).toBe(403);
        await app.close();
    });
    it('leaves an unrecognised failure as a 500', async () => {
        const { app } = await harness({
            upsertUserExecutionSettings: thrower('Error', 'connection terminated unexpectedly')
        });
        const response = await app.inject({
            method: 'PATCH',
            url: '/v1/me/execution-settings',
            headers: { 'x-test-user': USER_A },
            payload: { stopLossPct: 10 }
        });
        expect(response.statusCode).toBe(500);
        await app.close();
    });
});
describe('PUT /v1/me/execution-settings/kill-switch', () => {
    it('halts the session user and nobody else', async () => {
        const { app, deps } = await harness();
        const response = await app.inject({
            method: 'PUT',
            url: '/v1/me/execution-settings/kill-switch',
            headers: { 'x-test-user': USER_A },
            payload: { killed: true }
        });
        expect(response.statusCode).toBe(200);
        expect(response.json().settings.killed).toBe(true);
        expect(deps.setUserKillSwitch).toHaveBeenCalledWith({ userId: USER_A }, true);
        await app.close();
    });
    it('cannot be aimed at another user through the body', async () => {
        const { app, deps } = await harness();
        const response = await app.inject({
            method: 'PUT',
            url: '/v1/me/execution-settings/kill-switch',
            headers: { 'x-test-user': USER_A },
            payload: { killed: true, userId: USER_B }
        });
        expect(response.statusCode).toBe(400);
        expect(deps.setUserKillSwitch).not.toHaveBeenCalled();
        await app.close();
    });
    it('is unreachable without a session', async () => {
        const { app, deps } = await harness();
        const response = await app.inject({
            method: 'PUT',
            url: '/v1/me/execution-settings/kill-switch',
            payload: { killed: true }
        });
        expect(response.statusCode).toBe(401);
        expect(deps.setUserKillSwitch).not.toHaveBeenCalled();
        await app.close();
    });
    it('rejects a non-boolean without touching the switch', async () => {
        const { app, deps } = await harness();
        const response = await app.inject({
            method: 'PUT',
            url: '/v1/me/execution-settings/kill-switch',
            headers: { 'x-test-user': USER_A },
            payload: { killed: 'yes' }
        });
        expect(response.statusCode).toBe(400);
        expect(deps.setUserKillSwitch).not.toHaveBeenCalled();
        await app.close();
    });
});
describe('PATCH /v1/me/execution-settings/chains/:chain', () => {
    it('takes tier from the session, not the payload', async () => {
        const { app, deps } = await harness();
        const response = await app.inject({
            method: 'PATCH',
            url: '/v1/me/execution-settings/chains/polygon',
            headers: { 'x-test-user': USER_A, 'x-test-tier': 'free' },
            payload: { mode: 'live', tier: 'ultra' }
        });
        // `tier` in the body is an unknown key: refused, so it can never reach the
        // entitlement gate. A user cannot grant themselves live execution by typing a
        // tier.
        expect(response.statusCode).toBe(400);
        expect(deps.upsertUserChainExecutionSettings).not.toHaveBeenCalled();
        const clean = await app.inject({
            method: 'PATCH',
            url: '/v1/me/execution-settings/chains/polygon',
            headers: { 'x-test-user': USER_A, 'x-test-tier': 'free' },
            payload: { mode: 'live' }
        });
        expect(clean.statusCode).toBe(200);
        expect(deps.upsertUserChainExecutionSettings).toHaveBeenCalledWith({ userId: USER_A }, { chain: 'polygon', tier: 'free', tierExpiresAt: null, mode: 'live' });
        await app.close();
    });
    it('distinguishes clearing the slippage override from leaving it alone', async () => {
        const { app, deps } = await harness();
        await app.inject({
            method: 'PATCH',
            url: '/v1/me/execution-settings/chains/solana',
            headers: { 'x-test-user': USER_A },
            payload: { maxSlippageBps: null }
        });
        await app.inject({
            method: 'PATCH',
            url: '/v1/me/execution-settings/chains/solana',
            headers: { 'x-test-user': USER_A },
            payload: { mode: 'paper' }
        });
        const [cleared, untouched] = deps.upsertUserChainExecutionSettings.mock.calls;
        expect(cleared[1]).toEqual({
            chain: 'solana',
            tier: 'free',
            tierExpiresAt: null,
            maxSlippageBps: null
        });
        expect(untouched[1]).not.toHaveProperty('maxSlippageBps');
        await app.close();
    });
    it('rejects an unknown chain before it reaches SQL', async () => {
        const { app, deps } = await harness();
        const response = await app.inject({
            method: 'PATCH',
            url: '/v1/me/execution-settings/chains/fantom',
            headers: { 'x-test-user': USER_A },
            payload: { mode: 'paper' }
        });
        expect(response.statusCode).toBe(400);
        expect(deps.upsertUserChainExecutionSettings).not.toHaveBeenCalled();
        await app.close();
    });
    it('rejects an unknown mode', async () => {
        const { app, deps } = await harness();
        const response = await app.inject({
            method: 'PATCH',
            url: '/v1/me/execution-settings/chains/polygon',
            headers: { 'x-test-user': USER_A },
            payload: { mode: 'live+shadow' }
        });
        expect(response.statusCode).toBe(400);
        expect(deps.upsertUserChainExecutionSettings).not.toHaveBeenCalled();
        await app.close();
    });
    it('is unreachable without a session', async () => {
        const { app, deps } = await harness();
        const response = await app.inject({
            method: 'PATCH',
            url: '/v1/me/execution-settings/chains/polygon',
            payload: { mode: 'paper' }
        });
        expect(response.statusCode).toBe(401);
        expect(deps.upsertUserChainExecutionSettings).not.toHaveBeenCalled();
        await app.close();
    });
    it('does not let the kill-switch path fall through to the chain route', async () => {
        const { app, deps } = await harness();
        const response = await app.inject({
            method: 'PUT',
            url: '/v1/me/execution-settings/kill-switch',
            headers: { 'x-test-user': USER_A },
            payload: { killed: false }
        });
        expect(response.statusCode).toBe(200);
        expect(deps.upsertUserChainExecutionSettings).not.toHaveBeenCalled();
        expect(deps.setUserKillSwitch).toHaveBeenCalledWith({ userId: USER_A }, false);
        await app.close();
    });
});
describe('dependency resolution', () => {
    /**
     * Guards the packaging defect this whole module works around: `@swat/db` does not
     * re-export `./user-execution-settings.js` or `./user-balances.js` from its
     * barrel, so the wiring in `index.ts` must notice rather than serve routes whose
     * handlers call `undefined`.
     *
     * Tested through the pure predicate, not through `@swat/db` itself — importing
     * that barrel in a unit test throws `DATABASE_URL is required` before any
     * assertion could run, which is also why `resolveExecutionSettingsDependencies`
     * uses a dynamic import.
     */
    it('names every required export a namespace fails to provide', () => {
        expect(missingExecutionSettingsDependencies({})).toEqual([...REQUIRED_DEPENDENCIES]);
        const partial = Object.fromEntries(REQUIRED_DEPENDENCIES.filter((name) => name !== 'assessPositionCap').map((name) => [
            name,
            () => undefined
        ]));
        expect(missingExecutionSettingsDependencies(partial)).toEqual(['assessPositionCap']);
    });
    it('accepts a namespace that provides all of them', () => {
        const complete = Object.fromEntries(REQUIRED_DEPENDENCIES.map((name) => [name, () => undefined]));
        expect(missingExecutionSettingsDependencies(complete)).toEqual([]);
    });
    it('puts the exact fix in the message the 503 body carries', () => {
        const message = missingDependenciesMessage(['getUserExecutionSettings']);
        expect(message).toContain('packages/db/src/index.ts');
        expect(message).toContain("export * from './user-execution-settings.js';");
        expect(message).toContain('getUserExecutionSettings');
    });
});
describe('unwired deployment', () => {
    /**
     * When the db layer is missing, an authenticated caller gets a 503 that names the
     * fix — and an anonymous one still gets 401, so the 503 cannot be used to
     * enumerate which capabilities a deployment is missing.
     */
    it('answers 503 to a session and 401 to nobody', async () => {
        const app = Fastify();
        app.decorateRequest('principal', undefined);
        app.addHook('onRequest', async (request) => {
            const header = request.headers['x-test-user'];
            const userId = Array.isArray(header) ? header[0] : header;
            if (!userId)
                return;
            request.principal = {
                kind: 'user',
                sessionId: 'session-1',
                user: { id: userId, tier: 'free', tierExpiresAt: null, role: 'user', status: 'active' }
            };
        });
        await registerExecutionSettingsRoutes(app, {
            ok: false,
            missing: ['getUserExecutionSettings']
        });
        const anonymous = await app.inject({ method: 'GET', url: '/v1/me/execution-settings' });
        expect(anonymous.statusCode).toBe(401);
        const authenticated = await app.inject({
            method: 'GET',
            url: '/v1/me/execution-settings',
            headers: { 'x-test-user': USER_A }
        });
        expect(authenticated.statusCode).toBe(503);
        expect(authenticated.json().message).toContain('packages/db/src/index.ts');
        await app.close();
    });
});
//# sourceMappingURL=execution-settings.test.js.map