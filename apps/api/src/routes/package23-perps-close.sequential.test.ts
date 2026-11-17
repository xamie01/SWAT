import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  class PerpsCloseUnavailableError extends Error {
    readonly code = 'PERPS_CLOSE_UNAVAILABLE';
    constructor() {
      super('Financial close is unavailable: reducing execution and reconciliation are not configured');
      this.name = 'PerpsCloseUnavailableError';
    }
  }
  return {
    close: vi.fn(), account: vi.fn(), positions: vi.fn(), query: vi.fn(), add: vi.fn(),
    PerpsCloseUnavailableError
  };
});
vi.mock('@swat/db', () => ({
  scopedQuery: (_scope: { userId: string }, sql: string, values: unknown[]) => mocks.query(sql, values),
  query: mocks.query, forUser: (userId: string) => ({ userId }),
  findUserById: vi.fn(), resolveSession: vi.fn(), listAuthWallets: vi.fn(),
  isSubscribed: vi.fn(), listTokenWatches: vi.fn(), listWalletSubscriptions: vi.fn(),
  QuotaExceededError: class extends Error {}, requestTokenWatch: vi.fn(), subscribeToWallet: vi.fn(),
  beginWindDown: vi.fn(), requestCloseAll: vi.fn(), getWalletScoringReadiness: vi.fn(),
  checkWalletClusterIndependence: vi.fn(), checkWalletHubStatus: vi.fn(), getPerpsInstruments: vi.fn(),
  getPerpsAccount: mocks.account, getUserPerpsPositions: mocks.positions,
  closePerpsPosition: mocks.close, PerpsCloseUnavailableError: mocks.PerpsCloseUnavailableError
}));
vi.mock('@swat/shared', async () => {
  const validation = await import('../../../../packages/shared/src/validation.js');
  return {
    chainSchema: validation.chainSchema, buildClobAuthTypedData: vi.fn(),
    deriveWakeVaultAddress: vi.fn(), capabilitiesFor: vi.fn(), createWalletBackfillJob: vi.fn(),
    isValidAddressForChain: vi.fn(), resolveChainAddress: vi.fn(), tierAllowsChain: vi.fn()
  };
});
import { registerMeRoutes } from './me.js';

const USER = '11111111-1111-4111-8111-111111111111';
const servers: ReturnType<typeof Fastify>[] = [];

async function serverFor(principal: 'user' | 'service' | 'anonymous' = 'user') {
  const server = Fastify({ logger: false });
  servers.push(server);
  server.addHook('onRequest', async request => {
    if (principal === 'user') {
      request.principal = { kind: 'user', sessionId: null, user: {
        id: USER, email: 'fixture@example.invalid', role: 'user', status: 'active', tier: 'free'
      } as never };
    } else if (principal === 'service') {
      request.principal = { kind: 'service' };
    }
  });
  await registerMeRoutes(server, {
    backfillQueue: { add: mocks.add } as never, tokenDiscoveryQueue: { add: mocks.add } as never
  });
  return server;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.close.mockResolvedValue(false);
  mocks.account.mockResolvedValue(null);
  mocks.positions.mockResolvedValue([]);
});
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

describe('package23 truthful perps close route', () => {
  it.each(['anonymous', 'service'] as const)('rejects %s before any financial reader or writer', async principal => {
    const server = await serverFor(principal);
    const response = await server.inject({ method: 'POST', url: '/v1/me/perps/positions/position-1/close' });
    expect(response.statusCode).toBe(401);
    expect(mocks.close).not.toHaveBeenCalled();
    expect(mocks.positions).not.toHaveBeenCalled();
    expect(mocks.account).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.add).not.toHaveBeenCalled();
  });

  it('returns 404 for a missing or other-tenant position without claiming closure', async () => {
    const server = await serverFor();
    const response = await server.inject({ method: 'POST', url: '/v1/me/perps/positions/position-1/close' });
    expect(response.statusCode).toBe(404);
    expect(mocks.close).toHaveBeenCalledWith('position-1', USER);
    expect(response.json()).not.toHaveProperty('success');
    expect(response.json()).not.toHaveProperty('status', 'closed');
    expect(mocks.add).not.toHaveBeenCalled();
  });

  it('returns typed 503 for exposed owned positions and makes no financial success claim', async () => {
    mocks.close.mockRejectedValue(new mocks.PerpsCloseUnavailableError());
    const server = await serverFor();
    const response = await server.inject({ method: 'POST', url: '/v1/me/perps/positions/position-1/close' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'PERPS_CLOSE_UNAVAILABLE', supported: false });
    expect(response.json()).not.toHaveProperty('success');
    expect(response.json()).not.toHaveProperty('status', 'closed');
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.add).not.toHaveBeenCalled();
  });

  it.each(['/v1/me/positions/position-1/exit', '/v1/me/positions/close-all'])('refuses financial closure at %s without erasing exposure', async url => {
    mocks.query.mockResolvedValue([{ id: 'position-1' }]);
    const server = await serverFor();
    const response = await server.inject({ method: 'POST', url });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'POSITION_EXIT_UNAVAILABLE', supported: false });
    expect(response.json()).not.toHaveProperty('success');
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.add).not.toHaveBeenCalled();
  });

  it('exposes missing perps account observations as unknown, not fabricated zero margin', async () => {
    const server = await serverFor();
    const response = await server.inject({ method: 'GET', url: '/v1/me/perps/portfolio' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ account: null, accountAssessment: 'unassessed', reducingExecution: { supported: false } });
    expect(response.json().reducingExecution.unavailableReasons).toContain('provider-receipt-reconciliation-unavailable');
  });

  it('does not classify an unrelated storage failure as a supported close result', async () => {
    mocks.close.mockRejectedValue(new Error('fixture-storage-unavailable'));
    const server = await serverFor();
    const response = await server.inject({ method: 'POST', url: '/v1/me/perps/positions/position-1/close' });
    expect(response.statusCode).toBe(500);
    expect(response.json()).not.toHaveProperty('code', 'PERPS_CLOSE_UNAVAILABLE');
    expect(response.json()).not.toHaveProperty('success');
    expect(mocks.add).not.toHaveBeenCalled();
  });
});
