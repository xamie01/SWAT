import { describe, it, expect } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { requireUser, requireRole, isUserReachable, issueCsrfToken } from './plugin.js';

function replyStub() {
  const sent: { status?: number; body?: unknown } = {};
  const reply = {
    code(status: number) {
      sent.status = status;
      return this;
    },
    send(body: unknown) {
      sent.body = body;
      return this;
    }
  } as unknown as FastifyReply;
  return { reply, sent };
}

function userRequest(role: 'admin' | 'user', id = 'u1'): FastifyRequest {
  return {
    principal: { kind: 'user', user: { id, role, status: 'active' }, sessionId: 's1' }
  } as unknown as FastifyRequest;
}

const serviceRequest = { principal: { kind: 'service' } } as unknown as FastifyRequest;
const anonymousRequest = {} as unknown as FastifyRequest;

describe('requireUser', () => {
  it('returns a scope for a user principal', () => {
    const { reply } = replyStub();
    expect(requireUser(userRequest('user'), reply)?.userId).toBe('u1');
  });

  it('rejects the internal service principal', () => {
    // The legacy shared key predates tenancy and carries no tenant, so treating
    // it as a user would be a cross-tenant hole by construction. This is checked
    // centrally rather than at every route precisely so it cannot be forgotten.
    const { reply, sent } = replyStub();
    expect(requireUser(serviceRequest, reply)).toBeNull();
    expect(sent.status).toBe(401);
  });

  it('rejects an unauthenticated request', () => {
    const { reply, sent } = replyStub();
    expect(requireUser(anonymousRequest, reply)).toBeNull();
    expect(sent.status).toBe(401);
  });
});

describe('requireRole', () => {
  it('admits an admin', () => {
    const { reply } = replyStub();
    expect(requireRole(userRequest('admin'), reply, 'admin')?.role).toBe('admin');
  });

  it('refuses an ordinary user with 403, not 401', () => {
    // 401 would tell a signed-in operator their credentials are wrong and invite
    // them to retype a password that is already correct.
    const { reply, sent } = replyStub();
    expect(requireRole(userRequest('user'), reply, 'admin')).toBeNull();
    expect(sent.status).toBe(403);
  });

  it('refuses the service principal, which has no role at all', () => {
    // Worth pinning: `registerAdminOnlyGlobals` deliberately ADMITS the service
    // principal on operator routes, so it is easy to assume requireRole does too.
    // It must not -- a route that calls requireRole is asking for a human admin.
    const { reply, sent } = replyStub();
    expect(requireRole(serviceRequest, reply, 'admin')).toBeNull();
    expect(sent.status).toBe(403);
  });

  it('refuses an anonymous request', () => {
    const { reply, sent } = replyStub();
    expect(requireRole(anonymousRequest, reply, 'admin')).toBeNull();
    expect(sent.status).toBe(403);
  });
});

describe('isUserReachable', () => {
  it('admits the auth, me, and billing prefixes and health', () => {
    expect(isUserReachable('/v1/auth/login')).toBe(true);
    expect(isUserReachable('/v1/me/subscriptions')).toBe(true);
    expect(isUserReachable('/v1/billing/plans')).toBe(true);
    expect(isUserReachable('/v1/billing/status')).toBe(true);
    expect(isUserReachable('/v1/health')).toBe(true);
  });

  it('refuses operator surfaces', () => {
    for (const path of ['/v1/wallets', '/v1/config', '/v1/scorer/run', '/v1/logs/stream']) {
      expect(isUserReachable(path)).toBe(false);
    }
  });

  it('is an allowlist, so an unknown new route is admin-gated by default', () => {
    // A blocklist would leave every new operator route wide open until somebody
    // remembered to add it, which is what makes tenancy controls decorative.
    expect(isUserReachable('/v1/some-route-added-later')).toBe(false);
  });

  it('admits every /v1/auth/ path, which is why credential-minting routes there need their own role check', () => {
    // This is the shape of a real escalation found on 2026-08-25: POST
    // /v1/auth/ticket mints an SSE ticket that the auth hook upgrades to a
    // `service` principal, and `service` is admitted on every operator route.
    // The prefix allowlist does not and cannot catch that -- the route must
    // check for itself, and apps/api/src/index.ts now calls requireRole there.
    expect(isUserReachable('/v1/auth/ticket')).toBe(true);
  });
});

describe('issueCsrfToken', () => {
  it('returns a fresh high-entropy token each call', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => issueCsrfToken()));
    expect(tokens.size).toBe(50);
    for (const token of tokens) expect(token.length).toBeGreaterThanOrEqual(40);
  });
});
