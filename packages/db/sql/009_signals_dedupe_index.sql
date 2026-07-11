-- Unique partial index to enforce atomic deduplication at the DB level.
-- Prevents the CTE-based check-then-insert race condition.
CREATE UNIQUE INDEX IF NOT EXISTS idx_signals_dedupe_active
  ON signals (pattern_type, token_mint)
  WHERE status = 'pending' AND token_mint IS NOT NULL;

-- Covering index for the dedupe query to eliminate sequential scans.
CREATE INDEX IF NOT EXISTS idx_signals_dedupe_lookup
  ON signals (pattern_type, token_mint, created_at DESC)
  WHERE token_mint IS NOT NULL;
