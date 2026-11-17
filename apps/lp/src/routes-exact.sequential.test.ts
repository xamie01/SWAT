import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@swat/db', () => ({ forUser: (userId: string) => ({ userId }), resolveSession: vi.fn() }));
import Fastify from 'fastify';
import { registerLpRoutes } from './routes.js';
import { lpPaperFixture } from '@swat/db/dist/lp-paper-fixture.js';
import { buildExactPaperPlan } from './builder/exact-paper.js';
const request = { operationKey: 'acq', chain: 'solana', poolAddress: 'solana:pool', depositAsset: 'solana:mint',
  deposit: { raw: '900719925474099312345', scale: 18 }, strategy: { distribution: 'spot', rangeLower: 90, rangeUpper: 110, rungCount: 2 } };
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });
async function setup(provider = true) {
  const f = lpPaperFixture(buildExactPaperPlan); const app = Fastify(); apps.push(app);
  app.decorateRequest('principal', undefined);
  app.addHook('onRequest', async req => {
    const user = req.headers['x-fixture-user'];
    if (typeof user === 'string') req.principal = { kind: 'user', user: { id: user } as any, sessionId: 'offline-fixture' };
  });
  await registerLpRoutes(app, { executionMode: { resolveMode: async () => 'paper' }, deployGuard: {} as any, poolView: {} as any, userAddress: '',
    ...(provider ? { exactPaper: f.service, operations: { exactPaper: f.service, executionMode: { resolveMode: async () => 'paper' }, replan: vi.fn(), enqueue: vi.fn() } } : {}),
    livePreview: vi.fn(), queueManualRebalance: vi.fn() });
  await app.ready(); return { f, app };
}
const headers = { 'x-fixture-user': 'alice' };
describe('actual registered LP exact route handlers with injected financial domain', () => {
  it('strict rawscale admission invokes actual builder/service and preserves raw JSON', async () => {
    const { app, f } = await setup();
    const res = await app.inject({ method: 'POST', url: '/v1/lp/positions/deploy-exact', headers, payload: request });
    expect(res.statusCode).toBe(200); expect(res.json().position.deposit).toEqual(request.deposit);
    expect(res.json().position.depositMicroUsd).toBe('1111999096'); expect(f.state.commits).toEqual(['acquisition']);
    const read = await app.inject({ method: 'GET', url: `/v1/lp/positions/${res.json().positionId}/exact`, headers });
    expect(read.json().position.deposit.raw).toBe(request.deposit.raw);
  });
  it.each([
    { deposit: { raw: 1, scale: 18 } }, { deposit: { raw: '01', scale: 18 } }, { userId: 'bob' },
    { quote: { providerId: 'forged' } }, { deposit: { raw: '1', scale: 31 } }, { strategy: { distribution: 'spot', rangeLower: 0, rangeUpper: 100, rungCount: 2 } }
  ])('denies malformed or authority-bearing body %# before financial callback', async extra => {
    const { app, f } = await setup();
    expect((await app.inject({ method: 'POST', url: '/v1/lp/positions/deploy-exact', headers, payload: { ...request, ...extra } })).statusCode).toBe(400);
    expect(f.state.commits).toEqual([]); expect(f.seen.quotes).toEqual([]);
  });
  it('absent user, substituted tenant and unknown position are denied', async () => {
    const { app, f } = await setup();
    expect((await app.inject({ method: 'POST', url: '/v1/lp/positions/deploy-exact', payload: request })).statusCode).toBe(401);
    const p = await f.service.acquire({ userId: 'alice' } as any, request as any);
    expect((await app.inject({ method: 'GET', url: `/v1/lp/positions/${p.id}/exact`, headers: { 'x-fixture-user': 'bob' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/v1/lp/positions/${p.id}/close`, headers: { 'x-fixture-user': 'bob' }, payload: { operationKey: 'close' } })).statusCode).toBe(409);
    expect(f.state.positions[p.id]!.state).toBe('active');
  });
  it('existing close route admits durable pending intent; receipt recovery then status reports completed', async () => {
    const { app, f } = await setup(); const p = await f.service.acquire({ userId: 'alice' } as any, request as any);
    const close = await app.inject({ method: 'POST', url: `/v1/lp/positions/${p.id}/close`, headers, payload: { operationKey: 'close' } });
    expect(close.statusCode).toBe(200); expect(close.json().operation.status).toBe('pending'); expect(f.state.positions[p.id]!.state).toBe('active');
    const replay = await app.inject({ method: 'POST', url: `/v1/lp/positions/${p.id}/close`, headers, payload: { operationKey: 'close' } });
    expect(replay.json().operation.id).toBe(close.json().operation.id); expect(f.seen.quotes).toHaveLength(2);
    f.receipts.available = true; await f.service.process({ userId: 'alice' } as any, { operationId: close.json().operation.id, chain: 'solana' });
    const observed = await app.inject({ method: 'GET', url: `/v1/lp/operations/${close.json().operation.id}`, headers });
    expect(observed.json().operation.status).toBe('completed'); expect(f.state.positions[p.id]!.state).toBe('closed');
    expect((await app.inject({ method: 'GET', url: `/v1/lp/operations/${close.json().operation.id}`, headers: { 'x-fixture-user': 'bob' } })).statusCode).toBe(404);
  });
  it('operation body may not inject receipt, plan, tenant or automatic authority', async () => {
    const { app, f } = await setup(); const p = await f.service.acquire({ userId: 'alice' } as any, request as any);
    expect((await app.inject({ method: 'POST', url: `/v1/lp/positions/${p.id}/close`, headers,
      payload: { operationKey: 'close', receipt: {}, userId: 'alice' } })).statusCode).toBe(400);
    expect(Object.keys(f.state.operations)).toHaveLength(0);
  });
  it('providerless capabilities and legacy numeric route stay unavailable honestly', async () => {
    const { app } = await setup(false);
    expect((await app.inject({ method: 'GET', url: '/v1/lp/capabilities', headers })).json()).toMatchObject({ injectedPortsConfigured: false, runtimeAccepted: false, liveCapabilityAccepted: false });
    expect((await app.inject({ method: 'POST', url: '/v1/lp/positions/deploy-exact', headers, payload: request })).statusCode).toBe(503);
    expect((await app.inject({ method: 'POST', url: '/v1/lp/positions/deploy', headers, payload: { depositAmount: 1 } })).statusCode).toBe(503);
  });
  it('registered copy route invokes sized acquisition, not fake execution status', async () => {
    const { app, f } = await setup();
    const res = await app.inject({ method: 'POST', url: '/v1/lp/copy/mint-exact', headers, payload: { subscriptionId: 'sub', eventId: 'mint-event', assetScale: 18 } });
    expect(res.statusCode).toBe(200); expect(res.json().position.copyOrigin.eventId).toBe('mint-event');
    expect(f.state.commits).toEqual(['acquisition+copy']);
  });
});
