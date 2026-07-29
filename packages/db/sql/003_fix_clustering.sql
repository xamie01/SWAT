-- Fix 1: Add UNIQUE index on wallet_clusters.name (required for ON CONFLICT)
CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_clusters_name ON wallet_clusters(name);

-- Fix 2: Add config rows missing from init (matching swat.md spec §13)
INSERT INTO config (key, value) VALUES
('signals',   '{"min_signal_score": 70, "auto_execute_min_score": 90, "min_liquidity_usd": 50000}'::jsonb),
('discovery', '{"auto_expand_funding_graph": true, "auto_expand_counterparties": true, "min_invested_lamports": 500000000}'::jsonb),
('pruning',   '{"min_trades_to_prune": 50, "min_score_to_keep": 40, "max_inactive_days": 30}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Config is operator-owned after its initial seed. Never overwrite it during
-- migration replay; this repository intentionally reruns every SQL file.
