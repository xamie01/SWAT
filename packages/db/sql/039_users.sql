-- 039_users.sql
-- Tenant root. One row per account; every per-user table references this id.
--
-- CITEXT rather than a lowercased VARCHAR: case-insensitive uniqueness is a
-- property of the column, so `Alice@x.com` and `alice@x.com` cannot both
-- register regardless of which call site writes them. A functional index would
-- leave the raw column able to hold either form.
--
-- password_hash is TEXT, not VARCHAR(n): an argon2id encoded hash carries its
-- own parameters, so its length changes whenever those are tuned.
--
-- tier_expires_at IS NULL means LIFETIME (the USDC lifetime tier), not expired.
-- Stage 5's nightly downgrade sweep must read it that way.
--
-- Idempotent: CREATE ... IF NOT EXISTS only, no data rewrite. Seeds nothing --
-- the admin user is created by a separate step so this file stays deployable
-- on its own.

CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE IF NOT EXISTS users (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  email           CITEXT       NOT NULL UNIQUE,
  password_hash   TEXT         NOT NULL,
  display_name    VARCHAR(64),
  role            VARCHAR(16)  NOT NULL DEFAULT 'user',
  tier            VARCHAR(16)  NOT NULL DEFAULT 'free',
  tier_expires_at TIMESTAMPTZ,
  status          VARCHAR(16)  NOT NULL DEFAULT 'active',
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_users_role   CHECK (role IN ('user','admin')),
  CONSTRAINT chk_users_tier   CHECK (tier IN ('free','operator','ultra')),
  -- 'deleted' is a soft delete. A user with trades cannot be hard-deleted
  -- without breaking the immutable financial trail (D13).
  CONSTRAINT chk_users_status CHECK (status IN ('active','suspended','deleted'))
);

-- Partial: only rows that can expire are of interest to the downgrade sweep.
CREATE INDEX IF NOT EXISTS idx_users_tier_expiry
  ON users(tier_expires_at) WHERE tier_expires_at IS NOT NULL;
