import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import '@fastify/cookie';
import { resolveSession, forUser, type UserScope, type UserRecord } from '@swat/db';

/**
 * Layered authentication for the LP service, mirroring apps/api's model (D12)
 * with the same cookie names so one browser session works across both:
 *
 *   1. **Session cookie** — a browser user. Carries a tenant.
 *   2. **`X-Api-Key` matching the legacy `API_KEY`** — an internal service.
 *      Carries **no** tenant, and `requireUser` rejects it on scoped routes.
 *
 * CSRF double-submit applies to state-changing cookie requests, exactly as in
 * the API: `SameSite` is a browser defence, not one we can verify.
 */

export type LpAuthPrincipal =
  | { readonly kind: 'user'; readonly user: UserRecord; readonly sessionId: string | null }
  | { readonly kind: 'service' };

declare module 'fastify' {
  interface FastifyRequest {
    principal?: LpAuthPrincipal;
  }
}

export const SESSION_COOKIE = 'swat_session';
export const CSRF_COOKIE = 'swat_csrf';
export const CSRF_HEADER = 'x-csrf-token';

const PUBLIC_PATHS = new Set(['/v1/health']);

function constantTimeMatches(provided: string, expected: Buffer): boolean {
  const providedHash = createHash('sha256').update(provided).digest();
  return providedHash.length === expected.length && timingSafeEqual(providedHash, expected);
}

function csrfValid(request: FastifyRequest): boolean {
  const cookies = (request as unknown as { cookies?: Record<string, string | undefined> }).cookies ?? {};
  const cookieToken = cookies[CSRF_COOKIE];
  const headerToken = request.headers[CSRF_HEADER];
  const presented = Array.isArray(headerToken) ? headerToken[0] : headerToken;
  if (!cookieToken || !presented) return false;
  const a = Buffer.from(cookieToken);
  const b = Buffer.from(presented);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** SHA-256 digest helper for the legacy shared key. */
export function legacyKeyHash(apiKey: string): Buffer {
  return createHash('sha256').update(apiKey).digest();
}

export interface LpAuthOptions {
  /** SHA-256 digest of the legacy shared key (API_KEY). */
  readonly legacyKeyHash: Buffer;
}

export async function registerLpAuth(app: FastifyInstance, options: LpAuthOptions): Promise<void> {
  app.decorateRequest('principal', undefined);

  app.addHook('onRequest', async (request, reply) => {
    if (request.method === 'OPTIONS') return;
    const path = request.url.split('?')[0]!;
    const isPublic = PUBLIC_PATHS.has(path);

    const cookies = (request as unknown as { cookies?: Record<string, string | undefined> }).cookies ?? {};
    const sessionToken = cookies[SESSION_COOKIE];
    if (sessionToken) {
      const resolved = await resolveSession(sessionToken);
      if (resolved && resolved.user.status === 'active') {
        if (request.method !== 'GET' && request.method !== 'HEAD' && !csrfValid(request)) {
          return reply.code(403).send({ error: 'Invalid CSRF token', code: 'csrf_invalid' });
        }
        request.principal = { kind: 'user', user: resolved.user, sessionId: resolved.sessionId };
        return;
      }
      if (isPublic) return;
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    if (isPublic) return;

    const legacyKey = request.headers['x-api-key'];
    const presented = Array.isArray(legacyKey) ? legacyKey[0] ?? '' : legacyKey ?? '';
    if (presented && constantTimeMatches(presented, options.legacyKeyHash)) {
      request.principal = { kind: 'service' };
      return;
    }

    return reply.code(401).send({ error: 'Unauthorized' });
  });
}

/** Asserts a tenant-bearing principal. The service key has no tenant by design. */
export function requireUser(request: FastifyRequest, reply: FastifyReply): UserScope | null {
  if (request.principal?.kind !== 'user') {
    reply.code(401).send({ error: 'Unauthorized' });
    return null;
  }
  return forUser(request.principal.user.id);
}
