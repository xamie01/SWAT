-- 036_transactions_brin.sql
-- BRIN index on the append-ordered `transactions.timestamp`.
--
-- Rows arrive in near-timestamp order, so each block range holds a narrow
-- min/max — the access pattern BRIN is built for. It is a fraction of a btree's
-- size at this table's growth rate, and range scans over recent activity are
-- the dominant read.
--
-- The existing btrees in 001_init.sql are kept: they cover
-- (wallet_address, timestamp DESC) and (target_token, timestamp DESC), which
-- BRIN cannot serve because it has no per-row pointers to filter a single
-- wallet by.
--
-- Idempotent: CREATE INDEX IF NOT EXISTS only.

CREATE INDEX IF NOT EXISTS idx_tx_timestamp_brin
  ON transactions USING BRIN (timestamp);
