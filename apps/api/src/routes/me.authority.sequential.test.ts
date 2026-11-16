import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { USDC_MINTS } from '../../../../packages/shared/src/billing.js';

const fixture = vi.hoisted(() => ({
  query: vi.fn(),
  wallets: vi.fn(),
  recover: vi.fn(),
  seal: vi.fn(),
  receipt: vi.fn()
}));

vi.mock('@swat/db', () => ({
  query: fixture.query,
  listAuthWallets: fixture.wallets,
  forUser: (userId: string) => ({ userId }),
  findUserById: vi.fn(), resolveSession: vi.fn(),
  isSubscribed: vi.fn(), listTokenWatches: vi.fn(), listWalletSubscriptions: vi.fn(),
  QuotaExceededError: class extends Error {}, requestTokenWatch: vi.fn(), subscribeToWallet: vi.fn(),
  beginWindDown: vi.fn(), requestCloseAll: vi.fn(), checkWalletClusterIndependence: vi.fn(),
  checkWalletHubStatus: vi.fn(), getPerpsInstruments: vi.fn(), getPerpsAccount: vi.fn(),
  getUserPerpsPositions: vi.fn(), upsertPerpsAccount: vi.fn(), upsertPerpsPosition: vi.fn(),
  recordPerpsOrder: vi.fn(), closePerpsPosition: vi.fn(), createPaymentIntent: vi.fn(),
  DuplicatePaymentTransactionError: class extends Error {}, getUserBillingStatus: vi.fn(),
  listUserCryptoPayments: vi.fn(), recordCryptoPaymentAndGrantTier: vi.fn(),
  runTierDowngradeSweep: vi.fn(), UnderpaidPaymentError: class extends Error {}
}));

vi.mock('@swat/shared', async () => {
  const billing = await import('../../../../packages/shared/src/billing.js');
  const chains = await import('../../../../packages/shared/src/validation.js');
  return {
    ...billing, chainSchema: chains.chainSchema,
    executeWithRpcFailover: async ({ action }: any) => action('https://synthetic.invalid'),
    buildClobAuthTypedData: vi.fn(), capabilitiesFor: vi.fn(), createWalletBackfillJob: vi.fn(),
    EnvMasterKeyWrapper: class {}, fetchClobCredentialsFromSignature: vi.fn(),
    isValidAddressForChain: vi.fn(), loadEmailConfigFromEnv: vi.fn(), resolveChainAddress: vi.fn(),
    sealSecret: fixture.seal, sendEmail: vi.fn(), tierAllowsChain: vi.fn()
  };
});

vi.mock('viem', () => ({
  recoverTypedDataAddress: fixture.recover,
  createPublicClient: () => ({ getTransactionReceipt: fixture.receipt }),
  http: vi.fn(), parseAbiItem: vi.fn()
}));
vi.mock('viem/chains', () => ({ polygon: { id: 137 } }));

import { registerMeRoutes } from './me.js';

const USER = '11111111-1111-4111-8111-111111111111';
const OWNER = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const apps: ReturnType<typeof Fastify>[] = [];
function app() {
  const server = Fastify({ logger: false });
  server.addHook('onRequest', async (request) => {
    (request as any).principal = { kind: 'user', sessionId: 'synthetic-session', user: {
      id: USER, email: 'fixture@example.invalid', role: 'user', tier: 'free', status: 'active'
    } };
  });
  apps.push(server);
  return server;
}
beforeEach(() => {
  vi.clearAllMocks();
  fixture.wallets.mockResolvedValue([]);
  fixture.query.mockResolvedValue([]);
  fixture.seal.mockResolvedValue('synthetic-sealed-envelope');
  fixture.recover.mockRejectedValue(new Error('synthetic invalid signature'));
});
afterEach(async () => { for (const server of apps.splice(0)) await server.close(); });

describe('Synthetic security invariants against actual route handlers', () => {
  it('PF-WEB-01: invalid delegation proof must reject without linking a wallet', async () => {
    const server = app();
    await registerMeRoutes(server, { backfillQueue: { add: vi.fn() } as any, tokenDiscoveryQueue: { add: vi.fn() } as any });
    const result = await server.inject({ method: 'POST', url: '/v1/me/vault/robinhood/delegation', payload: {
      address: OWNER, signature: '0x00', timestampSeconds: 1, nonce: 1
    } });
    expect(fixture.query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO user_auth_wallets')).length).toBe(0);
    expect(result.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('PF-WEB-01: invalid delegation proof must not return successful authorization', async () => {
    const server = app();
    await registerMeRoutes(server, { backfillQueue: { add: vi.fn() } as any, tokenDiscoveryQueue: { add: vi.fn() } as any });
    const result = await server.inject({ method: 'POST', url: '/v1/me/vault/robinhood/delegation', payload: {
      address: OWNER, signature: '0x00', timestampSeconds: 1, nonce: 1
    } });
    expect(result.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('reports unsupported delegation without offering a signature challenge', async () => {
    const server = app();
    await registerMeRoutes(server, { backfillQueue: {} as any, tokenDiscoveryQueue: {} as any });
    const response = await server.inject({ method: 'GET', url: '/v1/me/vault/robinhood/challenge?address=' + OWNER });
    expect(response.statusCode).toBe(501);
    expect(response.json()).toMatchObject({ status: 'unsupported', executionSupported: false });
    expect(fixture.query).not.toHaveBeenCalled();
  });
  it('projects only credential status rather than historical CLOB identifiers', async () => {
    fixture.query.mockResolvedValue([{ chain: 'polygon', grant_kind: 'polymarket_signer', account_address: OWNER, status: 'active', scope_policy: { apiKey: 'SYNTHETIC_PRIVATE_MARKER' } }]);
    const server = app();
    await registerMeRoutes(server, { backfillQueue: {} as any, tokenDiscoveryQueue: {} as any });
    const response = await server.inject({ method: 'GET', url: '/v1/me/vault' });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('SYNTHETIC_PRIVATE_MARKER');
    expect(response.json().polymarket.credentialsRecorded).toBe(true);
  });
  it('reports eligibility and enrollment unavailable without fabricating geo approval', async () => {
    const server = app();
    await registerMeRoutes(server, { backfillQueue: {} as any, tokenDiscoveryQueue: {} as any });
    const response = await server.inject({ method: 'GET', url: '/v1/me/vault' });
    expect(response.json().polymarket).toMatchObject({ geoEligible: null, geoExpiresAt: null, eligibilityAssessment: 'unassessed', enrollmentSupported: false });
    expect(response.json().polymarket.unavailableReasons).toContain('authorized-wrap-only-service-unavailable');
    expect(response.json().solana.unavailableReasons).toContain('deployed-authority-verification-unavailable');
  });
  it('never advertises a historical grant or spliced address as usable authority', async () => {
    fixture.query.mockResolvedValue([{ chain: 'robinhood-chain', grant_kind: 'eip7702', account_address: OWNER, status: 'active', scope_policy: { smartAccount: OTHER } }]);
    fixture.wallets.mockResolvedValue([{ address: OWNER, chainKind: 'evm', verifiedAt: new Date('2026-01-01') }]);
    const server = app();
    await registerMeRoutes(server, { backfillQueue: {} as any, tokenDiscoveryQueue: {} as any });
    const response = await server.inject({ method: 'GET', url: '/v1/me/vault' });
    expect(response.json().robinhood).toMatchObject({ smartAccountAddress: null, accountAddress: OWNER, sessionKeyStatus: 'unsupported', executionSupported: false });
  });
});
