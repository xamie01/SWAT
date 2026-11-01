-- 062_source_trade_fees.sql
-- Store on-chain execution fee for master trades to compute true net-of-fee P&L (S4-M8).

ALTER TABLE source_trades
  ADD COLUMN IF NOT EXISTS fee_usd NUMERIC(16, 6) NULL;
