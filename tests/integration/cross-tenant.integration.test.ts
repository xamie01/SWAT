import { randomUUID, createHash } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { Redis } from 'ioredis';
import { pool } from '../../packages/db/src/client.js';
import { forUser, listAuthWallets, linkAuthWallet } from '../../packages/db/src/index.js';
import { registerAuth, requireUser, requireRole } from '../../apps/api/src/auth/plugin.js';
import { registerAuthRoutes } from '../../apps/api/src/auth/routes.js';

/**
 * Cross-tenant isolation suite (D12, checklist S1-16).
 *
 * This exists to run **before** Stage 2 adds `/v1/me/*` routes, not after. Its
 * job is to make tenant leakage a test failure rather than a code review
 * question, and to keep doing so as routes are added.
 *
 * It builds a minimal Fastify app around the *real* auth plugin and routes
 * rather than importing `apps/api/src/index.ts`, which opens Redis connections
 * and BullMQ queues at module scope — importing it would start a second API
 * against the test database. Same constraint the pipeline suite documents for
 * `signal-engine`.
 */

const DOMAIN = 'app.swat.test';
const URI = 'https://app.swat.test';
const LEGACY_KEY = 'cross-tenant-suite-legacy-key';

interface Actor {
  readonly email: string;
  readonly userId: string;
  readonly cookies: string;
  readonly csrf: string;
}

let app: FastifyInstance;
let redis: Redis;
const createdUserIds: string[] = [];

async function buildApp(): Promise<FastifyInstance> {
  const instance = Fastify({ logger: false });
  await instance.register(cookie);

  await registerAuth(instance, {
    legacyKeyHash: createHash('sha256').update(LEGACY_KEY).digest(),
    isProduction: false,
    consumeSseTicket: async () => false
  });

  await registerAuthRoutes(instance, {
    redis,
    isProduction: false,
    domain: DOMAIN,
    uri: URI
  });

  /**
   * Stand-in for a Stage 2 `/v1/me/*` route: reads user-owned rows through the
   * scope that `requireUser` derives from the session. If scoping regresses,
   * this route starts returning another tenant's wallets.
   */
  instance.get('/v1/me/wallets', async (request, reply) => {
    const scope = requireUser(request, reply);
    if (!scope) return;
    const wallets = await listAuthWallets(scope);
    return reply.send({ wallets: wallets.map((w) => w.address) });
  });

  /** Stand-in for an admin-only route. */
  instance.get('/v1/admin/ping', async (request, reply) => {
    const user = requireRole(request, reply, 'admin');
    if (!user) return;
    return reply.send({ ok: true });
  });

  await instance.ready();
  return instance;
}

async function signup(email: string): Promise<Actor> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    payload: { email, password: 'a-very-long-password' }
  });
  if (response.statusCode !== 201) {
    throw new Error(`signup failed for ${email}: ${response.statusCode} ${response.body}`);
  }
  const setCookies = response.headers['set-cookie'];
  const raw = Array.isArray(setCookies) ? setCookies : [String(setCookies)];
  const cookies = raw.map((c) => c.split(';')[0]).join('; ');
  const csrf = /swat_csrf=([^;]+)/.exec(cookies)?.[1] ?? '';
  const userId = (JSON.parse(response.body) as { user: { id: string } }).user.id;
  createdUserIds.push(userId);
  return { email, userId, cookies, csrf };
}

beforeAll(async () => {
  redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: null
  });
  app = await buildApp();
});

afterAll(async () => {
  await app?.close();
  await redis?.quit();
  if (createdUserIds.length > 0) {
    // user_auth_wallets and user_sessions cascade from users.
    await pool.query('DELETE FROM audit_log WHERE actor_id = ANY($1)', [createdUserIds]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [createdUserIds]);
  }
});

describe('cross-tenant isolation', () => {
  it("does not leak one tenant's wallets to another", async () => {
    const alice = await signup(`alice-${randomUUID()}@example.com`);
    const bob = await signup(`bob-${randomUUID()}@example.com`);

    // Give each a distinct linked wallet, written through the scoped helper.
    await linkAuthWallet(forUser(alice.userId), {
      chainKind: 'evm',
      address: `0xa${alice.userId.replace(/-/g, '').slice(0, 39)}`
    });
    await linkAuthWallet(forUser(bob.userId), {
      chainKind: 'evm',
      address: `0xb${bob.userId.replace(/-/g, '').slice(0, 39)}`
    });

    const aliceView = await app.inject({
      method: 'GET',
      url: '/v1/me/wallets',
      headers: { cookie: alice.cookies }
    });
    const bobView = await app.inject({
      method: 'GET',
      url: '/v1/me/wallets',
      headers: { cookie: bob.cookies }
    });

    expect(aliceView.statusCode).toBe(200);
    expect(bobView.statusCode).toBe(200);
    const aliceWallets = (JSON.parse(aliceView.body) as { wallets: string[] }).wallets;
    const bobWallets = (JSON.parse(bobView.body) as { wallets: string[] }).wallets;

    expect(aliceWallets).toHaveLength(1);
    expect(bobWallets).toHaveLength(1);
    // The actual isolation assertion: disjoint, and neither contains the other's.
    expect(aliceWallets).not.toEqual(bobWallets);
    expect(aliceWallets[0]).not.toBe(bobWallets[0]);
  });

  it('rejects a request with no credential', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/me/wallets' });
    expect(response.statusCode).toBe(401);
  });

  it('rejects the tenant-less service key on a per-user route', async () => {
    // The legacy shared key predates tenancy. If it satisfied a `/v1/me/*` route
    // there would be no tenant to scope by, so `requireUser` must refuse it —
    // this is a cross-tenant hole by construction, not a policy choice.
    const response = await app.inject({
      method: 'GET',
      url: '/v1/me/wallets',
      headers: { 'x-api-key': LEGACY_KEY }
    });
    expect(response.statusCode).toBe(401);
  });

  it('does not let a normal user reach an admin route', async () => {
    const user = await signup(`user-${randomUUID()}@example.com`);
    const response = await app.inject({
      method: 'GET',
      url: '/v1/admin/ping',
      headers: { cookie: user.cookies }
    });
    expect(response.statusCode).toBe(403);
  });

  it("rejects one tenant's CSRF token paired with another's session", async () => {
    const alice = await signup(`csrfa-${randomUUID()}@example.com`);
    const bob = await signup(`csrfb-${randomUUID()}@example.com`);

    // Alice's session cookie, Bob's CSRF token. Double-submit must compare the
    // header against *this request's* cookie, so a token lifted from another
    // session is useless.
    const aliceSessionOnly = alice.cookies
      .split('; ')
      .filter((c) => c.startsWith('swat_session='))
      .join('; ');

    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { cookie: aliceSessionOnly, 'x-csrf-token': bob.csrf }
    });
    expect(response.statusCode).toBe(403);
  });

  it('revokes only the logging-out tenant’s session', async () => {
    const alice = await signup(`revoke-a-${randomUUID()}@example.com`);
    const bob = await signup(`revoke-b-${randomUUID()}@example.com`);

    const logout = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { cookie: alice.cookies, 'x-csrf-token': alice.csrf }
    });
    expect(logout.statusCode).toBe(200);

    const aliceAfter = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { cookie: alice.cookies }
    });
    const bobAfter = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { cookie: bob.cookies }
    });

    expect(aliceAfter.statusCode).toBe(401);
    // Bob must be untouched: a revoke-all bug would show up here and nowhere else.
    expect(bobAfter.statusCode).toBe(200);
  });

  it('will not link a wallet already owned by another tenant', async () => {
    const alice = await signup(`link-a-${randomUUID()}@example.com`);
    const bob = await signup(`link-b-${randomUUID()}@example.com`);
    const shared = `0xc${alice.userId.replace(/-/g, '').slice(0, 39)}`;

    await linkAuthWallet(forUser(alice.userId), { chainKind: 'evm', address: shared });

    // Silently re-pointing a verified wallet would hand over its role as a
    // Stage 4 withdrawal destination.
    await expect(
      linkAuthWallet(forUser(bob.userId), { chainKind: 'evm', address: shared })
    ).rejects.toThrow(/already linked/i);
  });

  it('treats re-linking a tenant’s own wallet as idempotent', async () => {
    const alice = await signup(`idem-${randomUUID()}@example.com`);
    const address = `0xd${alice.userId.replace(/-/g, '').slice(0, 39)}`;
    const scope = forUser(alice.userId);

    const first = await linkAuthWallet(scope, { chainKind: 'evm', address });
    const second = await linkAuthWallet(scope, { chainKind: 'evm', address });

    expect(second.id).toBe(first.id);
    expect(await listAuthWallets(scope)).toHaveLength(1);
  });
});
