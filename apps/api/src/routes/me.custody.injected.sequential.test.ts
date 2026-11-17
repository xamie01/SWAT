import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('@swat/db', () => ({ forUser: (userId: string) => ({ userId }), findUserById: vi.fn(), resolveSession: vi.fn() }));
import { registerMeCustodyRoutes, type MeCustodyPorts, type VerifiedEnrollmentContext } from './me-custody.js';
import { createCustodyEnrollment, type CustodyEnrollmentRecord } from '@swat/db/dist/custody-enrollment.js';
import { custodyPolicyDigest } from '@swat/db/dist/custody-contract.js';
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });
const now = new Date('2026-11-17T12:00:00.000Z');
const body = { chain: 'polygon' as const, grantKind: 'polymarket_signer' as const, accountAddress: '0x' + 'a'.repeat(40), consentId: 'consent-1', expectedRevision: 'r1' };
async function setup() {
  const stored: CustodyEnrollmentRecord[] = [];
  let ownedBytes: Uint8Array | undefined;
  const seal = vi.fn(async ({ plaintext }: { plaintext: Uint8Array }) => {
    ownedBytes = plaintext;
    return ['v2', 'inert-wrap', '1', Buffer.from('binding').toString('base64'), Buffer.alloc(12, 1).toString('base64'),
      Buffer.alloc(16, 2).toString('base64'), Buffer.from('inert-envelope').toString('base64')].join('.');
  });
  const enrollment = createCustodyEnrollment({ deploymentId: 'inert-deployment', chainIds: { polygon: '137' }, now: () => now,
    allocateGrantId: async () => '11111111-1111-4111-8111-111111111111', wrap: { wrapperId: 'inert-wrap', keyVersion: 1, seal },
    store: { record: async (scope, input) => { stored.push(input); return { id: input.id, userId: scope.userId, chain: input.chain,
      grantKind: input.grantKind, accountAddress: input.accountAddress, hasSealedSecret: !!input.sealedSecret,
      keyVersion: input.keyVersion, scopePolicy: input.scopePolicy, expiresAt: input.expiresAt, revokedAt: null, status: 'active', createdAt: now }; } } });
  const context: VerifiedEnrollmentContext = { userId: 'user-1', chain: body.chain, grantKind: body.grantKind,
    accountAddress: body.accountAddress, consentId: body.consentId, revision: 'r1', linkedAccount: body.accountAddress,
    deploymentId: 'inert-deployment', chainId: '137',
    proof: 'independent-fixture-proof', validUntil: '2026-11-17T12:01:00.000Z', policyDigest: custodyPolicyDigest({ purpose: 'local-only' }),
    deploymentVerified: true, input: { chain: body.chain, grantKind: body.grantKind, accountAddress: body.accountAddress,
      secret: Uint8Array.from([7, 8, 9]), scopePolicy: { purpose: 'local-only' }, expiresAt: null } };
  const verified = vi.fn(async <T>(_scope: unknown, _request: unknown, commit: (value: VerifiedEnrollmentContext) => Promise<T>) => commit(context));
  const ports: MeCustodyPorts = { enrollment, now: () => now, deploymentId: 'inert-deployment', chainIds: { polygon: '137' }, withVerifiedConsent: verified };
  const app = Fastify({ logger: false }); apps.push(app);
  app.addHook('onRequest', async request => {
    const id = request.headers['x-fixture-user']; if (typeof id === 'string') request.principal = { kind: 'user', sessionId: null, user: { id } as never };
  });
  await registerMeCustodyRoutes(app, ports);
  const post = (payload: unknown = body, user = 'user-1') => app.inject({ method: 'POST', url: '/v1/me/vault/enrollment', payload: payload as never, headers: { 'x-fixture-user': user } });
  return { app, stored, seal, verified, context, post, bytes: () => ownedBytes };
}
it('actual wrap-only E factory runs behind actual route consent facade and projects local record only', async () => {
  const s = await setup(); const result = await s.post(); expect(result.statusCode).toBe(200);
  expect(s.verified.mock.calls[0]![0]).toEqual({ userId: 'user-1' }); expect(s.seal).toHaveBeenCalledTimes(1); expect(s.stored).toHaveLength(1);
  expect(result.json()).toMatchObject({ localOnly: true, executionSupported: false, grant: { hasSealedSecret: true },
    capability: { localEnrollmentSupported: true, enrollmentSupported: false, runtimeAccepted: false, liveAccepted: false } });
  expect(result.body).not.toMatch(/secretBinding|sealedSecret|scopePolicy|inert-envelope|independent-fixture-proof|apiKey/);
  expect(s.bytes()).toEqual(Uint8Array.from([0, 0, 0])); expect(result.headers['cache-control']).toBe('no-store');
});
it.each(['tenant', 'account', 'consent', 'revision', 'expiry', 'policy', 'deployment', 'network'])('denies substituted/stale independent %s context before wrap/store', async kind => {
  const s = await setup(); const change = kind === 'tenant' ? { userId: 'user-2' } : kind === 'account' ? { accountAddress: '0x' + 'b'.repeat(40) }
    : kind === 'consent' ? { consentId: 'other' } : kind === 'revision' ? { revision: 'r2' } : kind === 'expiry' ? { validUntil: now.toISOString() }
      : kind === 'policy' ? { policyDigest: 'bad' } : kind === 'network' ? { chainId: 'other' } : { deploymentVerified: false };
  Object.assign(s.context, change); expect((await s.post()).statusCode).toBe(409); expect(s.seal).not.toHaveBeenCalled(); expect(s.stored).toHaveLength(0);
});
it('public secret, signature and userId fields cannot be used as enrollment or ownership authority', async () => {
  const s = await setup();
  for (const extra of [{ secret: [1, 2] }, { signature: '0x00' }, { userId: 'user-1' }, { scopePolicy: { enabled: true } }]) {
    expect((await s.post({ ...body, ...extra })).statusCode).toBe(400);
  }
  expect((await s.app.inject({ method: 'POST', url: '/v1/me/vault/enrollment', payload: body })).statusCode).toBe(401);
  expect(s.verified).not.toHaveBeenCalled(); expect(s.seal).not.toHaveBeenCalled();
});
it('wrap provider failure is sanitized and never exposed as a recorded/executing grant', async () => {
  const s = await setup(); s.seal.mockRejectedValue(new Error('SYNTHETIC_PRIVATE_MARKER'));
  const result = await s.post(); expect(result.statusCode).toBe(503); expect(result.body).not.toContain('SYNTHETIC_PRIVATE_MARKER');
  expect(s.stored).toHaveLength(0); expect(s.bytes()).toBeUndefined();
});
it('keyless Solana local record stays secret-free and never invokes wrapping', async () => {
  const s = await setup();
  const request = { ...body, chain: 'solana', grantKind: 'solana_vault', accountAddress: '1'.repeat(32) };
  Object.assign(s.context, { chain: 'solana', grantKind: 'solana_vault', accountAddress: request.accountAddress,
    linkedAccount: request.accountAddress, chainId: 'solana-mainnet', input: { chain: 'solana', grantKind: 'solana_vault',
      accountAddress: request.accountAddress, secret: null, scopePolicy: { purpose: 'local-only' }, expiresAt: null } });
  // Override only the explicitly injected network configuration, not a request authority flag.
  const app = Fastify({ logger: false }); apps.push(app);
  app.addHook('onRequest', async req => { req.principal = { kind: 'user', sessionId: null, user: { id: 'user-1' } as never }; });
  const enrollment = createCustodyEnrollment({ deploymentId: 'inert-deployment', chainIds: { solana: 'solana-mainnet' }, now: () => now,
    allocateGrantId: async () => '11111111-1111-4111-8111-111111111111',
    store: { record: async (scope, input) => { s.stored.push(input); return { ...input, userId: scope.userId,
      hasSealedSecret: false, revokedAt: null, status: 'active', createdAt: now }; } } });
  await registerMeCustodyRoutes(app, { enrollment, now: () => now, deploymentId: 'inert-deployment', chainIds: { solana: 'solana-mainnet' },
    withVerifiedConsent: async (_scope, _request, commit) => commit(s.context) });
  const response = await app.inject({ method: 'POST', url: '/v1/me/vault/enrollment', payload: request });
  expect(response.statusCode).toBe(200); expect(response.json().grant).toMatchObject({ hasSealedSecret: false, keyVersion: null });
  expect(s.stored[0]).toMatchObject({ sealedSecret: null, keyVersion: null, secretBinding: null }); expect(s.seal).not.toHaveBeenCalled();
});
it('providerless local enrollment is unavailable even if an account/consent label is posted', async () => {
  const app = Fastify({ logger: false }); apps.push(app);
  app.addHook('onRequest', async request => { request.principal = { kind: 'user', sessionId: null, user: { id: 'user-1' } as never }; });
  await registerMeCustodyRoutes(app);
  const result = await app.inject({ method: 'POST', url: '/v1/me/vault/enrollment', payload: body });
  expect(result.statusCode).toBe(503); expect(result.json()).toMatchObject({ credentialsRecorded: false, executionSupported: false });
});
