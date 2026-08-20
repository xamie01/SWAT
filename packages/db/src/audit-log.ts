import { query } from './client.js';

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

async function insert(input: AuditEventInput): Promise<void> {
  await query(
    `INSERT INTO audit_log
       (actor_type, actor_id, event, target_type, target_id, ip, user_agent, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      input.actorType,
      input.actorId ?? null,
      input.event,
      input.targetType ?? null,
      input.targetId ?? null,
      input.ip ?? null,
      input.userAgent?.slice(0, 256) ?? null,
      JSON.stringify(input.metadata ?? {})
    ]
  );
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
export async function recordAuditEvent(input: AuditEventInput): Promise<void> {
  try {
    await insert(input);
  } catch {
    // Deliberately silent: an audit failure must not convert a successful
    // login into a 500. Loss is visible via the row gap, and the DB error is
    // already captured by the pool's error handler.
  }
}

/**
 * Strict write. Throws on failure.
 *
 * For events where an unlogged action is worse than a failed one — custody
 * operations, withdrawals, tier changes, and admin role changes (Stage 4/5).
 * Reach for this whenever "we cannot prove this happened" is the greater harm.
 */
export async function recordAuditEventStrict(input: AuditEventInput): Promise<void> {
  await insert(input);
}

export const AUDIT_EVENTS = {
  signup: 'auth.signup',
  login: 'auth.login',
  loginFailed: 'auth.login_failed',
  logout: 'auth.logout',
  sessionRevoked: 'auth.session_revoked',
  passwordChanged: 'auth.password_changed',
  walletNonceIssued: 'auth.wallet_nonce_issued',
  walletLinked: 'auth.wallet_linked',
  walletUnlinked: 'auth.wallet_unlinked',
  walletLoginFailed: 'auth.wallet_login_failed',
  apiKeyCreated: 'apikey.created',
  apiKeyRevoked: 'apikey.revoked',
  roleChanged: 'admin.role_changed',
  tierChanged: 'admin.tier_changed'
} as const;
