-- G6-A1: Price snapshots for mark-to-market attribution
CREATE TABLE IF NOT EXISTS price_snapshots (
  token_mint TEXT NOT NULL,
  chain VARCHAR(50) NOT NULL,
  price_usd NUMERIC NOT NULL,
  snapshot_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (token_mint, chain, snapshot_at)
);

-- G6-A2: Idempotent signal_outcomes schema
CREATE TABLE IF NOT EXISTS signal_outcomes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_id UUID NOT NULL REFERENCES signals(id) ON DELETE CASCADE,
  pattern_type VARCHAR(50) NOT NULL,
  chain VARCHAR(50) NOT NULL,
  cluster_id UUID, -- Optional, if cluster is known
  tier VARCHAR(50),
  execution_mode VARCHAR(50) NOT NULL,
  entry_price_usd NUMERIC,
  price_1h_usd NUMERIC,
  pnl_1h_pct NUMERIC,
  price_24h_usd NUMERIC,
  pnl_24h_pct NUMERIC,
  realized_pnl_usd NUMERIC,
  hit_result BOOLEAN,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Final clean-install identity. Migration 029 independently replaces the
-- legacy signal-only index on databases that already ran an older 019.
CREATE UNIQUE INDEX IF NOT EXISTS idx_signal_outcomes_identity
  ON signal_outcomes (signal_id, chain, execution_mode);
