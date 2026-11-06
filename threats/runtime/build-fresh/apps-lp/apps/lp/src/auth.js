import { createHash, timingSafeEqual } from 'node:crypto';
import '@fastify/cookie';
import { resolveSession, forUser } from '@swat/db';
export const SESSION_COOKIE = 'swat_session';
export const CSRF_COOKIE = 'swat_csrf';
export const CSRF_HEADER = 'x-csrf-token';
const PUBLIC_PATHS = new Set(['/v1/health']);
function constantTimeMatches(provided, expected) {
    const providedHash = createHash('sha256').update(provided).digest();
    return providedHash.length === expected.length && timingSafeEqual(providedHash, expected);
}
function csrfValid(request) {
    const cookies = request.cookies ?? {};
    const cookieToken = cookies[CSRF_COOKIE];
    const headerToken = request.headers[CSRF_HEADER];
    const presented = Array.isArray(headerToken) ? headerToken[0] : headerToken;
    if (!cookieToken || !presented)
        return false;
    const a = Buffer.from(cookieToken);
    const b = Buffer.from(presented);
    return a.length === b.length && timingSafeEqual(a, b);
}
/** SHA-256 digest helper for the legacy shared key. */
export function legacyKeyHash(apiKey) {
    return createHash('sha256').update(apiKey).digest();
}
export async function registerLpAuth(app, options) {
    app.decorateRequest('principal', undefined);
    app.addHook('onRequest', async (request, reply) => {
        if (request.method === 'OPTIONS')
            return;
        const path = request.url.split('?')[0];
        const isPublic = PUBLIC_PATHS.has(path);
        const cookies = request.cookies ?? {};
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
            if (isPublic)
                return;
            return reply.code(401).send({ error: 'Unauthorized' });
        }
        if (isPublic)
            return;
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
export function requireUser(request, reply) {
    if (request.principal?.kind !== 'user') {
        reply.code(401).send({ error: 'Unauthorized' });
        return null;
    }
    return forUser(request.principal.user.id);
}
//# sourceMappingURL=auth.js.map