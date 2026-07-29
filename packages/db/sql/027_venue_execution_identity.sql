ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS venue_order_id VARCHAR(128),
  ADD COLUMN IF NOT EXISTS venue_status VARCHAR(64),
  ADD COLUMN IF NOT EXISTS venue_trade_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS settlement_transaction_hashes JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS idx_trades_live_venue_order_id
  ON trades (executor, venue_order_id)
  WHERE execution_mode = 'live' AND venue_order_id IS NOT NULL;
