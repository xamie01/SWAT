import Fastify from 'fastify';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn(), wallets: vi.fn(), email: vi.fn() }));
vi.mock('@swat/db', () => ({
  query: mocks.query, listAuthWallets: mocks.wallets, forUser: (userId: string) => ({ userId }),
  findUserById: vi.fn(), resolveSession: vi.fn(), recordExecutionGrant: vi.fn(),
  isSubscribed: vi.fn(), listTokenWatches: vi.fn(), listWalletSubscriptions: vi.fn(),
  QuotaExceededError: class extends Error {}, requestTokenWatch: vi.fn(), subscribeToWallet: vi.fn(),
  beginWindDown: vi.fn(), requestCloseAll: vi.fn(), checkWalletClusterIndependence: vi.fn(),
  checkWalletHubStatus: vi.fn(), getPerpsInstruments: vi.fn(), getPerpsAccount: vi.fn(),
  getUserPerpsPositions: vi.fn(), upsertPerpsAccount: vi.fn(), upsertPerpsPosition: vi.fn(),
  recordPerpsOrder: vi.fn(), closePerpsPosition: vi.fn()
}));
vi.mock('@swat/shared', async () => {
  const validation = await import('../../../../packages/shared/src/validation.js');
  return { chainSchema: validation.chainSchema, buildClobAuthTypedData: vi.fn(),
    deriveWakeVaultAddress: vi.fn(), capabilitiesFor: vi.fn(), createWalletBackfillJob: vi.fn(),
    EnvMasterKeyWrapper: class {}, fetchClobCredentialsFromSignature: vi.fn(),
    isValidAddressForChain: vi.fn(), loadEmailConfigFromEnv: vi.fn(), resolveChainAddress: vi.fn(),
    sealSecret: vi.fn(), sendEmail: mocks.email, tierAllowsChain: vi.fn() };
});
import { registerMeRoutes, type StoredWithdrawalOtp } from './me.js';

const USER = '11111111-1111-4111-8111-111111111111';
const ADDRESS = '0x1111111111111111111111111111111111111111';
const servers: ReturnType<typeof Fastify>[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockResolvedValue([]);
  mocks.wallets.mockResolvedValue([{ address: ADDRESS, chainKind: 'evm', verifiedAt: new Date('2026-01-01') }]);
  mocks.email.mockResolvedValue(true);
});
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); });

it('refuses withdrawal issue and confirm without email, OTP mutation, DB access or queue work; anonymous stays 401', async () => {
  const server = Fastify({ logger: false }); servers.push(server);
  server.addHook('onRequest', async request => {
    if (request.headers['x-fixture-auth']) (request as any).principal = { kind: 'user', user: {
      id: USER, email: 'fixture@example.invalid', role: 'user', status: 'active', tier: 'free'
    } };
  });
  const otpStore = new Map<string, StoredWithdrawalOtp>([[USER, { code: '123456',
    destinationAddress: ADDRESS, chainKind: 'evm', amountUsd: 10, attempts: 0,
    expiresAt: new Date('2099-01-01') }]]);
  const before = structuredClone(otpStore);
  const add = vi.fn();
  await registerMeRoutes(server, { backfillQueue: { add } as any, tokenDiscoveryQueue: { add } as any,
    otpStore, sendWithdrawalOtpEmail: mocks.email });
  for (const url of ['/v1/me/trading/withdraw/request-otp', '/v1/me/trading/withdraw']) {
    const payload = { destinationAddress: ADDRESS, chainKind: 'evm', amountUsd: 10, otpCode: '123456' };
    expect((await server.inject({ method: 'POST', url, payload })).statusCode).toBe(401);
    const response = await server.inject({ method: 'POST', url, payload, headers: { 'x-fixture-auth': 'yes' } });
    expect(response.statusCode).toBe(501);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({ error: 'withdrawal-unsupported', supported: false });
    expect(response.json()).not.toHaveProperty('withdrawal');
  }
  expect(otpStore).toEqual(before);
  expect(mocks.email).not.toHaveBeenCalled();
  expect(mocks.wallets).not.toHaveBeenCalled();
  expect(mocks.query).not.toHaveBeenCalled();
  expect(add).not.toHaveBeenCalled();
});
