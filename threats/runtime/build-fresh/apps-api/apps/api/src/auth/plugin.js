import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import '@fastify/cookie';
import { findUserById, resolveSession, forUser } from '@swat/db';
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
function constantTimeMatches(provided, expected) {
    const providedHash = createHash('sha256').update(provided).digest();
    return providedHash.length === expected.length && timingSafeEqual(providedHash, expected);
}
export function issueCsrfToken() {
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
function csrfValid(request) {
    const cookieToken = request.cookies[CSRF_COOKIE];
    const headerToken = request.headers[CSRF_HEADER];
    const presented = Array.isArray(headerToken) ? headerToken[0] : headerToken;
    if (!cookieToken || !presented)
        return false;
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
const USER_REACHABLE_PREFIXES = ['/v1/auth/', '/v1/me/', '/v1/billing/'];
export function isUserReachable(path) {
    if (path === '/v1/health')
        return true;
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
export async function registerAdminOnlyGlobals(app) {
    app.addHook('onRequest', async (request, reply) => {
        if (request.method === 'OPTIONS')
            return;
        const path = request.url.split('?')[0];
        if (!path.startsWith('/v1/'))
            return;
        if (isUserReachable(path))
            return;
        const principal = request.principal;
        if (principal?.kind === 'service')
            return;
        if (principal?.kind === 'user' && principal.user.role === 'admin')
            return;
        return reply.code(403).send({ error: 'Forbidden' });
    });
}
export async function registerAuth(app, options) {
    app.decorateRequest('principal', undefined);
    app.addHook('onRequest', async (request, reply) => {
        if (request.method === 'OPTIONS')
            return;
        const path = request.url.split('?')[0];
        const isPublic = PUBLIC_PATHS.has(path);
        const sessionToken = request.cookies[SESSION_COOKIE];
        if (sessionToken) {
            const resolved = await resolveSession(sessionToken);
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
            if (isPublic)
                return;
            if (resolved && resolved.user.status !== 'active') {
                // Status is disclosed only once the credential is proven.
                return reply.code(403).send({ error: 'Account suspended' });
            }
            return reply.code(401).send({ error: 'Unauthorized' });
        }
        if (isPublic)
            return;
        // SSE cannot send headers, so it authenticates with a one-time ticket in the
        // query string. The ticket must be consumed HERE: the stream route performs
        // no validation of its own, so falling through without checking would leave
        // it open to anyone.
        if (path.startsWith('/v1/logs/stream')) {
            const ticket = request.query.ticket;
            if (typeof ticket === 'string' && ticket && (await options.consumeSseTicket(ticket))) {
                request.principal = { kind: 'service' };
                return;
            }
            // Fall through: a legacy key may still authorise the stream.
        }
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
export function requireUser(request, reply) {
    if (request.principal?.kind !== 'user') {
        reply.code(401).send({ error: 'Unauthorized' });
        return null;
    }
    return forUser(request.principal.user.id);
}
export function requireRole(request, reply, role) {
    const principal = request.principal;
    if (principal?.kind !== 'user' || principal.user.role !== role) {
        // 404-style opacity is not used here: the caller is authenticated, so
        // telling them they lack the role is not an information leak.
        reply.code(403).send({ error: 'Forbidden' });
        return null;
    }
    return principal.user;
}
const TIER_RANK = { free: 0, operator: 1, ultra: 2 };
export function requireTier(request, reply, minimum) {
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
export async function loadPrincipalUser(userId) {
    return findUserById(userId);
}
//# sourceMappingURL=plugin.js.map