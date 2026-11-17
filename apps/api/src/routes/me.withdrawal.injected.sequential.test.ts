import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('@swat/db', async () => ({
  ...await import('@swat/db/dist/withdrawal-contract.js'), ...await import('@swat/db/dist/withdrawal-store.js'),
  ...await import('@swat/db/dist/withdrawal-service.js'), ...await import('@swat/db/dist/reducing-contract.js'),
  forUser: (userId: string) => ({ userId }), findUserById: vi.fn(), resolveSession: vi.fn()
}));
import { registerMeFinancialRoutes } from './me-financial.js';
import { createWithdrawalService, type WithdrawalEligibility } from '@swat/db/dist/withdrawal-service.js';
import { withdrawalSqlFixture } from '@swat/db/dist/withdrawal-test-fixture.js';
import { financialHash } from '@swat/db/dist/withdrawal-contract.js';
const USER = 'user-1';
const input = { requestKey: 'withdraw-1', chain: 'polygon' as const, network: 'polygon:137:genesis', assetId: 'polygon:USDC',
  assetScale: 6, sourceWalletId: 'wallet-1', destination: '0x' + 'a'.repeat(40), amountRaw: '900719925474099312345678', maxFeeRaw: '10', mode: 'paper' as const };
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });
async function setup() {
  const db = withdrawalSqlFixture();
  const evidence: WithdrawalEligibility = { userId: USER, chain: input.chain, network: input.network, assetId: input.assetId,
    assetScale: input.assetScale, sourceWalletId: input.sourceWalletId, destination: input.destination, mode: input.mode,
    destinationVerifiedAt: '2026-11-15T12:00:00.000Z', availableRaw: '999999999999999999999999', observedAt: db.now,
    validUntil: '2026-11-17T12:01:00.000Z', custodyRevision: 'r1', balanceProof: 'inert-approved-proof' };
  const issue = vi.fn(async (hash: string) => ({ code: '123456', digest: financialHash([hash, '123456']) }));
  const deliver = vi.fn(async () => { db.events.push('deliver'); return true; });
  const service = createWithdrawalService({ transaction: db.transaction, lockEligibility: async () => evidence,
    otp: { issue, deliver, digest: async (hash, code) => financialHash([hash, code]) } });
  const app = Fastify({ logger: false }); apps.push(app);
  app.addHook('onRequest', async request => {
    const id = request.headers['x-fixture-user'];
    if (typeof id === 'string') request.principal = { kind: 'user', sessionId: null, user: { id } as never };
    if (request.headers['x-fixture-service']) request.principal = { kind: 'service' };
  });
  await registerMeFinancialRoutes(app, { withdrawal: service });
  const post = (url: string, payload: unknown, user = USER) => app.inject({ method: 'POST', url, payload: payload as never, headers: { 'x-fixture-user': user } });
  const auth = async () => {
    const response = await post('/v1/me/trading/withdraw/request-otp', input);
    expect(response.statusCode).toBe(200);
    const result = response.json();
    return { response, result, confirmation: { intentId: result.record.id, authorizationId: result.authorizationId, otp: '123456' } };
  };
  return { db, evidence, service, issue, deliver, app, post, auth };
}
it('actual factory route commits before code delivery and preserves exact units without exposing authorization secrets', async () => {
  const s = await setup(); const { response, result } = await s.auth();
  expect(response.headers['cache-control']).toBe('no-store');
  expect(result.record.intent).toMatchObject(input);
  expect(result.record).toMatchObject({ status: 'awaiting-authorization', completedRaw: '0', terminal: false });
  expect(response.body).not.toContain('123456'); expect(response.body).not.toContain('balanceProof');
  expect(result).not.toHaveProperty('digest'); expect(result.record.intent).not.toHaveProperty('userId');
  expect(s.db.events.indexOf('commit:' + USER)).toBeLessThan(s.db.events.indexOf('deliver'));
  expect(result.capability).toMatchObject({ admissionSupported: true, supported: false, injectedVerified: false, runtimeAccepted: false, liveAccepted: false });
});
it('actual confirm consumes one-use authorization with outbox and exact retries do not queue twice or report transfer completion', async () => {
  const s = await setup(); const { confirmation } = await s.auth();
  for (let i = 0; i < 2; i++) {
    const response = await s.post('/v1/me/trading/withdraw', confirmation);
    expect(response.statusCode).toBe(200); expect(response.json().record).toMatchObject({ status: 'queued', completedRaw: '0', terminal: false });
    expect(response.json()).not.toHaveProperty('success');
  }
  expect(s.db.state().outbox).toHaveLength(1);
  expect(s.db.state().reservations[0]!.reserved_raw).toBe('900719925474099312345688');
  const writes = s.db.transcript.filter(t => ['withdrawal:consume', 'financial:outbox', 'financial:reserve', 'financial:queue'].includes(t.marker));
  expect(writes).toHaveLength(4); expect(writes.every(t => t.client === writes[0]!.client)).toBe(true);
});
it.each(['amountRaw', 'maxFeeRaw', 'network', 'assetScale', 'destination', 'mode'])('request replay rejects substituted %s at actual service boundary', async field => {
  const s = await setup(); await s.auth();
  const changed: Record<string, unknown> = { amountRaw: '2', maxFeeRaw: '11', network: 'other', assetScale: 7, destination: '0x' + 'b'.repeat(40), mode: 'live' };
  const response = await s.post('/v1/me/trading/withdraw/request-otp', { ...input, [field]: changed[field] });
  expect(response.statusCode).toBe(409); expect(s.issue).toHaveBeenCalledTimes(1); expect(s.db.state().outbox).toHaveLength(0);
});
it.each([1, '1e6', '1.0', '+1', '01', '0'])('route refuses noncanonical/zero raw amount %j before durable work', async amountRaw => {
  const s = await setup(); expect((await s.post('/v1/me/trading/withdraw/request-otp', { ...input, amountRaw })).statusCode).toBe(400);
  expect(s.db.events).toHaveLength(0);
});
it('anonymous/service and cross-tenant intent cannot read or confirm financial requests', async () => {
  const s = await setup();
  for (const headers of [{}, { 'x-fixture-service': 'yes' }]) {
    expect((await s.app.inject({ method: 'POST', url: '/v1/me/trading/withdraw/request-otp', payload: input, headers })).statusCode).toBe(401);
  }
  expect(s.db.events).toHaveLength(0);
  const { confirmation } = await s.auth();
  expect((await s.post('/v1/me/trading/withdraw', confirmation, 'user-2')).statusCode).toBe(404);
  expect((await s.app.inject({ url: '/v1/me/trading/withdraw/' + confirmation.intentId, headers: { 'x-fixture-user': 'user-2' } })).statusCode).toBe(404);
  expect(s.db.state().outbox).toHaveLength(0);
  expect((await s.post('/v1/me/trading/withdraw', { ...confirmation, userId: USER, amountRaw: '1' })).statusCode).toBe(400);
});
it.each(['cooling', 'owner', 'mode', 'balance', 'expiry', 'wrong-code', 'wrong-authorization', 'outbox'])('confirm revalidates/refuses %s without consuming authority or false completion', async kind => {
  const s = await setup(); const { confirmation } = await s.auth();
  if (kind === 'cooling') Object.assign(s.evidence, { destinationVerifiedAt: s.db.now });
  if (kind === 'owner') Object.assign(s.evidence, { userId: 'user-2' });
  if (kind === 'mode') Object.assign(s.evidence, { mode: 'live' });
  if (kind === 'balance') Object.assign(s.evidence, { availableRaw: '1' });
  if (kind === 'expiry') s.db.state().auth[0]!.expires_at = '2026-11-17T11:59:59.000Z';
  if (kind === 'wrong-code') confirmation.otp = '654321';
  if (kind === 'wrong-authorization') confirmation.authorizationId = 'other';
  if (kind === 'outbox') s.db.fail('financial:outbox');
  const response = await s.post('/v1/me/trading/withdraw', confirmation);
  expect(response.statusCode).toBeGreaterThanOrEqual(400); expect(s.db.state().auth[0]!.consumed_at).toBeNull();
  expect(s.db.state().outbox).toHaveLength(0); expect(s.db.state().reservations).toHaveLength(0);
});
it('failed or unknown delivery never enables confirm or implicit resend on retry', async () => {
  const s = await setup(); s.deliver.mockResolvedValue(false); const { confirmation, result } = await s.auth();
  expect(result.delivery).toBe('failed'); expect((await s.post('/v1/me/trading/withdraw', confirmation)).statusCode).toBe(409);
  await s.auth(); expect(s.deliver).toHaveBeenCalledTimes(1); expect(s.issue).toHaveBeenCalledTimes(1);
});
