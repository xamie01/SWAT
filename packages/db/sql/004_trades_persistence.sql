-- Trade persistence + mark-to-market support
--
-- 1. token_amount was BIGINT, which cannot store fractional human-unit token
--    amounts. Widen to NUMERIC so trades can record real positions.
-- 2. Index trades(signal_id) — joined on for mark-to-market P&L and portfolio.
-- 3. Index transactions(token_in) — funding-edge / token lookups.

ALTER TABLE trades
  ALTER COLUMN token_amount TYPE NUMERIC USING token_amount::numeric;

CREATE INDEX IF NOT EXISTS idx_trades_signal ON trades(signal_id);
CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status, executed_at DESC);
