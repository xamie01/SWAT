-- 062_lp_copy_trading.sql
-- Forward-Only LP Copy-Trading: Subscriptions, Executions, and Activity Logs.

-- 1. Subscriptions: A user follows an external LP master wallet on a specific chain & venue
CREATE TABLE IF NOT EXISTS lp_copy_subscriptions (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                     UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  master_wallet_address       VARCHAR(128) NOT NULL, -- chain-prefixed, e.g. 'solana:...' or 'base:0x...'
  chain                       VARCHAR(32) NOT NULL CHECK (chain IN ('solana', 'robinhood-chain', 'base', 'ethereum', 'bsc')),
  venue                       VARCHAR(32) NOT NULL CHECK (venue IN ('meteora-dlmm', 'raydium-clmm', 'uniswap-v3', 'uniswap-v4', 'pancakeswap-v3')),
  allocated_budget_usd        NUMERIC NOT NULL CHECK (allocated_budget_usd > 0),
  max_capital_per_position_usd NUMERIC NOT NULL CHECK (max_capital_per_position_usd > 0),
  status                      VARCHAR(32) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'closed')),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_lp_copy_subscriptions_user_master UNIQUE (user_id, master_wallet_address, chain, venue)
);

CREATE INDEX IF NOT EXISTS idx_lp_copy_subscriptions_master
  ON lp_copy_subscriptions (master_wallet_address, chain, status)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_lp_copy_subscriptions_user
  ON lp_copy_subscriptions (user_id, status);

-- 2. Copy Executions: Every mirrored mint, burn, or harvest pass journaled
CREATE TABLE IF NOT EXISTS lp_copy_executions (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id             UUID NOT NULL REFERENCES lp_copy_subscriptions(id) ON DELETE CASCADE,
  user_id                     UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  master_position_id          VARCHAR(128) NOT NULL, -- on-chain ID or NFT tokenId of master
  follower_position_id        UUID REFERENCES lp_positions(id) ON DELETE SET NULL,
  chain                       VARCHAR(32) NOT NULL CHECK (chain IN ('solana', 'robinhood-chain', 'base', 'ethereum', 'bsc')),
  action                      VARCHAR(32) NOT NULL CHECK (action IN ('mint', 'increase', 'decrease', 'burn', 'collect')),
  master_deposit_usd          NUMERIC NOT NULL DEFAULT 0 CHECK (master_deposit_usd >= 0),
  follower_deposit_usd        NUMERIC NOT NULL DEFAULT 0 CHECK (follower_deposit_usd >= 0),
  scale_ratio                 NUMERIC NOT NULL DEFAULT 1.0 CHECK (scale_ratio > 0),
  status                      VARCHAR(32) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'executing', 'executed', 'failed', 'rejected')),
  error_message               TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lp_copy_executions_sub
  ON lp_copy_executions (subscription_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_lp_copy_executions_master_pos
  ON lp_copy_executions (master_position_id, chain);
