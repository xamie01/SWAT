import type { UserScope } from './tenancy.js';
export type UserRole = 'user' | 'admin';
export type UserTier = 'free' | 'operator' | 'ultra';
export type UserStatus = 'active' | 'suspended' | 'deleted';
export interface UserRecord {
    readonly id: string;
    readonly email: string;
    readonly displayName: string | null;
    readonly role: UserRole;
    readonly tier: UserTier;
    readonly tierExpiresAt: Date | null;
    readonly status: UserStatus;
    readonly createdAt: Date;
}
/** Raised when the email is already registered. Mapped to HTTP 409 by the API. */
export declare class EmailAlreadyRegisteredError extends Error {
    constructor();
}
export declare function createUser(input: {
    email: string;
    password: string;
    displayName?: string | null;
    role?: UserRole;
    tier?: UserTier;
}): Promise<UserRecord>;
export declare function findUserById(id: string): Promise<UserRecord | null>;
/**
 * Verifies a password against an email.
 *
 * Returns `null` for both "no such user" and "wrong password", and burns an
 * equivalent argon2 verify in the unknown-email case. The caller therefore cannot
 * distinguish the two by return value *or* by timing — which is what makes the
 * identical 401 body in the API meaningful rather than cosmetic.
 *
 * Account status is deliberately *not* consulted here. It is returned for the
 * caller to check only after the password has been proven, so status is never
 * disclosed to an unauthenticated guesser.
 */
export declare function authenticateUser(email: string, password: string): Promise<UserRecord | null>;
/**
 * Changes a password and revokes every live session, in one transaction.
 *
 * These must not be separable. A password change that leaves existing sessions
 * valid fails to evict whoever the user is changing it because of — which is the
 * entire reason they are changing it.
 */
export declare function changePassword(scope: UserScope, newPassword: string): Promise<void>;
export interface IssuedSession {
    /** Raw token, for the cookie only. Never persisted, never logged. */
    readonly token: string;
    readonly expiresAt: Date;
}
export declare function createSession(input: {
    userId: string;
    ip?: string | null;
    userAgent?: string | null;
}): Promise<IssuedSession>;
export interface ResolvedSession {
    readonly sessionId: string;
    readonly user: UserRecord;
}
export declare const SESSION_CACHE_TTL_MS = 60000;
export declare const SESSION_CACHE_MAX_ENTRIES = 10000;
export declare function clearSessionCache(): void;
export declare function sessionCacheSize(): number;
export declare function invalidateUserSessionCache(userId: string): void;
/**
 * Resolves a presented token to its session and user, or null.
 *
 * Both expiry rules live in the WHERE clause, so a stale session cannot be
 * resolved by a caller that forgets to check one of them, and `last_seen_at` is
 * advanced in the same statement so the idle window slides on use.
 *
 * Reads are cached in an in-memory bounded LRU map for 60 seconds to prevent
 * write-amplification (an UPDATE on every GET) from saturating Postgres under load.
 * Revocations invalidate the cache immediately.
 */
export declare function resolveSession(token: string): Promise<ResolvedSession | null>;
export declare function revokeSession(token: string): Promise<void>;
export declare function revokeAllSessions(scope: UserScope): Promise<number>;
//# sourceMappingURL=users.d.ts.map