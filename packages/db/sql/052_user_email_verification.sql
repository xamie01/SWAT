-- 052_user_email_verification.sql
--
-- Email verification tracking on users (checklist S6-17).
-- Gating withdrawal and account recovery on verified ownership.
--
-- Idempotent: ALTER TABLE ... ADD COLUMN IF NOT EXISTS only.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS email_verification_token VARCHAR(128),
  ADD COLUMN IF NOT EXISTS email_verification_sent_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_users_email_verified
  ON users (email_verified_at)
  WHERE email_verified_at IS NOT NULL;
