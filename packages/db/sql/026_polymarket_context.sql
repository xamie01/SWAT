-- Canonical Polymarket outcome context and confirmed Data API trades.

ALTER TABLE polymarket_markets
  ADD COLUMN IF NOT EXISTS tick_size NUMERIC(20, 18),
  ADD COLUMN IF NOT EXISTS neg_risk BOOLEAN,
  ADD COLUMN IF NOT EXISTS accepting_orders BOOLEAN,
  ADD COLUMN IF NOT EXISTS resolution_status VARCHAR(32),
  ADD COLUMN IF NOT EXISTS context_complete BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS polymarket_outcomes (
  token_id VARCHAR(100) PRIMARY KEY REFERENCES tokens(mint) ON DELETE CASCADE,
  condition_id VARCHAR(66) NOT NULL REFERENCES polymarket_markets(condition_id) ON DELETE CASCADE,
  outcome TEXT NOT NULL CHECK (length(trim(outcome)) > 0),
  outcome_index INTEGER NOT NULL CHECK (outcome_index >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (condition_id, outcome_index)
);

CREATE INDEX IF NOT EXISTS idx_polymarket_outcomes_condition
  ON polymarket_outcomes (condition_id, outcome_index);

CREATE TABLE IF NOT EXISTS polymarket_trades (
  id BIGSERIAL PRIMARY KEY,
  transaction_hash VARCHAR(100) NOT NULL,
  proxy_wallet VARCHAR(100) NOT NULL REFERENCES wallets(address),
  asset VARCHAR(100) NOT NULL REFERENCES tokens(mint),
  condition_id VARCHAR(66) NOT NULL REFERENCES polymarket_markets(condition_id),
  side VARCHAR(4) NOT NULL CHECK (side IN ('BUY', 'SELL')),
  size NUMERIC(40, 18) NOT NULL CHECK (size > 0),
  price NUMERIC(20, 18) NOT NULL CHECK (price > 0 AND price <= 1),
  trade_timestamp TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (
    transaction_hash,
    proxy_wallet,
    asset,
    side,
    size,
    price,
    trade_timestamp
  )
);

CREATE INDEX IF NOT EXISTS idx_polymarket_trades_wallet_time
  ON polymarket_trades (proxy_wallet, trade_timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_polymarket_trades_condition_time
  ON polymarket_trades (condition_id, trade_timestamp DESC);
