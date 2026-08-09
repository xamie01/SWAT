-- 042_user_api_keys.sql
-- Per-user programmatic credentials, replacing the single shared API_KEY for
-- user-facing routes. Key format: swat_<prefix>_<secret>.
--
-- key_prefix is stored, indexed and UNIQUE so that verifying a presented key is
-- one indexed equality followed by one constant-time hash compare. The naive
-- alternative -- scan every key row and compare hashes -- degrades linearly
-- with key count and turns verification into a timing oracle.
--
-- Only the SHA-256 digest of the full key is stored; the secret is displayed
-- once at creation and is unrecoverable afterwards. Same reasoning as
-- user_sessions.token_hash: high-entropy credential, so a fast hash is right.
--
-- Idempotent: CREATE ... IF NOT EXISTS only.

CREATE TABLE IF NOT EXISTS user_api_keys (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         VARCHAR(64)  NOT NULL,
  key_prefix   VARCHAR(16)  NOT NULL UNIQUE,
  key_hash     BYTEA        NOT NULL,
  last_used_at TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_api_keys_user
  ON user_api_keys(user_id);
