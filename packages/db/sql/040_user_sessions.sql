-- 040_user_sessions.sql
-- Opaque, revocable sessions. The raw token lives in an httpOnly cookie and
-- nowhere else -- only its SHA-256 digest is stored, so a database dump cannot
-- be replayed as a login.
--
-- SHA-256 rather than argon2 is correct HERE and only here: the token is 32
-- bytes of CSPRNG output, so there is no low-entropy secret for a slow hash to
-- protect. Passwords (039) use argon2id for the opposite reason.
--
-- ON DELETE CASCADE is safe on sessions specifically -- a session carries no
-- financial meaning. It is deliberately NOT used on trades/copy_executions,
-- where the row must outlive the account (D13, ADR-0001).
--
-- Idempotent: CREATE ... IF NOT EXISTS only.

CREATE TABLE IF NOT EXISTS user_sessions (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   BYTEA        NOT NULL UNIQUE,
  issued_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ  NOT NULL,
  -- Set rather than deleted, so logout-everywhere and forced revocation on
  -- password change leave a trail instead of erasing one.
  revoked_at   TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  ip           INET,
  user_agent   VARCHAR(256)
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_user
  ON user_sessions(user_id);

-- Drives both the idle/absolute expiry sweep and the revoke-all-for-user path.
CREATE INDEX IF NOT EXISTS idx_user_sessions_expiry
  ON user_sessions(expires_at);
