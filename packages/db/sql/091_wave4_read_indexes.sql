-- 091_wave4_read_indexes.sql
--
-- Targeted composite and partial read indexes for Wave 4 high-concurrency read paths:
--   * GET /v1/me/feed              -> source_trades (wallet_address, event_at DESC)
--   * GET /v1/me/signals           -> signals (cluster_id, detected_at DESC)
--   * GET /v1/me/wallets, /account -> user_wallet_subscriptions (user_id, state, created_at DESC)
--   * GET /v1/me/masters           -> wallets (composite_score DESC NULLS LAST, address ASC) WHERE status = 'active'
--   * Active master lookups        -> user_wallet_subscriptions (wallet_address, user_id) WHERE state = 'active'
--
-- transactions(wallet_address, timestamp DESC) is already indexed by idx_tx_wallet (001_init.sql).
-- Transactional DDL owned by migratePristine / migration runner (no BEGIN/COMMIT/CONCURRENTLY).

CREATE INDEX IF NOT EXISTS idx_source_trades_wallet_event_desc
  ON source_trades (wallet_address, event_at DESC);

CREATE INDEX IF NOT EXISTS idx_signals_cluster_detected_desc
  ON signals (cluster_id, detected_at DESC);

CREATE INDEX IF NOT EXISTS idx_cluster_memberships_wallet_cluster
  ON cluster_memberships (wallet_address, cluster_id);

CREATE INDEX IF NOT EXISTS idx_uws_user_live_created_desc
  ON user_wallet_subscriptions (user_id, state, created_at DESC)
  WHERE state <> 'ended';

CREATE INDEX IF NOT EXISTS idx_uws_wallet_active_user
  ON user_wallet_subscriptions (wallet_address, user_id)
  WHERE state = 'active';

CREATE INDEX IF NOT EXISTS idx_wallets_active_score_desc
  ON wallets (composite_score DESC NULLS LAST, address ASC)
  WHERE status = 'active';
