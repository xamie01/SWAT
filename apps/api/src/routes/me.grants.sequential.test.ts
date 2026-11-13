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


it.each([
  { chain: 'polygon', grantKind: 'solana_vault', accountAddress: OWNER },
  { chain: 'robinhood-chain', grantKind: 'eip7702', accountAddress: OWNER },
  { chain: 'solana', grantKind: 'solana_vault', accountAddress: '11111111111111111111111111111111' }
])('rejects unsupported or unowned registration without writes: $grantKind/$chain', async (payload) => {
  const server = app();
  await registerMeRoutes(server, { backfillQueue: {} as any, tokenDiscoveryQueue: {} as any });
  const response = await server.inject({ method: 'POST', url: '/v1/me/vault/grant', payload });
  expect(response.statusCode).toBeGreaterThanOrEqual(400);
  expect(fixture.query.mock.calls.filter(([sql]) => /INSERT|UPDATE|DELETE/.test(sql))).toEqual([]);
});
it('disables only the requested venue, and never claims on-chain revocation or refund', async () => {
  const grants = [{ id: 'rh', chain: 'robinhood-chain', status: 'active' }, { id: 'poly', chain: 'polygon', status: 'active' }];
  fixture.query.mockImplementation(async (sql: string, params: any[]) => {
    if (sql.includes('UPDATE user_execution_grants')) {
      const changed = grants.filter(g => sql.includes(' OR ') || g.chain === params[1]); changed.forEach(g => g.status = 'revoked'); return changed;
    }
    return grants.filter(g => g.status === 'active');
  });
  const server = app(); await registerMeRoutes(server, { backfillQueue: {} as any, tokenDiscoveryQueue: {} as any });
  const response = await server.inject({ method: 'POST', url: '/v1/me/vault/revoke', payload: { chain: 'robinhood-chain' } });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ localOnly: true, onChainRevoked: false, revokedCount: 1 });
  expect(grants[1].status).toBe('active');
});
