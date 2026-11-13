import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { USDC_MINTS } from '../../../../packages/shared/src/billing.js';

const fixture = vi.hoisted(() => ({
  query: vi.fn(),
  wallets: vi.fn(),
  recover: vi.fn(),
  seal: vi.fn(),
  receipt: vi.fn(), block: vi.fn()
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

vi.mock('viem', async (importOriginal) => ({
  ...await importOriginal<any>(),
  recoverTypedDataAddress: fixture.recover,
  createPublicClient: () => ({ getTransactionReceipt: fixture.receipt, getBlock: fixture.block }),
  http: vi.fn()
}));
vi.mock('viem/chains', () => ({ polygon: { id: 137 } }));

import { registerMeRoutes } from './me.js';
import { registerBillingRoutes, verifyPolygonUsdcTransferOnChain, verifySolanaUsdcTransferOnChain } from './billing.js';

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
  fixture.block.mockResolvedValue({ number: 100n });
  fixture.wallets.mockResolvedValue([]);
  fixture.query.mockResolvedValue([]);
  fixture.seal.mockResolvedValue('synthetic-sealed-envelope');
  fixture.recover.mockRejectedValue(new Error('synthetic invalid signature'));
});
afterEach(async () => { for (const server of apps.splice(0)) await server.close(); });

describe('Synthetic security invariants against actual route handlers', () => {
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
    fixture.receipt.mockResolvedValue({ status: 'success', blockNumber: 90n, logs: [{
      address: USDC_MINTS.polygon,
      topics: ['0x' + '0'.repeat(64), topic(OWNER), topic(treasury)],
      data: '0x' + (35_000_000n).toString(16).padStart(64, '0')
    }] });
    const result = await verifyPolygonUsdcTransferOnChain({ txHash: '0x' + '4'.repeat(64), expectedUsdc: 35, treasuryAddress: treasury });
    expect(result.verified).toBe(false);
  });
});

describe('strict canonical ERC20 Transfer verification', () => {
  const treasury = '0x3333333333333333333333333333333333333333';
  const transfer = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const approval = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';
  const log = () => ({ address: USDC_MINTS.polygon, topics: [transfer, '0x' + '0'.repeat(24) + OWNER.slice(2), '0x' + '0'.repeat(24) + treasury.slice(2)], data: '0x' + '2160ec0'.padStart(64, '0') });
  it.each(['approval', 'short-data', 'extra-topic', 'wrong-token', 'failed', 'unfinalized'])('rejects %s without creditable payment evidence', async (kind) => {
    const event = log();
    if (kind === 'approval') event.topics[0] = approval;
    if (kind === 'short-data') event.data = '0x2160ec0';
    if (kind === 'extra-topic') event.topics.push(event.topics[1]);
    if (kind === 'wrong-token') event.address = OTHER as any;
    fixture.receipt.mockResolvedValue({ status: kind === 'failed' ? 'reverted' : 'success', blockNumber: kind === 'unfinalized' ? 101n : 90n, logs: [event] });
    expect((await verifyPolygonUsdcTransferOnChain({ txHash: '0x' + '4'.repeat(64), expectedUsdc: 35, treasuryAddress: treasury })).verified).toBe(false);
  });
  it('accepts a finalized genuine USDC Transfer with the decoded payer and amount', async () => {
    fixture.receipt.mockResolvedValue({ status: 'success', blockNumber: 90n, logs: [log()] });
    expect(await verifyPolygonUsdcTransferOnChain({ txHash: '0x' + '4'.repeat(64), expectedUsdc: 35, treasuryAddress: treasury })).toEqual({ verified: true, payerAddress: OWNER, amountUsdc: 35 });
  });
});

it('preserves a valid linked-wallet claim and canonicalizes its owned reference', async () => {
  const server = app();
  const record = vi.fn().mockResolvedValue({ payment: { id: 'payment', txHash: '0x' + 'a'.repeat(64), amountUsdc: 35 }, updatedTier: 'operator', updatedExpiresAt: null });
  await registerBillingRoutes(server, {
    findPaymentIntentByMemo: async () => ({ userId: USER, status: 'pending', planId: 'operator_monthly', expiresAt: new Date(Date.now() + 60000) }),
    listAuthWallets: async () => [{ address: OWNER, chainKind: 'evm' }],
    verifyOnChainPayment: async () => ({ verified: true, payerAddress: OWNER, amountUsdc: 35 }), recordCryptoPaymentAndGrantTier: record
  } as any);
  const result = await server.inject({ method: 'POST', url: '/v1/billing/crypto/verify', payload: { chain: 'polygon', planId: 'operator_monthly', txHash: '0x' + 'A'.repeat(64), memo: '  OWNED  ' } });
  expect(result.statusCode).toBe(200);
  expect(record.mock.calls[0][0]).toMatchObject({ txHash: '0x' + 'a'.repeat(64), memo: 'OWNED', payerAddress: OWNER });
});
it('attributes Solana USDC to its debited signing owner, never an unrelated fee payer', async () => {
  const owner = '11111111111111111111111111111111';
  const treasury = 'So11111111111111111111111111111111111111112';
  const feePayer = 'FeePayerFixture';
  const balance = (accountIndex: number, owner: string, amount: string) => ({ accountIndex, owner, mint: USDC_MINTS.solana, uiTokenAmount: { amount, decimals: 6, uiAmount: Number(amount) / 1e6 } });
  const response = { result: { meta: { err: null, preTokenBalances: [balance(1, owner, '35000000'), balance(2, treasury, '0')], postTokenBalances: [balance(1, owner, '0'), balance(2, treasury, '35000000')] }, transaction: { message: { accountKeys: [{ pubkey: feePayer, signer: true }, { pubkey: owner, signer: true }] } } } };
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => response }));
  try {
    expect(await verifySolanaUsdcTransferOnChain({ txHash: '3'.repeat(88), expectedUsdc: 35, treasuryAddress: treasury })).toEqual({ verified: true, payerAddress: owner, amountUsdc: 35 });
    response.result.transaction.message.accountKeys[1].signer = false;
    expect((await verifySolanaUsdcTransferOnChain({ txHash: '3'.repeat(88), expectedUsdc: 35, treasuryAddress: treasury })).verified).toBe(false);
  } finally { vi.unstubAllGlobals(); }
});
