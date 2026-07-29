ALTER TABLE signals
  ADD COLUMN IF NOT EXISTS realized_pnl_usd NUMERIC,
  ADD COLUMN IF NOT EXISTS unrealized_pnl_usd NUMERIC;
