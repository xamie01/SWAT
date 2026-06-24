-- Tag wallets with HOW they were discovered, so the on-chain token-discovery
-- pipeline can distinguish its two cohorts:
--   'token-early' — among the first big buyers after launch (kept unconditionally)
--   'token-big'   — a biggest-ever buyer of the token (kept only if profitable)
-- Existing discovery paths (funding graph, counterparties) leave this NULL.
ALTER TABLE wallets ADD COLUMN IF NOT EXISTS discovery_method VARCHAR(30);

-- Speeds up the profit-prune that targets only 'token-big' wallets.
CREATE INDEX IF NOT EXISTS idx_wallets_discovery_method
  ON wallets (discovery_method);
