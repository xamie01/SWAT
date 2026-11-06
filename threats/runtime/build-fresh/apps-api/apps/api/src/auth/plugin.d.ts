import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import '@fastify/cookie';
import { type UserScope, type UserRecord } from '@swat/db';
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
export type AuthPrincipal = {
    readonly kind: 'user';
    readonly user: UserRecord;
    readonly sessionId: string | null;
} | {
    readonly kind: 'service';
};
declare module 'fastify' {
    interface FastifyRequest {
        principal?: AuthPrincipal;
    }
}
export declare const SESSION_COOKIE = "swat_session";
export declare const CSRF_COOKIE = "swat_csrf";
export declare const CSRF_HEADER = "x-csrf-token";
export interface AuthPluginOptions {
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
export declare function issueCsrfToken(): string;
export declare function isUserReachable(path: string): boolean;
/**
 * Restricts operator surfaces to admins and internal services (checklist S2-11).
 *
 * Register **after** `registerAuth` so `request.principal` is populated. The
 * service principal is allowed because these are the routes service→API calls
 * legitimately use; it carries no tenant, which is precisely why `requireUser`
 * rejects it on `/v1/me/*` while this hook admits it here.
 */
export declare function registerAdminOnlyGlobals(app: FastifyInstance): Promise<void>;
export declare function registerAuth(app: FastifyInstance, options: AuthPluginOptions): Promise<void>;
/**
 * Asserts a tenant-bearing principal and returns its scope.
 *
 * A service principal is rejected here rather than at each call site: the legacy
 * key has no tenant, so any route that scopes data must refuse it.
 */
export declare function requireUser(request: FastifyRequest, reply: FastifyReply): UserScope | null;
export declare function requireRole(request: FastifyRequest, reply: FastifyReply, role: 'admin'): UserRecord | null;
export declare function requireTier(request: FastifyRequest, reply: FastifyReply, minimum: 'operator' | 'ultra'): UserRecord | null;
export declare function loadPrincipalUser(userId: string): Promise<UserRecord | null>;
//# sourceMappingURL=plugin.d.ts.map