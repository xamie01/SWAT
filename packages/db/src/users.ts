import { query } from './client.js';
import { withTransaction } from './transaction.js';
import {
  generateToken,
  hashPassword,
  hashToken,
  verifyPassword,
  verifyPasswordAgainstDummy
} from './credentials.js';
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

interface UserRow {
  id: string;
  email: string;
  display_name: string | null;
  role: UserRole;
  tier: UserTier;
  tier_expires_at: Date | null;
  status: UserStatus;
  created_at: Date;
}

function toUser(row: UserRow): UserRecord {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    tier: row.tier,
    tierExpiresAt: row.tier_expires_at,
    status: row.status,
    createdAt: row.created_at
  };
}

const USER_COLUMNS = 'id, email, display_name, role, tier, tier_expires_at, status, created_at';

/** Raised when the email is already registered. Mapped to HTTP 409 by the API. */
export class EmailAlreadyRegisteredError extends Error {
  constructor() {
    super('Email already registered');
    this.name = 'EmailAlreadyRegisteredError';
  }
}

export async function createUser(input: {
  email: string;
  password: string;
  displayName?: string | null;
  role?: UserRole;
  tier?: UserTier;
}): Promise<UserRecord> {
  const passwordHash = await hashPassword(input.password);
  try {
    const rows = await query<UserRow>(
      `INSERT INTO users (email, password_hash, display_name, role, tier)
       VALUES ($1, $2, $3, COALESCE($4, 'user'), COALESCE($5, 'free'))
       RETURNING ${USER_COLUMNS}`,
      [input.email, passwordHash, input.displayName ?? null, input.role ?? null, input.tier ?? null]
    );
    return toUser(rows[0]!);
  } catch (error) {
    // 23505 = unique_violation; only `users_email_key` can fire on this insert.
    if ((error as { code?: string }).code === '23505') throw new EmailAlreadyRegisteredError();
    throw error;
  }
}

export async function findUserById(id: string): Promise<UserRecord | null> {
  const rows = await query<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [id]);
  return rows[0] ? toUser(rows[0]) : null;
}

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
export async function authenticateUser(
  email: string,
  password: string
): Promise<UserRecord | null> {
  const rows = await query<UserRow & { password_hash: string }>(
    `SELECT ${USER_COLUMNS}, password_hash FROM users WHERE email = $1`,
    [email]
  );
  const row = rows[0];
  if (!row) {
    await verifyPasswordAgainstDummy(password);
    return null;
  }
  const ok = await verifyPassword(row.password_hash, password);
  return ok ? toUser(row) : null;
}

/**
 * Changes a password and revokes every live session, in one transaction.
 *
 * These must not be separable. A password change that leaves existing sessions
 * valid fails to evict whoever the user is changing it because of — which is the
 * entire reason they are changing it.
 */
export async function changePassword(scope: UserScope, newPassword: string): Promise<void> {
  const passwordHash = await hashPassword(newPassword);
  await withTransaction(async (client) => {
    await client.query('UPDATE users SET password_hash = $2, updated_at = NOW() WHERE id = $1', [
      scope.userId,
      passwordHash
    ]);
    await client.query(
      'UPDATE user_sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL',
      [scope.userId]
    );
  });
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** Absolute lifetime: a session cannot outlive this regardless of activity. */
const SESSION_ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Idle lifetime, measured from `last_seen_at`. */
const SESSION_IDLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface IssuedSession {
  /** Raw token, for the cookie only. Never persisted, never logged. */
  readonly token: string;
  readonly expiresAt: Date;
}

export async function createSession(input: {
  userId: string;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<IssuedSession> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_ABSOLUTE_TTL_MS);
  await query(
    `INSERT INTO user_sessions (user_id, token_hash, expires_at, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      input.userId,
      hashToken(token),
      expiresAt,
      input.ip ?? null,
      input.userAgent?.slice(0, 256) ?? null
    ]
  );
  return { token, expiresAt };
}

export interface ResolvedSession {
  readonly sessionId: string;
  readonly user: UserRecord;
}

/**
 * Resolves a presented token to its session and user, or null.
 *
 * Both expiry rules live in the WHERE clause, so a stale session cannot be
 * resolved by a caller that forgets to check one of them, and `last_seen_at` is
 * advanced in the same statement so the idle window slides on use.
 *
 * The CTE is load-bearing: the UPDATE must be what filters, so that touching and
 * validating a session are a single atomic step. Selecting first and updating
 * after would leave a window where a concurrently revoked session still resolves.
 */
export async function resolveSession(token: string): Promise<ResolvedSession | null> {
  const rows = await query<UserRow & { session_id: string }>(
    `WITH touched AS (
       UPDATE user_sessions
          SET last_seen_at = NOW()
        WHERE token_hash = $1
          AND revoked_at IS NULL
          AND expires_at > NOW()
          AND last_seen_at > NOW() - ($2::bigint * interval '1 millisecond')
        RETURNING id AS session_id, user_id
     )
     SELECT touched.session_id, ${USER_COLUMNS}
       FROM touched
       JOIN users ON users.id = touched.user_id`,
    [hashToken(token), SESSION_IDLE_TTL_MS]
  );
  const row = rows[0];
  return row ? { sessionId: row.session_id, user: toUser(row) } : null;
}

export async function revokeSession(token: string): Promise<void> {
  await query(
    'UPDATE user_sessions SET revoked_at = NOW() WHERE token_hash = $1 AND revoked_at IS NULL',
    [hashToken(token)]
  );
}

export async function revokeAllSessions(scope: UserScope): Promise<number> {
  const rows = await query<{ id: string }>(
    `UPDATE user_sessions SET revoked_at = NOW()
      WHERE user_id = $1 AND revoked_at IS NULL
      RETURNING id`,
    [scope.userId]
  );
  return rows.length;
}
