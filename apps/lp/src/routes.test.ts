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
  transitionLpPosition: vi.fn()
}));
vi.mock('@swat/db', () => dbMocks);

import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { createHash } from 'node:crypto';
import { registerLpAuth, legacyKeyHash } from './auth.js';
import { registerLpRoutes, type LpRoutesDeps } from './routes.js';

async function buildApp(deps: Partial<LpRoutesDeps> = {}) {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  // Direct calls, not app.register: the auth hook must apply to the routes'
  // sibling scope (same pattern apps/api uses to avoid encapsulation).
  await registerLpAuth(app, { legacyKeyHash: legacyKeyHash('service-key') });
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

    const badChain = await app.inject({ method: 'GET', url: '/v1/lp/discover?chain=ethereum', headers: serviceHeaders });
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

  it('deploy returns 400 on a missing body before touching the guard', async () => {
    const guard = { assertDeployAllowed: vi.fn() };
    const app = await buildApp({ deployGuard: guard });
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/lp/positions/deploy',
      headers: sessionHeaders(),
      payload: {}
    });
    expect(response.statusCode).toBe(400);
    expect(guard.assertDeployAllowed).not.toHaveBeenCalled();
    await app.close();
  });

  it('deploy surfaces guardrail refusals as 403 with reasons', async () => {
    const app = await buildApp({
      deployGuard: {
        assertDeployAllowed: async () => ({ allowed: false, reasons: ['pool-exposure-cap'] })
      },
      // The build entrypoint returns refusal reasons with an empty bundle only
      // after running the guard; stub it via the poolView path (build is not
      // overridden here, so drive it with the guard refusal translated by the
      // route) — instead, override build to emulate the entrypoint contract.
      build: (async () => ({
        positionId: '',
        mode: 'paper' as const,
        rungs: [],
        steps: [],
        rejectionReasons: ['pool-exposure-cap']
      })) as never
    });
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/lp/positions/deploy',
      headers: sessionHeaders(),
      payload: {
        chain: 'solana',
        poolAddress: 'solana:pool',
        template: 'tight-spot-scalp',
        depositAmount: 100,
        depositAsset: 'solana:usdc'
      }
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().reasons).toEqual(['pool-exposure-cap']);
    await app.close();
  });

  it('deploy carries the auto-rebalance opt-in into the built position', async () => {
    const build = vi.fn(async (_deps, _scope, request) => {
      expect(request.autoRebalance).toBe(true);
      return {
        positionId: 'pos-1',
        mode: 'paper' as const,
        rungs: [],
        steps: [],
        rejectionReasons: []
      };
    });
    const app = await buildApp({ build: build as never });
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/lp/positions/deploy',
      headers: sessionHeaders(),
      payload: {
        chain: 'solana',
        poolAddress: 'solana:pool',
        template: 'tight-spot-scalp',
        depositAmount: 100,
        depositAsset: 'solana:usdc',
        autoRebalance: true
      }
    });
    expect(response.statusCode).toBe(200);
    expect(build).toHaveBeenCalled();
    await app.close();
  });

  it('a successful paper deploy returns the plan with rungs and steps', async () => {
    const app = await buildApp({
      build: (async () => ({
        positionId: 'pos-1',
        mode: 'paper' as const,
        rungs: [{ priceLower: 99, priceUpper: 101, weight: 1, allocation: 100 }],
        steps: [{ rungIndex: 0, kind: 'initialize-position-and-add-liquidity', totalXAmount: 100, totalYAmount: 0, binLower: 0, binUpper: 1, strategy: 'spot', description: 'rung 0' }],
        rejectionReasons: []
      })) as never
    });
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/lp/positions/deploy',
      headers: sessionHeaders(),
      payload: {
        chain: 'solana',
        poolAddress: 'solana:pool',
        template: 'tight-spot-scalp',
        depositAmount: 100,
        depositAsset: 'solana:usdc'
      }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.positionId).toBe('pos-1');
    expect(body.mode).toBe('paper');
    expect(body.steps).toHaveLength(1);
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
      expect((await app.inject({ method: 'GET', url: '/v1/lp/ladder-preview?chain=ethereum&poolAddress=x&template=t', headers: serviceHeaders })).statusCode).toBe(400);
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

  describe('manual rebalance trigger (Track I)', () => {
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
      autoRebalance: false,
      openedAt: new Date(),
      closedAt: null,
      updatedAt: new Date()
    };

    it('queues the job, transitions to rebalancing, and reports both', async () => {
      const queueManualRebalance = vi.fn(async () => undefined);
      const app = await buildApp({ queueManualRebalance });
      await app.ready();
      dbMocks.getLpPosition.mockResolvedValue(owned);
      dbMocks.transitionLpPosition.mockResolvedValue({ ...owned, state: 'rebalancing' });

      const response = await app.inject({
        method: 'POST',
        url: '/v1/lp/positions/pos-1/rebalance',
        headers: sessionHeaders()
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ queued: true, positionId: 'pos-1', state: 'rebalancing' });
      expect(queueManualRebalance).toHaveBeenCalledWith({
        positionId: 'pos-1',
        chain: 'solana',
        poolAddress: 'solana:pool'
      });
      await app.close();
    });

    it('refuses for other users’ positions and for terminal states', async () => {
      const app = await buildApp();
      await app.ready();
      dbMocks.getLpPosition.mockResolvedValue(null);
      expect((await app.inject({ method: 'POST', url: '/v1/lp/positions/pos-9/rebalance', headers: sessionHeaders() })).statusCode).toBe(404);

      dbMocks.getLpPosition.mockResolvedValue({ ...owned, state: 'closed' });
      expect((await app.inject({ method: 'POST', url: '/v1/lp/positions/pos-1/rebalance', headers: sessionHeaders() })).statusCode).toBe(409);
      await app.close();
    });

    it('a refused transition after queueing returns 409, leaving the job a no-op', async () => {
      const app = await buildApp();
      await app.ready();
      dbMocks.getLpPosition.mockResolvedValue(owned);
      dbMocks.transitionLpPosition.mockRejectedValue(new Error('invalid lp position transition: closed -> rebalancing'));

      const response = await app.inject({
        method: 'POST',
        url: '/v1/lp/positions/pos-1/rebalance',
        headers: sessionHeaders()
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toContain('transition');
      await app.close();
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
});
