import { beforeEach, describe, expect, it, vi } from 'vitest';

// The routes module reads pool/position data through @swat/db; mock it so the
// HTTP layer is testable without a database.
const dbMocks = vi.hoisted(() => ({
  listDiscoverPools: vi.fn(),
  listLpPositions: vi.fn(),
  queryLpWalletLeaderboard: vi.fn(),
  resolveSession: vi.fn(),
  forUser: vi.fn((userId: string) => ({ userId }))
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
});
