-- Support Polymarket prediction markets
CREATE TABLE IF NOT EXISTS polymarket_markets (
  condition_id VARCHAR(66) PRIMARY KEY,
  question TEXT NOT NULL,
  slug TEXT,
  end_date TIMESTAMP,
  resolution_source TEXT,
  outcome_count INTEGER NOT NULL,
  clob_token_ids JSONB, -- list of token IDs for outcomes (e.g. Yes/No)
  status VARCHAR(20) DEFAULT 'active',
  resolved_outcome VARCHAR(50),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Link outcome tokens to their parent market
ALTER TABLE tokens
  ADD COLUMN IF NOT EXISTS polymarket_condition_id VARCHAR(66) REFERENCES polymarket_markets(condition_id) ON DELETE SET NULL;
