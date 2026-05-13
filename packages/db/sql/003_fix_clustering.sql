-- Fix 1: Add UNIQUE index on wallet_clusters.name (required for ON CONFLICT)
CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_clusters_name ON wallet_clusters(name);

-- Fix 2: Add config rows missing from init (matching swat.md spec §13)
INSERT INTO config (key, value) VALUES
('signals',   '{"min_signal_score": 70, "auto_execute_min_score": 90, "min_liquidity_usd": 50000}'::jsonb),
('discovery', '{"auto_expand_funding_graph": true, "auto_expand_counterparties": true, "min_invested_lamports": 500000000}'::jsonb),
('pruning',   '{"min_trades_to_prune": 50, "min_score_to_keep": 40, "max_inactive_days": 30}'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();

-- Fix mismatched stop_loss_pct and take_profit_levels (spec says 25% SL, 2x/3x TP)
UPDATE config SET
  value = '{"stop_loss_pct": 25, "take_profit_levels": [{"pct": 100, "sell": 50}, {"pct": 200, "sell": 25}], "circuit_breaker_failures": 3}'::jsonb,
  updated_at = NOW()
WHERE key = 'risk';

-- Fix min_signal_score (spec: 70, not 60) and auto_execute (spec: 90, not 80)
UPDATE config SET
  value = '{"enabled": false, "mode": "paper", "base_position_sol": 0.5, "auto_execute_min_score": 90}'::jsonb,
  updated_at = NOW()
WHERE key = 'trading';
