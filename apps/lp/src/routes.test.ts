import { beforeEach, describe, expect, it, vi } from 'vitest';

// The routes module reads pool/position data through @swat/db; mock it so the
// HTTP layer is testable without a database.
const dbMocks = vi.hoisted(() => ({
  listDiscoverPools: vi.fn(),
  listLpPositions: vi.fn(),
  queryLpWalletLeaderboard: vi.fn(),
  resolveSession: vi.fn(),
  forUser: vi.fn((userId: string) => ({ userId })),
  getLpPosition: vi.fn(),
  setLpPositionAutoRebalance: vi.fn(),
  transitionLpPosition: vi.fn(),
  trackLpWallet: vi.fn(),
  untrackLpWallet: vi.fn(),
  createLpCopySubscription: vi.fn(),
  listLpCopySubscriptions: vi.fn(),
  updateLpCopySubscriptionStatus: vi.fn(),
  listLpCopyExecutions: vi.fn()
}));
vi.mock('@swat/db', () => dbMocks);

import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { createHash } from 'node:crypto';
import { registerLpAuth, legacyKeyHash } from './auth.js';
import { registerLpRoutes, type LpRoutesDeps } from './routes.js';

async function buildApp(deps: Partial<LpRoutesDeps> = {}) {
  const app = Fastify({ logger: false });
  await (app.register as any)(cookie);
  // Direct calls, not app.register: the auth hook must apply to the routes'
  // sibling scope (same pattern apps/api uses to avoid encapsulation).
  await registerLpAuth(app, { resolveSession: dbMocks.resolveSession, legacyKeyHash: legacyKeyHash('service-key') });
  await registerLpRoutes(app, {
    deployGuard: {
      assertDeployAllowed: async () => ({ allowed: true, reasons: [] })
    },
    executionMode: { resolveMode: async () => 'paper' },
    poolView: {
      getPool: async () => ({ protocol: 'meteora-dlmm', binStep: 50, tickSpacing: null, currentPrice: 100 })
    },
    userAddress: 'solana:user',
    livePreview: async () => ({
      chain: 'solana',
      poolAddress: 'solana:pool',
      params: { rangeLower: 0.296, rangeUpper: 0.302, rungCount: 5, distribution: 'spot' },
      rungs: [],
      depositAmount: null,
      source: 'template',
      contextWarning: null
    }),
    operations: {
      executionMode: { resolveMode: async () => 'paper' },
      getPosition: dbMocks.getLpPosition,
      findOperation: async () => null,
      request: async (_scope, input) => ({ id: 'op', userId: 'user-1', positionId: input.positionId, kind: input.kind, status: 'pending' }),
      complete: async () => ({ id: 'op', userId: 'user-1', positionId: 'pos-1', kind: 'close', status: 'completed' }),
      replan: async () => ({ version: 1, rangeLower: 90, rangeUpper: 110, rungs: [], steps: [], poolObservedAt: new Date().toISOString() }),
      enqueue: async () => {}
    },
    queueManualRebalance: async () => undefined,
    ...deps
  });
  return app;
}

const serviceHeaders = { 'x-api-key': 'service-key' };

/** Session-cookie credentials: resolveSession + CSRF double-submit, like a browser. */
const sessionCookie = 'session-token';
const csrfToken = 'csrf-token';
function sessionHeaders() {
  return {
    cookie: `swat_session=${sessionCookie}; swat_csrf=${csrfToken}`,
    'x-csrf-token': csrfToken
  };
}

beforeEach(() => {
  for (const mock of Object.values(dbMocks)) mock.mockReset();
  dbMocks.forUser.mockImplementation((userId: string) => ({ userId }));
  dbMocks.resolveSession.mockResolvedValue({
    user: { id: 'user-1', status: 'active', role: 'user' },
    sessionId: 'session-1'
  });
});

describe('LP routes (Track H)', () => {
  it('health is public; everything else needs a principal', async () => {
    const app = await buildApp();
    await app.ready();

    expect((await app.inject({ method: 'GET', url: '/v1/health' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/v1/lp/discover' })).statusCode).toBe(401);
    await app.close();
  });

  it('the legacy service key authenticates with a constant-time hash check', async () => {
    const app = await buildApp();
    await app.ready();
    dbMocks.listDiscoverPools.mockResolvedValue([]);

    const ok = await app.inject({
      method: 'GET',
      url: '/v1/lp/discover',
      headers: serviceHeaders
    });
    expect(ok.statusCode).toBe(200);
    await app.close();
  });

  it('discover validates chain and sort, and clamps the limit', async () => {
    const app = await buildApp();
    await app.ready();
    dbMocks.listDiscoverPools.mockResolvedValue([]);

    const badChain = await app.inject({ method: 'GET', url: '/v1/lp/discover?chain=avalanche', headers: serviceHeaders });
    expect(badChain.statusCode).toBe(400);

    const badSort = await app.inject({ method: 'GET', url: '/v1/lp/discover?sort=bogus', headers: serviceHeaders });
    expect(badSort.statusCode).toBe(400);

    const clamped = await app.inject({ method: 'GET', url: '/v1/lp/discover?limit=99999', headers: serviceHeaders });
    expect(clamped.statusCode).toBe(200);
    expect(clamped.json().limit).toBe(200); // clamped
    await app.close();
  });

  it('positions refuse the service principal — it carries no tenant', async () => {
    const app = await buildApp();
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/v1/lp/positions', headers: serviceHeaders });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('strategy templates list the four presets without tenant scope', async () => {
    const app = await buildApp();
    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: '/v1/lp/strategy-templates',
      headers: serviceHeaders
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().templates.map((t: { name: string }) => t.name)).toHaveLength(4);
    await app.close();
  });

  it('legacy numeric deploy is unavailable before any build or guard callback', async () => {
    const build = vi.fn(), guard = { assertDeployAllowed: vi.fn() };
    const app = await buildApp({ build, deployGuard: guard }); await app.ready();
    const response = await app.inject({ method: 'POST', url: '/v1/lp/positions/deploy', headers: sessionHeaders(),
      payload: { depositAmount: 100, autoRebalance: true } });
    expect(response.statusCode).toBe(503); expect(build).not.toHaveBeenCalled(); expect(guard.assertDeployAllowed).not.toHaveBeenCalled();
    await app.close();
  });

  it('legacyKeyHash is a deterministic sha-256 of the key', () => {
    expect(legacyKeyHash('x').equals(createHash('sha256').update('x').digest())).toBe(true);
  });

  describe('ladder preview (Track I2)', () => {
    it('passes template queries through to the live preview', async () => {
      const app = await buildApp({
        livePreview: vi.fn(async () => ({ source: 'template', rungs: [{ weight: 1 }] }))
      });
      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/v1/lp/ladder-preview?chain=solana&poolAddress=solana:pool&template=tight-spot-scalp&depositAmount=1000',
        headers: serviceHeaders
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().source).toBe('template');
      await app.close();
    });

    it('requires chain, poolAddress, and some params source', async () => {
      const app = await buildApp();
      await app.ready();

      expect((await app.inject({ method: 'GET', url: '/v1/lp/ladder-preview', headers: serviceHeaders })).statusCode).toBe(400);
      expect((await app.inject({ method: 'GET', url: '/v1/lp/ladder-preview?chain=solana&poolAddress=solana:pool', headers: serviceHeaders })).statusCode).toBe(400);
      expect((await app.inject({ method: 'GET', url: '/v1/lp/ladder-preview?chain=avalanche&poolAddress=x&template=t', headers: serviceHeaders })).statusCode).toBe(400);
      await app.close();
    });

    it('surfaces preview validation errors as 400 and context failures as 500', async () => {
      const app = await buildApp({
        livePreview: vi.fn(async () => {
          throw new Error('unknown strategy template: moonshot');
        })
      });
      await app.ready();
      const validation = await app.inject({
        method: 'GET',
        url: '/v1/lp/ladder-preview?chain=solana&poolAddress=solana:pool&template=moonshot',
        headers: serviceHeaders
      });
      expect(validation.statusCode).toBe(400);

      const failing = await buildApp({
        livePreview: vi.fn(async () => {
          throw new Error('RPC timeout');
        })
      });
      await failing.ready();
      const internal = await failing.inject({
        method: 'GET',
        url: '/v1/lp/ladder-preview?chain=solana&poolAddress=solana:pool&template=tight-spot-scalp',
        headers: serviceHeaders
      });
      expect(internal.statusCode).toBe(500);
      await app.close();
      await failing.close();
    });
  });

  // A shape-complete owned position shared by the stateful-route tests below.
  const owned = {
    id: 'pos-1',
    userId: 'user-1',
    chain: 'solana',
    protocol: 'meteora-dlmm',
    poolAddress: 'solana:pool',
    strategyType: 'spot',
    rangeLower: 0.29,
    rangeUpper: 0.31,
    rungAllocations: [],
    depositAmount: 1000,
    depositAsset: 'solana:usdc',
    state: 'active',
    onChainPositionAddress: null,
    acquisitionMode: 'paper',
    paperPlan: { version: 1 },
    autoRebalance: false,
    openedAt: new Date(),
    closedAt: null,
    updatedAt: new Date()
  };

  describe('manual rebalance receipt capability', () => {
    it('legacy request/complete/queue seams are unavailable and cannot mutate state', async () => {
      const app = await buildApp(); await app.ready();
      const response = await app.inject({ method: 'POST', url: '/v1/lp/positions/pos-1/rebalance', headers: sessionHeaders(), payload: { operationKey: 'rebal' } });
      expect(response.statusCode).toBe(503); expect(dbMocks.transitionLpPosition).not.toHaveBeenCalled(); await app.close();
    });
  });

  describe('auto-rebalance toggle (Track I)', () => {
    it('flips the flag for the owning user and rejects non-boolean input', async () => {
      const app = await buildApp();
      await app.ready();
      dbMocks.getLpPosition.mockResolvedValue({ id: 'pos-1', state: 'active' });

      const on = await app.inject({
        method: 'PATCH',
        url: '/v1/lp/positions/pos-1/auto-rebalance',
        headers: sessionHeaders(),
        payload: { enabled: true }
      });
      expect(on.statusCode).toBe(200);
      expect(on.json()).toEqual({ positionId: 'pos-1', autoRebalance: true });
      expect(dbMocks.setLpPositionAutoRebalance).toHaveBeenCalledWith(expect.anything(), 'pos-1', true);

      const bad = await app.inject({
        method: 'PATCH',
        url: '/v1/lp/positions/pos-1/auto-rebalance',
        headers: sessionHeaders(),
        payload: { enabled: 'yes' }
      });
      expect(bad.statusCode).toBe(400);
      await app.close();
    });

    it('cookie POST/PATCH without the CSRF token is rejected before anything runs', async () => {
      const app = await buildApp();
      await app.ready();
      const response = await app.inject({
        method: 'PATCH',
        url: '/v1/lp/positions/pos-1/auto-rebalance',
        headers: { cookie: 'swat_session=session-token' },
        payload: { enabled: true }
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe('csrf_invalid');
      expect(dbMocks.setLpPositionAutoRebalance).not.toHaveBeenCalled();
      await app.close();
    });
  });

  describe('close receipt capability', () => {
    it('missing exact domain refuses even when legacy complete callback claims completed', async () => {
      const app = await buildApp(); await app.ready();
      const response = await app.inject({ method: 'POST', url: '/v1/lp/positions/pos-1/close', headers: sessionHeaders(), payload: { operationKey: 'close' } });
      expect(response.statusCode).toBe(503); expect(dbMocks.transitionLpPosition).not.toHaveBeenCalled(); await app.close();
    });
  });

  describe('tracked-wallet on-ramp (service key only)', () => {
    it('tracks a chain-prefixed wallet with the service key', async () => {
      const app = await buildApp();
      await app.ready();
      dbMocks.trackLpWallet.mockResolvedValue({
        id: 'w-1',
        chain: 'solana',
        walletAddress: 'solana:9xQe',
        label: null,
        pollingCadenceSeconds: 300,
        lastIndexedAt: null,
        createdAt: new Date()
      });

      const response = await app.inject({
        method: 'POST',
        url: '/v1/lp/wallets',
        headers: serviceHeaders,
        payload: { chain: 'solana', walletAddress: 'solana:9xQe', label: 'whale' }
      });

      expect(response.statusCode).toBe(200);
      expect(dbMocks.trackLpWallet).toHaveBeenCalledWith(
        expect.objectContaining({ chain: 'solana', walletAddress: 'solana:9xQe', label: 'whale' })
      );
      await app.close();
    });

    it('a user session cannot track wallets — they are platform data, not tenant data', async () => {
      const app = await buildApp();
      await app.ready();

      const response = await app.inject({
        method: 'POST',
        url: '/v1/lp/wallets',
        headers: sessionHeaders(),
        payload: { chain: 'solana', walletAddress: 'solana:9xQe' }
      });
      expect(response.statusCode).toBe(403);
      expect(dbMocks.trackLpWallet).not.toHaveBeenCalled();
      await app.close();
    });

    it('validates chain and prefix before touching the store', async () => {
      const app = await buildApp();
      await app.ready();

      const badChain = await app.inject({
        method: 'POST',
        url: '/v1/lp/wallets',
        headers: serviceHeaders,
        payload: { chain: 'avalanche', walletAddress: '0xabc' }
      });
      expect(badChain.statusCode).toBe(400);

      const bare = await app.inject({
        method: 'POST',
        url: '/v1/lp/wallets',
        headers: serviceHeaders,
        payload: { chain: 'solana', walletAddress: '9xQe' }
      });
      expect(bare.statusCode).toBe(400);
      expect(dbMocks.trackLpWallet).not.toHaveBeenCalled();
      await app.close();
    });

    it('untracks through the query string and reports whether a row was removed', async () => {
      const app = await buildApp();
      await app.ready();
      dbMocks.untrackLpWallet.mockResolvedValue(true);

      const response = await app.inject({
        method: 'DELETE',
        url: '/v1/lp/wallets?chain=solana&walletAddress=solana:9xQe',
        headers: serviceHeaders
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ removed: true });
      expect(dbMocks.untrackLpWallet).toHaveBeenCalledWith('solana', 'solana:9xQe');
      await app.close();
    });
  });

  describe('LP copy trading and new launches routes', () => {
    it('creates copy subscription with user session and validates parameters', async () => {
      const app = await buildApp();
      await app.ready();
      dbMocks.createLpCopySubscription.mockResolvedValue({
        id: 'sub-1',
        userId: 'user-1',
        masterWalletAddress: 'solana:whale1',
        chain: 'solana',
        venue: 'meteora-dlmm',
        allocatedBudgetUsd: 1000,
        maxCapitalPerPositionUsd: 500,
        status: 'active'
      });

      const response = await app.inject({
        method: 'POST',
        url: '/v1/lp/copy/subscribe',
        headers: sessionHeaders(),
        payload: {
          masterWalletAddress: 'solana:whale1',
          chain: 'solana',
          venue: 'meteora-dlmm',
          allocatedBudgetUsd: 1000,
          maxCapitalPerPositionUsd: 500
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().id).toBe('sub-1');
      expect(dbMocks.createLpCopySubscription).toHaveBeenCalled();
      // A subscriber must never onboard or overwrite service-owned registry data.
      expect(dbMocks.trackLpWallet).not.toHaveBeenCalled();
      await app.close();
    });

    it('rejects copy subscription with un-prefixed master address or bad chain', async () => {
      const app = await buildApp();
      await app.ready();

      const badPrefix = await app.inject({
        method: 'POST',
        url: '/v1/lp/copy/subscribe',
        headers: sessionHeaders(),
        payload: {
          masterWalletAddress: 'whale1',
          chain: 'solana',
          venue: 'meteora-dlmm',
          allocatedBudgetUsd: 1000,
          maxCapitalPerPositionUsd: 500
        }
      });
      expect(badPrefix.statusCode).toBe(400);

      const badChain = await app.inject({
        method: 'POST',
        url: '/v1/lp/copy/subscribe',
        headers: sessionHeaders(),
        payload: {
          masterWalletAddress: 'avalanche:whale1',
          chain: 'avalanche',
          venue: 'uniswap-v3',
          allocatedBudgetUsd: 1000,
          maxCapitalPerPositionUsd: 500
        }
      });
      expect(badChain.statusCode).toBe(400);
      await app.close();
    });

    it('lists user copy subscriptions and executions', async () => {
      const app = await buildApp();
      await app.ready();
      dbMocks.listLpCopySubscriptions.mockResolvedValue([{ id: 'sub-1' }]);
      dbMocks.listLpCopyExecutions.mockResolvedValue([{ id: 'exec-1' }]);

      const subsRes = await app.inject({
        method: 'GET',
        url: '/v1/lp/copy/subscriptions',
        headers: sessionHeaders()
      });
      expect(subsRes.statusCode).toBe(200);
      expect(subsRes.json().subscriptions).toHaveLength(1);

      const execRes = await app.inject({
        method: 'GET',
        url: '/v1/lp/copy/executions',
        headers: sessionHeaders()
      });
      expect(execRes.statusCode).toBe(200);
      expect(execRes.json().executions).toHaveLength(1);
      await app.close();
    });

    it('returns filtered new launches feed', async () => {
      const app = await buildApp();
      await app.ready();
      dbMocks.listDiscoverPools.mockResolvedValue([
        {
          id: 'p1',
          chain: 'solana',
          protocol: 'meteora-dlmm',
          poolAddress: 'solana:pool1',
          pairLabel: 'HOT/SOL',
          baseTokenMint: 'solana:base1',
          quoteTokenMint: 'solana:quote1',
          feeBps: 100,
          binStep: 20,
          tickSpacing: null,
          currentPrice: 1.0,
          tvl: 50000,
          activeTvl: 25000,
          volume24h: 100000,
          feeApr24h: 300,
          feeApr7d: null,
          riskScore: 10,
          riskFlags: [],
          lastScannedAt: new Date(),
          createdAt: new Date()
        }
      ]);

      const res = await app.inject({
        method: 'GET',
        url: '/v1/lp/new-launches',
        headers: serviceHeaders
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().newLaunches).toHaveLength(1);
      expect(res.json().newLaunches[0].pairLabel).toBe('HOT/SOL');
      await app.close();
    });
  });
});
