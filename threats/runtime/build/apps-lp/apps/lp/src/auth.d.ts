import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import '@fastify/cookie';
import { type UserScope, type UserRecord } from '@swat/db';
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
export type LpAuthPrincipal = {
    readonly kind: 'user';
    readonly user: UserRecord;
    readonly sessionId: string | null;
} | {
    readonly kind: 'service';
};
declare module 'fastify' {
    interface FastifyRequest {
        principal?: LpAuthPrincipal;
    }
}
export declare const SESSION_COOKIE = "swat_session";
export declare const CSRF_COOKIE = "swat_csrf";
export declare const CSRF_HEADER = "x-csrf-token";
/** SHA-256 digest helper for the legacy shared key. */
export declare function legacyKeyHash(apiKey: string): Buffer;
export interface LpAuthOptions {
    /** SHA-256 digest of the legacy shared key (API_KEY). */
    readonly legacyKeyHash: Buffer;
}
export declare function registerLpAuth(app: FastifyInstance, options: LpAuthOptions): Promise<void>;
/** Asserts a tenant-bearing principal. The service key has no tenant by design. */
export declare function requireUser(request: FastifyRequest, reply: FastifyReply): UserScope | null;
//# sourceMappingURL=auth.d.ts.map