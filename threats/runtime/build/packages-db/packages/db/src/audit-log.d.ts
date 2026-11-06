/**
 * Append-only audit log (D10/D13).
 *
 * The compliance trail and the forensic record for account investigations. Two
 * properties matter more than throughput:
 *
 *   * **Writes never break the caller.** `recordAuditEvent` swallows its own
 *     failures. A login that succeeded must not be reported as failed because the
 *     log write lost a race — but see `recordAuditEventStrict` for the paths
 *     where the opposite is true.
 *   * **No FK on `actor_id`.** The row must outlive the user, and a failed login
 *     for a nonexistent email has no user to point at.
 */
export type AuditActorType = 'user' | 'admin' | 'service' | 'anonymous';
export interface AuditEventInput {
    readonly actorType: AuditActorType;
    readonly actorId?: string | null;
    readonly event: string;
    readonly targetType?: string | null;
    readonly targetId?: string | null;
    readonly ip?: string | null;
    readonly userAgent?: string | null;
    readonly metadata?: Record<string, unknown>;
}
/**
 * Best-effort write. Never throws.
 *
 * Correct for observational events (logins, logouts, key creation) where losing
 * one row is strictly better than failing the operation it describes.
 *
 * **Metadata must never carry a secret.** Passwords, raw tokens, signatures, and
 * private keys are all forbidden — this table is long-lived by design, so
 * anything written here should be assumed permanent.
 */
export declare function recordAuditEvent(input: AuditEventInput): Promise<void>;
/**
 * Strict write. Throws on failure.
 *
 * For events where an unlogged action is worse than a failed one — custody
 * operations, withdrawals, tier changes, and admin role changes (Stage 4/5).
 * Reach for this whenever "we cannot prove this happened" is the greater harm.
 */
export declare function recordAuditEventStrict(input: AuditEventInput): Promise<void>;
export declare const AUDIT_EVENTS: {
    readonly signup: "auth.signup";
    readonly login: "auth.login";
    readonly loginFailed: "auth.login_failed";
    readonly logout: "auth.logout";
    readonly sessionRevoked: "auth.session_revoked";
    readonly passwordChanged: "auth.password_changed";
    readonly walletNonceIssued: "auth.wallet_nonce_issued";
    readonly walletLinked: "auth.wallet_linked";
    readonly walletUnlinked: "auth.wallet_unlinked";
    readonly walletLoginFailed: "auth.wallet_login_failed";
    readonly apiKeyCreated: "apikey.created";
    readonly apiKeyRevoked: "apikey.revoked";
    readonly roleChanged: "admin.role_changed";
    readonly tierChanged: "admin.tier_changed";
};
//# sourceMappingURL=audit-log.d.ts.map