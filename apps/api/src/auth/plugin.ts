import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import '@fastify/cookie';
import type { UserScope } from '@swat/db/dist/tenancy.js';
import type { UserRecord, ResolvedSession } from '@swat/db/dist/users.js';

/**
 * Layered authentication (D12).
 *
 * Three credential types, resolved in this order:
 *
 *   1. **Session cookie** — a browser user. Carries a tenant.
 *   2. **`Authorization: Bearer swat_…`** — a per-user API key. Carries a tenant.
 *   3. **`X-Api-Key` matching the legacy `API_KEY`** — an internal service.
 *      Carries **no** tenant, and must never satisfy a `/v1/me/*` route.
 *
 * That last rule is the important one. The legacy key predates tenancy; treating
 * it as a user would be a cross-tenant hole by construction, so `requireUser`
 * rejects it explicitly rather than relying on every route to remember.
 */

export type AuthPrincipal =
  | { readonly kind: 'user'; readonly user: UserRecord; readonly sessionId: string | null }
  | { readonly kind: 'service' };

declare module 'fastify' {
  interface FastifyRequest {
    principal?: AuthPrincipal;
  }
}

export const SESSION_COOKIE = 'swat_session';
export const CSRF_COOKIE = 'swat_csrf';
export const CSRF_HEADER = 'x-csrf-token';

/** Paths that never require authentication. */
const PUBLIC_PATHS = new Set([
  '/v1/health',
  '/v1/auth/signup',
  '/v1/auth/login',
  '/v1/auth/wallet/nonce',
  '/v1/auth/wallet/verify'
]);

export interface AuthPluginOptions {
  readonly resolveSession: (token: string) => Promise<ResolvedSession | null>;
  /** SHA-256 digest of the legacy shared key. */
  readonly legacyKeyHash: Buffer;
  readonly isProduction: boolean;
  /**
   * Atomically consumes a one-time SSE ticket, returning true if it was valid.
   *
   * Injected rather than inlined because the hook is the *only* place the ticket
   * is checked — `GET /v1/logs/stream` itself does no validation, so if this
   * returns true for an invalid ticket the stream is simply unauthenticated.
   */
  readonly consumeSseTicket: (ticket: string) => Promise<boolean>;
}

function constantTimeMatches(provided: string, expected: Buffer): boolean {
  const providedHash = createHash('sha256').update(provided).digest();
  return providedHash.length === expected.length && timingSafeEqual(providedHash, expected);
}

export function issueCsrfToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Double-submit CSRF check.
 *
 * Cookie authentication means the browser attaches credentials to cross-site
 * requests automatically, so without this any site could POST as a logged-in
 * user. `SameSite=Lax` blocks the common case but is deliberately *not* relied
 * on alone: it is a defence the browser applies, not one we can verify, and the
 * SIWE flow requires `Lax` rather than `Strict`.
 *
 * Only applies to cookie-authenticated requests. An API key is not sent
 * automatically by a browser, so it is not CSRF-reachable.
 */
function csrfValid(request: FastifyRequest): boolean {
  const cookieToken = (request.cookies as Record<string, string | undefined>)[CSRF_COOKIE];
  const headerToken = request.headers[CSRF_HEADER];
  const presented = Array.isArray(headerToken) ? headerToken[0] : headerToken;
  if (!cookieToken || !presented) return false;
  const a = Buffer.from(cookieToken);
  const b = Buffer.from(presented);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Paths any authenticated user may reach. Everything else under `/v1/` is an
 * operator surface and requires `admin` or the internal service principal.
 *
 * An allowlist, not a blocklist, on purpose: a new global route added later is
 * admin-gated by default. A blocklist would leave every new operator route wide
 * open until somebody remembered to add it, which is exactly the failure mode
 * that makes tenancy controls decorative.
 */
const USER_REACHABLE_PREFIXES = ['/v1/auth/', '/v1/me/', '/v1/billing/'] as const;

export function isUserReachable(path: string): boolean {
  if (path === '/v1/health') return true;
  return USER_REACHABLE_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * Restricts operator surfaces to admins and internal services (checklist S2-11).
 *
 * Register **after** `registerAuth` so `request.principal` is populated. The
 * service principal is allowed because these are the routes service→API calls
 * legitimately use; it carries no tenant, which is precisely why `requireUser`
 * rejects it on `/v1/me/*` while this hook admits it here.
 */
export async function registerAdminOnlyGlobals(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (request.method === 'OPTIONS') return;
    const path = request.url.split('?')[0]!;
    if (!path.startsWith('/v1/')) return;
    if (isUserReachable(path)) return;

    const principal = request.principal;
    if (principal?.kind === 'service') return;
    if (principal?.kind === 'user' && principal.user.role === 'admin') return;
    return reply.code(403).send({ error: 'Forbidden' });
  });
}

export async function registerAuth(app: FastifyInstance, options: AuthPluginOptions): Promise<void> {
  if (typeof options.resolveSession !== 'function') throw new Error('Protected owned auth resolver required');
  app.decorateRequest('principal', undefined);

  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (request.method === 'OPTIONS') return;
    const path = request.url.split('?')[0]!;
    const isPublic = PUBLIC_PATHS.has(path);

    const sessionToken = (request.cookies as Record<string, string | undefined>)[SESSION_COOKIE];
    if (sessionToken) {
      const resolved = await options.resolveSession(sessionToken);
      if (resolved && resolved.user.status === 'active') {
        // State-changing cookie requests must carry the double-submit token.
        // Applies on public paths too: `POST /v1/auth/wallet/verify` links a
        // wallet to the *session's* account, which is state-changing.
        if (request.method !== 'GET' && request.method !== 'HEAD' && !csrfValid(request)) {
          // `code` is machine-readable on purpose. A CSRF failure and a role
          // failure are both 403, and a client that tells them apart by matching
          // the prose breaks the next time the prose is reworded. The distinction
          // matters to the reader: a stale `swat_csrf` cookie is fixed by
          // reloading, whereas a role failure never is -- and conflating them
          // sends an operator hunting a permissions problem that does not exist.
          return reply.code(403).send({ error: 'Invalid CSRF token', code: 'csrf_invalid' });
        }
        request.principal = { kind: 'user', user: resolved.user, sessionId: resolved.sessionId };
        return;
      }
      // A public route must still be reachable with a stale cookie — otherwise a
      // user whose session expired could not log in again without manually
      // clearing cookies.
      if (isPublic) return;
      if (resolved && resolved.user.status !== 'active') {
        // Status is disclosed only once the credential is proven.
        return reply.code(403).send({ error: 'Account suspended' });
      }
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    if (isPublic) return;

    // Query-string bearer credentials are not accepted. Browser streams use
    // the same session cookie and role checks as other operator requests.

    const authorization = request.headers.authorization;
    if (authorization?.startsWith('Bearer ')) {
      // Per-user API keys land here once S1-20 ships. Until then a bearer token
      // is not a valid credential and must not fall through to the legacy key.
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const legacyKey = request.headers['x-api-key'];
    const presented = Array.isArray(legacyKey) ? legacyKey[0] ?? '' : legacyKey ?? '';
    if (presented && constantTimeMatches(presented, options.legacyKeyHash)) {
      request.principal = { kind: 'service' };
      return;
    }

    return reply.code(401).send({ error: 'Unauthorized' });
  });
}

/**
 * Asserts a tenant-bearing principal and returns its scope.
 *
 * A service principal is rejected here rather than at each call site: the legacy
 * key has no tenant, so any route that scopes data must refuse it.
 */
export function requireUser(request: FastifyRequest, reply: FastifyReply): UserScope | null {
  if (request.principal?.kind !== 'user') {
    reply.code(401).send({ error: 'Unauthorized' });
    return null;
  }
  const id = request.principal.user.id;
  if (!id?.trim() || id === '*') { reply.code(401).send({ error: 'Unauthorized' }); return null; }
  return { userId: id } as UserScope;
}

export function requireRole(
  request: FastifyRequest,
  reply: FastifyReply,
  role: 'admin'
): UserRecord | null {
  const principal = request.principal;
  if (principal?.kind !== 'user' || principal.user.role !== role) {
    // 404-style opacity is not used here: the caller is authenticated, so
    // telling them they lack the role is not an information leak.
    reply.code(403).send({ error: 'Forbidden' });
    return null;
  }
  return principal.user;
}

const TIER_RANK: Record<string, number> = { free: 0, operator: 1, ultra: 2 };

export function requireTier(
  request: FastifyRequest,
  reply: FastifyReply,
  minimum: 'operator' | 'ultra'
): UserRecord | null {
  const principal = request.principal;
  if (principal?.kind !== 'user') {
    reply.code(401).send({ error: 'Unauthorized' });
    return null;
  }
  const { user } = principal;
  // An expired paid tier is treated as free. `tier_expires_at IS NULL` means
  // lifetime, so a null expiry must never be read as "expired".
  const expired = user.tierExpiresAt !== null && user.tierExpiresAt.getTime() < Date.now();
  const effectiveTier = expired ? 'free' : user.tier;
  if ((TIER_RANK[effectiveTier] ?? 0) < (TIER_RANK[minimum] ?? 0)) {
    reply.code(403).send({ error: 'Upgrade required', requiredTier: minimum });
    return null;
  }
  return user;
}

export async function loadPrincipalUser(token: string, resolver: AuthPluginOptions['resolveSession']): Promise<UserRecord | null> {
  if (typeof resolver !== 'function') throw new Error('Protected resolver required');
  return (await resolver(token))?.user ?? null;
}
