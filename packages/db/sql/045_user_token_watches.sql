-- 045_user_token_watches.sql
-- Per-user token-contract backfills. Feeds the existing swat-token-discovery
-- queue; wallets discovered as early/large buyers are auto-subscribed for the
-- requesting user with source 'discovered'.
--
-- Surrogate primary key here, unlike 044: a watch carries lifecycle state that
-- outlives its identity, and the daily-quota query counts rows by created_at.
--
-- UNIQUE (user_id, chain, token_mint) makes re-requesting the same backfill
-- idempotent rather than burning a day's quota on a duplicate.
--
-- Idempotent: CREATE ... IF NOT EXISTS only.

CREATE TABLE IF NOT EXISTS user_token_watches (
  id         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chain      VARCHAR(32)  NOT NULL,
  -- Chain-prefixed, like every other mint in the schema.
  token_mint VARCHAR(100) NOT NULL,
  status     VARCHAR(16)  NOT NULL DEFAULT 'pending',
  error      TEXT,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_token_watch_status
    CHECK (status IN ('pending','running','complete','failed')),
  CONSTRAINT uq_token_watch UNIQUE (user_id, chain, token_mint)
);

-- Serves the rolling-24h quota count directly.
CREATE INDEX IF NOT EXISTS idx_utw_user_created
  ON user_token_watches(user_id, created_at DESC);
