import { afterEach, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
const fixture = vi.hoisted(() => ({ createSession: vi.fn(), authenticateUser: vi.fn(), resolveSession: vi.fn() }));
vi.mock('@swat/db', () => ({
  AUDIT_EVENTS: {}, authenticateUser: fixture.authenticateUser, createSession: fixture.createSession, resolveSession: fixture.resolveSession,
  createUser: vi.fn(), EmailAlreadyRegisteredError: class extends Error {}, findUserById: vi.fn(),
  findUserIdByAuthWallet: vi.fn(), forUser: vi.fn(), linkAuthWallet: vi.fn(), listAuthWallets: vi.fn(),
  recordAuditEvent: vi.fn(), revokeSession: vi.fn(), WalletAlreadyLinkedError: class extends Error {}
}));
import { registerAuthRoutes } from '../auth/routes.js';
import { registerAuth, registerAdminOnlyGlobals } from '../auth/plugin.js';
import { createHash } from 'node:crypto';
it('refuses query tickets, enforces stream role and marks successes and failures no-store', async () => {
  const app = Fastify({ logger: false });
  const consume = vi.fn(async () => true);
  try {
    await app.register(cookie);
    await registerAuth(app, { isProduction: true, legacyKeyHash: createHash('sha256').update('fixture-only').digest(), consumeSseTicket: consume });
    await registerAdminOnlyGlobals(app);
    app.get('/v1/logs/stream', async () => ({ connected: true }));
    const anonymous = await app.inject('/v1/logs/stream?ticket=fixture');
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.headers['cache-control']).toBe('no-store');
    expect(consume).not.toHaveBeenCalled();
    fixture.resolveSession.mockResolvedValue({ sessionId: 'fixture', user: { status: 'active', role: 'user' } });
    expect((await app.inject({ url: '/v1/logs/stream', headers: { cookie: 'swat_session=fixture' } })).statusCode).toBe(403);
    fixture.resolveSession.mockResolvedValue({ sessionId: 'fixture', user: { status: 'active', role: 'admin' } });
    const admin = await app.inject({ url: '/v1/logs/stream', headers: { cookie: 'swat_session=fixture' } });
    expect(admin.statusCode).toBe(200);
    expect(admin.headers['cache-control']).toBe('no-store');
  } finally { await app.close(); }
});
const saved = process.env.COOKIE_SECURE;
afterEach(() => { if (saved === undefined) delete process.env.COOKIE_SECURE; else process.env.COOKIE_SECURE = saved; });
it('always issues Secure production session and CSRF cookies regardless of environment or forwarded headers', async () => {
  process.env.COOKIE_SECURE = 'false';
  fixture.authenticateUser.mockResolvedValue({ id: 'fixture-user', role: 'user', status: 'active', email: 'fixture@example.invalid' });
  fixture.createSession.mockResolvedValue({ token: 'fixture-session', expiresAt: new Date('2030-01-01') });
  const app = Fastify({ logger: false });
  try {
    await app.register(cookie);
    await registerAuthRoutes(app, { redis: {} as any, isProduction: true, domain: 'example.invalid', uri: 'https://example.invalid' });
    const result = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'fixture@example.invalid', password: 'fixture-password' }, headers: { 'x-forwarded-proto': 'http' } });
    expect(result.statusCode).toBe(200);
    const cookies = result.headers['set-cookie'];
    expect(Array.isArray(cookies)).toBe(true);
    expect(cookies).toHaveLength(2);
    for (const value of cookies as string[]) expect(value).toMatch(/; Secure(?:;|$)/);
  } finally { await app.close(); }
});
