-- Clean up existing duplicate pending signals, keeping only the latest one.
DELETE FROM signals s1
WHERE s1.status = 'pending'
  AND s1.token_mint IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM signals s2
    WHERE s2.pattern_type = s1.pattern_type
      AND s2.token_mint = s1.token_mint
      AND s2.status = 'pending'
      AND s2.id > s1.id
  );

-- Unique partial index to enforce atomic deduplication at the DB level.
-- Prevents the CTE-based check-then-insert race condition.
CREATE UNIQUE INDEX IF NOT EXISTS idx_signals_dedupe_active
  ON signals (pattern_type, token_mint)
  WHERE status = 'pending' AND token_mint IS NOT NULL;

-- Covering index for the dedupe query to eliminate sequential scans.
CREATE INDEX IF NOT EXISTS idx_signals_dedupe_lookup
  ON signals (pattern_type, token_mint, created_at DESC)
  WHERE token_mint IS NOT NULL;
