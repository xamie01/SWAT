import Fastify from 'fastify';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn(), clientQuery: vi.fn(), release: vi.fn() }));
vi.mock('./client.js', () => ({ query: mocks.query, pool: { connect: async () => ({
  query: mocks.clientQuery, release: mocks.release, on: vi.fn(), off: vi.fn()
}) } }));
vi.mock('./tenancy.js', async () => {
  const actual = await vi.importActual<typeof import('./tenancy.js')>('./tenancy.js');
  const { withTransaction } = await import('./transaction.js');
  return {
    ...actual,
    scopedQuery: async (_scope: unknown, text: string, values?: unknown[]) => mocks.query(text, values),
    withTenantTransaction: async (_scope: unknown, op: (client: any) => Promise<any>, options?: any) =>
      withTransaction(op, options)
  };
});
vi.mock('@swat/db', () => ({ forUser: (userId: string) => ({ userId }), findUserById: vi.fn(), resolveSession: vi.fn() }));
import { upsertUserExecutionSettings, setUserKillSwitch } from './user-execution-settings.js';
import { registerExecutionSettingsRoutes, type ExecutionSettingsDependencies } from '../../../apps/api/src/routes/execution-settings.js';

const scope = { userId: '11111111-1111-4111-8111-111111111111' } as any;
const servers: ReturnType<typeof Fastify>[] = [];
let stored: any;
let working: any;
let audits: any[][];
let pendingAudits: any[][];
function row() {
  return { auto_execute: false, min_signal_score: 80, max_position_pct: 5,
    max_daily_exposure_pct: 25, stop_loss_pct: 20, rebuy_cooldown_seconds: 3600,
    max_daily_withdrawal_usd: 400, max_concurrent_positions: 5, killed: false,
    updated_at: new Date('2026-01-01') };
}
beforeEach(() => {
  vi.clearAllMocks(); stored = row(); audits = []; pendingAudits = [];
  mocks.query.mockRejectedValue(new Error('global query must not be used'));
  mocks.clientQuery.mockImplementation(async (sql: string, values: any[] = []) => {
    if (sql === 'BEGIN') { working = { ...stored }; pendingAudits = []; return { rows: [] }; }
    if (sql === 'COMMIT') { stored = { ...working }; audits.push(...pendingAudits); return { rows: [], command: 'COMMIT' }; }
    if (sql === 'ROLLBACK') { working = { ...stored }; pendingAudits = []; return { rows: [] }; }
    if (sql.includes('INSERT INTO audit_log')) { pendingAudits.push(values); return { rows: [], rowCount: 1 }; }
    if (sql.includes('FOR UPDATE')) return { rows: [{ ...working }] };
    if (sql.includes('INSERT INTO user_execution_settings (user_id, killed)')) {
      working.killed = values[1]; return { rows: [{ ...working }], rowCount: 1 };
    }
    if (sql.includes('UPDATE user_execution_settings')) {
      Object.assign(working, { auto_execute: values[1], min_signal_score: values[2], max_position_pct: values[3],
        max_daily_exposure_pct: values[4], stop_loss_pct: values[5], rebuy_cooldown_seconds: values[6],
        max_daily_withdrawal_usd: values[7], max_concurrent_positions: values[8], killed: values[9] });
      return { rows: [{ ...working }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
});
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); });

it('denies an unprivileged ceiling increase against the locked row, including stale two-argument callers', async () => {
  await expect(upsertUserExecutionSettings(scope, { maxDailyWithdrawalUsd: 800 })).rejects.toMatchObject({ name: 'WithdrawalCeilingAuthorizationError' });
  expect(stored.max_daily_withdrawal_usd).toBe(400);
  expect(mocks.clientQuery.mock.calls.some(([sql]) => sql.includes('FOR UPDATE'))).toBe(true);
  expect(mocks.clientQuery.mock.calls.some(([sql]) => sql.includes('UPDATE user_execution_settings'))).toBe(false);
  expect(mocks.clientQuery.mock.calls.some(([sql]) => sql === 'ROLLBACK')).toBe(true);
  expect(audits).toEqual([]);
});

it('audits an allowed reduction and an admin increase with their locked before/after values', async () => {
  await expect(upsertUserExecutionSettings(scope, { maxDailyWithdrawalUsd: 200 })).resolves.toMatchObject({ maxDailyWithdrawalUsd: 200 });
  expect(audits).toHaveLength(1);
  expect(audits[0]!.slice(0, 5)).toEqual(['user', scope.userId, 'execution.withdrawal_ceiling_changed', 'user', scope.userId]);
  expect(JSON.parse(audits[0]![7])).toEqual({ previousUsd: 400, maxDailyWithdrawalUsd: 200 });
  await expect(upsertUserExecutionSettings(scope, { maxDailyWithdrawalUsd: 800 }, { role: 'admin' })).resolves.toMatchObject({ maxDailyWithdrawalUsd: 800 });
  expect(audits[1]![0]).toBe('admin');
  expect(JSON.parse(audits[1]![7])).toEqual({ previousUsd: 200, maxDailyWithdrawalUsd: 800 });
  expect(mocks.query).not.toHaveBeenCalled();
});

it('preserves omitted/undefined/equal ceilings and unrelated stale caller patches without an authority argument', async () => {
  await upsertUserExecutionSettings(scope, { minSignalScore: 90, maxDailyWithdrawalUsd: undefined, killed: undefined });
  await upsertUserExecutionSettings(scope, { maxDailyWithdrawalUsd: 400 });
  expect(stored).toMatchObject({ min_signal_score: 90, max_daily_withdrawal_usd: 400, killed: false });
  expect(audits).toEqual([]);
});

it.each(['audit', 'commit'])('rolls back settings and strict audit together on %s failure', async failure => {
  const execute = mocks.clientQuery.getMockImplementation()!;
  mocks.clientQuery.mockImplementation(async (sql: string, values: any[]) => {
    if ((failure === 'audit' && sql.includes('INSERT INTO audit_log')) || (failure === 'commit' && sql === 'COMMIT')) throw new Error('fixture failure');
    return execute(sql, values);
  });
  await expect(upsertUserExecutionSettings(scope, { maxDailyWithdrawalUsd: 200 })).rejects.toThrow('fixture failure');
  expect(stored.max_daily_withdrawal_usd).toBe(400);
  expect(audits).toEqual([]);
  expect(mocks.clientQuery.mock.calls.some(([sql]) => sql === 'ROLLBACK')).toBe(true);
});

it('strictly audits the dedicated kill switch and a killed settings patch using the mutation client', async () => {
  await expect(setUserKillSwitch(scope, true)).resolves.toMatchObject({ killed: true });
  expect(audits[0]![2]).toBe('execution.kill_switch_changed');
  expect(JSON.parse(audits[0]![7])).toEqual({ killed: true });
  await upsertUserExecutionSettings(scope, { killed: false });
  expect(audits[1]![2]).toBe('execution.kill_switch_changed');
  expect(JSON.parse(audits[1]![7])).toEqual({ killed: false });
  expect(mocks.query).not.toHaveBeenCalled();
});

it('does not commit an unaudited kill-switch change', async () => {
  const execute = mocks.clientQuery.getMockImplementation()!;
  mocks.clientQuery.mockImplementation(async (sql: string, values: any[]) => {
    if (sql.includes('INSERT INTO audit_log')) throw new Error('audit unavailable');
    return execute(sql, values);
  });
  await expect(setUserKillSwitch(scope, true)).rejects.toThrow('audit unavailable');
  expect(stored.killed).toBe(false);
  expect(audits).toEqual([]);
});

it('uses the authenticated role at the route/writer seam, never stale reads or a body role', async () => {
  const server = Fastify({ logger: false }); servers.push(server);
  server.addHook('onRequest', async request => {
    if (request.headers['x-fixture-auth']) (request as any).principal = { kind: 'user', user: {
      id: scope.userId, role: request.headers['x-fixture-auth'] === 'admin' ? 'admin' : 'user', status: 'active', tier: 'free'
    } };
  });
  const staleRead = vi.fn(async () => ({ maxDailyWithdrawalUsd: 1000 }));
  const deps = { getUserExecutionSettings: staleRead, upsertUserExecutionSettings,
    setUserKillSwitch, listUserBalances: async () => [], assessPositionCap: () => null } as unknown as ExecutionSettingsDependencies;
  await registerExecutionSettingsRoutes(server, deps);
  const url = '/v1/me/execution-settings';
  expect((await server.inject({ method: 'PATCH', url, payload: { maxDailyWithdrawalUsd: 800 } })).statusCode).toBe(401);
  const denied = await server.inject({ method: 'PATCH', url, headers: { 'x-fixture-auth': 'user' }, payload: { maxDailyWithdrawalUsd: 800 } });
  expect(denied.statusCode).toBe(403);
  expect(stored.max_daily_withdrawal_usd).toBe(400);
  const forged = await server.inject({ method: 'PATCH', url, headers: { 'x-fixture-auth': 'user' }, payload: { maxDailyWithdrawalUsd: 800, role: 'admin' } });
  expect(forged.statusCode).toBe(400);
  const allowed = await server.inject({ method: 'PATCH', url, headers: { 'x-fixture-auth': 'admin' }, payload: { maxDailyWithdrawalUsd: 800 } });
  expect(allowed.statusCode).toBe(200);
  expect(allowed.json().settings.maxDailyWithdrawalUsd).toBe(800);
  expect(staleRead).not.toHaveBeenCalled();
  expect(audits).toHaveLength(1);
  const reduced = await server.inject({ method: 'PATCH', url, headers: { 'x-fixture-auth': 'user' }, payload: { maxDailyWithdrawalUsd: 0 } });
  expect(reduced.statusCode).toBe(200);
  expect(reduced.json().settings.maxDailyWithdrawalUsd).toBe(0);
});
