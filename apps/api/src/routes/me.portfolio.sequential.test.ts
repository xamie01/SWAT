import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ query: vi.fn(), account: vi.fn(), positions: vi.fn(), add: vi.fn(), subscribed: vi.fn(), scopes: [] as { userId: string }[] }));
vi.mock('@swat/db', () => ({
  scopedQuery: (scope: { userId: string }, sql: string, values: unknown[]) => { mocks.scopes.push(scope); return mocks.query(sql, values); },
  query: mocks.query, forUser: (userId: string) => ({ userId }), findUserById: vi.fn(), resolveSession: vi.fn(), listAuthWallets: vi.fn(),
  isSubscribed: mocks.subscribed, listTokenWatches: vi.fn(), listWalletSubscriptions: vi.fn(), QuotaExceededError: class extends Error {}, requestTokenWatch: vi.fn(), subscribeToWallet: vi.fn(), beginWindDown: vi.fn(), requestCloseAll: vi.fn(), getWalletScoringReadiness: vi.fn(), checkWalletClusterIndependence: vi.fn(), checkWalletHubStatus: vi.fn(), getPerpsInstruments: vi.fn(), getPerpsAccount: mocks.account, getUserPerpsPositions: mocks.positions, closePerpsPosition: vi.fn(), PerpsCloseUnavailableError: class extends Error {}
}));
vi.mock('@swat/shared', async () => ({
  chainSchema: (await import('../../../../packages/shared/src/validation.js')).chainSchema,
  buildClobAuthTypedData: vi.fn(), deriveWakeVaultAddress: vi.fn(), capabilitiesFor: vi.fn(), createWalletBackfillJob: vi.fn(), isValidAddressForChain: vi.fn(), resolveChainAddress: vi.fn(), tierAllowsChain: vi.fn()
}));
import { registerMeRoutes } from './me.js';
const USER = '11111111-1111-4111-8111-111111111111';
const servers: ReturnType<typeof Fastify>[] = [];
async function serverFor(principal: 'user' | 'service' | 'anonymous' = 'user') {
  const server = Fastify({ logger: false }); servers.push(server);
  server.addHook('onRequest', async request => {
    if (principal === 'user') request.principal = { kind: 'user', sessionId: null, user: { id: USER, email: 'fixture@example.invalid', role: 'user', tier: 'free', status: 'active' } as never };
    if (principal === 'service') request.principal = { kind: 'service' };
  });
  await registerMeRoutes(server, { backfillQueue: { add: mocks.add } as never, tokenDiscoveryQueue: { add: mocks.add } as never });
  return server;
}
beforeEach(() => { mocks.scopes.length = 0; vi.clearAllMocks(); mocks.subscribed.mockResolvedValue(true); mocks.query.mockResolvedValue([]); mocks.account.mockResolvedValue(null); mocks.positions.mockResolvedValue([]); });
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); });
const row = { id: 'observed-position', chain: 'solana', token_mint: 'observed-token', confirmed_quantity: '2', cost_basis_usd: '12', token_symbol: null, master_wallet_address: null, latest_price_usd: null };
describe('actual portfolio API observations and immutable refusal', () => {
  it.each(['anonymous', 'service'] as const)('rejects %s without tenant financial reads', async principal => {
    const server = await serverFor(principal);
    for (const url of ['/v1/me/positions', '/v1/me/perps/portfolio']) expect((await server.inject({ method: 'GET', url })).statusCode).toBe(401);
    expect(mocks.query).not.toHaveBeenCalled(); expect(mocks.account).not.toHaveBeenCalled(); expect(mocks.positions).not.toHaveBeenCalled();
  });
  it('account, positions and grant reads/revocation all supply session scope rather than WHERE-only RLS', async () => {
    const server = await serverFor();
    const db = await import('@swat/db');
    vi.mocked(db.listAuthWallets).mockResolvedValue([]);
    for (const url of ['/v1/me/account?userId=other', '/v1/me/positions?userId=other', '/v1/me/vault?userId=other']) {
      expect((await server.inject({ url })).statusCode).toBe(200);
    }
    const revoke = await server.inject({ method: 'POST', url: '/v1/me/vault/revoke', payload: { chain: 'all' } });
    expect(revoke.statusCode).toBe(200); expect(revoke.json().message).toContain('No active');
    expect(mocks.scopes).toHaveLength(6); expect(mocks.scopes.every(scope => scope.userId === USER)).toBe(true);
    expect(mocks.query.mock.calls.filter(([sql]) => String(sql).includes('UPDATE user_execution_grants'))[0]![1]).toEqual([USER]);
  });
  it('observed empty exposes blocked reducing capabilities rather than execution authority', async () => {
    const server = await serverFor();
    const response = await server.inject({ method: 'GET', url: '/v1/me/positions?userId=other-tenant' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ positions: [], positionsAssessment: 'observed-runtime-unverified', reducingExecution: { supported: false }, closeAllExecution: { supported: false } });
    expect(mocks.scopes).toEqual([{ userId: USER }]);
    expect(mocks.query.mock.calls[0][1]).toEqual([USER]);
  });
  it.each([null, '', 'NaN', 'Infinity', '-1'])('missing/invalid mark %s has no fabricated current value or PnL', async price => {
    mocks.query.mockResolvedValue([{ ...row, latest_price_usd: price }]);
    const server = await serverFor();
    const response = await server.inject({ method: 'GET', url: '/v1/me/positions' });
    expect(response.json().positions[0]).toMatchObject({ confirmedQuantity: 2, costBasisUsd: 12, currentPriceUsd: null, currentValueUsd: null, unrealizedPnlUsd: null, unrealizedPnlPct: null, valuationAssessment: 'unassessed' });
  });
  it('observed mark yields observed value and PnL, not a live execution claim', async () => {
    mocks.query.mockResolvedValue([{ ...row, latest_price_usd: '10' }]);
    const server = await serverFor(); const response = await server.inject({ method: 'GET', url: '/v1/me/positions' });
    expect(response.json().positions[0]).toMatchObject({ currentValueUsd: 20, unrealizedPnlUsd: 8, valuationAssessment: 'observed-runtime-unverified' });
    expect(response.json().reducingExecution.supported).toBe(false);
  });
  it('reader failure is HTTP failure, never an invented empty or zero-risk account', async () => {
    mocks.query.mockRejectedValue(new Error('storage unavailable')); mocks.account.mockRejectedValue(new Error('storage unavailable'));
    const server = await serverFor();
    for (const url of ['/v1/me/positions', '/v1/me/perps/portfolio']) {
      const response = await server.inject({ method: 'GET', url }); expect(response.statusCode).toBe(500);
      expect(response.json()).not.toHaveProperty('positions'); expect(response.json()).not.toHaveProperty('account');
    }
  });
  it('holdings project unknown basis separately from the stored known subtotal', async () => {
    mocks.query.mockResolvedValue([{ token_mint: 'solana:fixture', balance: '2', cost_basis_usd: null,
      known_cost_basis_subtotal_usd: '12', basis_assessment: 'partial', unvalued_acquisition_count: '1' }]);
    const server = await serverFor();
    const response = await server.inject({ method: 'GET', url: '/v1/me/wallets/solana:fixture/holdings' });
    expect(response.statusCode).toBe(200);
    expect(response.json().holdings[0]).toMatchObject({ cost_basis_usd: null,
      known_cost_basis_subtotal_usd: '12', basis_assessment: 'partial' });
    const [sql, values] = mocks.query.mock.calls[0];
    expect(sql).toContain('LEFT JOIN source_verified_position_scopes');
    expect(sql).toContain('scope.unvalued_acquisition_count = 0');
    expect(sql).toContain('ELSE NULL END AS cost_basis_usd');
    expect(values).toEqual(['solana:fixture']);
    expect(mocks.subscribed).toHaveBeenCalledWith({ userId: USER }, 'solana:fixture');
  });
  it('perps portfolio scopes both readers to session and preserves missing account', async () => {
    const server = await serverFor(); const response = await server.inject({ method: 'GET', url: '/v1/me/perps/portfolio?userId=other-tenant' });
    expect(response.json()).toMatchObject({ account: null, accountAssessment: 'unassessed', positions: [], reducingExecution: { supported: false } });
    expect(mocks.account).toHaveBeenCalledWith(USER); expect(mocks.positions).toHaveBeenCalledWith(USER, 'open');
  });
});
