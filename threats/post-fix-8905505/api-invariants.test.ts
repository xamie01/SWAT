import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { USDC_MINTS } from '../../packages/shared/src/billing.js';

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
  const billing = await import('../../packages/shared/src/billing.js');
  const chains = await import('../../packages/shared/src/validation.js');
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

import { registerMeRoutes } from '../../apps/api/src/routes/me.js';
import { registerBillingRoutes, verifyPolygonUsdcTransferOnChain } from '../../apps/api/src/routes/billing.js';

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

  it('PF-WEB-02: owned memo without verified transaction attribution must not credit another payer', async () => {
    const server = app();
    const record = vi.fn().mockResolvedValue({ payment: { id: 'fixture-payment', txHash: 'fixture-hash', amountUsdc: 35 }, updatedTier: 'operator', updatedExpiresAt: null });
    await registerBillingRoutes(server, {
      createPaymentIntent: vi.fn(), getUserBillingStatus: vi.fn(), listUserCryptoPayments: vi.fn(), runTierDowngradeSweep: vi.fn(),
      findPaymentIntentByMemo: vi.fn().mockResolvedValue({ userId: USER, status: 'pending', planId: 'operator_monthly', expiresAt: new Date(Date.now() + 60000) }),
      listAuthWallets: vi.fn().mockResolvedValue([{ address: OWNER, chainKind: 'evm' }]),
      verifyOnChainPayment: vi.fn().mockResolvedValue({ verified: true, payerAddress: OTHER, amountUsdc: 35 }),
      recordCryptoPaymentAndGrantTier: record
    } as any);
    const result = await server.inject({ method: 'POST', url: '/v1/billing/crypto/verify', payload: {
      chain: 'polygon', txHash: '0x' + '3'.repeat(64), planId: 'operator_monthly', memo: 'SYNTHETIC-OWNED-INTENT'
    } });
    expect(record).not.toHaveBeenCalled();
    expect(result.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('PF-WEB-03: a non-Transfer event must not count as a USDC payment', async () => {
    const treasury = '0x3333333333333333333333333333333333333333';
    const topic = (address: string) => '0x' + address.slice(2).padStart(64, '0');
    fixture.receipt.mockResolvedValue({ status: 'success', logs: [{
      address: USDC_MINTS.polygon,
      topics: ['0x' + '0'.repeat(64), topic(OWNER), topic(treasury)],
      data: '0x' + (35_000_000n).toString(16).padStart(64, '0')
    }] });
    const result = await verifyPolygonUsdcTransferOnChain({ txHash: '0x' + '4'.repeat(64), expectedUsdc: 35, treasuryAddress: treasury });
    expect(result.verified).toBe(false);
  });
});
