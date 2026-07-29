-- Attribution identity and immutable expectancy report snapshots.

DROP INDEX IF EXISTS idx_signal_outcomes_signal_id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_signal_outcomes_identity
  ON signal_outcomes (signal_id, chain, execution_mode);

-- Migration 019 treated missing realized P&L as zero. Retain those outcome rows,
-- but restore unknown semantics when no complete buy/sell evidence exists.
UPDATE signal_outcomes so
SET realized_pnl_usd = NULL,
    hit_result = NULL
WHERE so.realized_pnl_usd = 0
  AND so.hit_result = FALSE
  AND NOT EXISTS (
    SELECT 1
    FROM trades t
    WHERE t.signal_id = so.signal_id
      AND t.chain = so.chain
      AND COALESCE(t.execution_mode, 'paper') = so.execution_mode
      AND t.status = 'filled'
      AND (t.execution_mode IS NULL OR t.execution_mode <> 'shadow')
    HAVING COUNT(*) FILTER (WHERE t.direction = 'buy') > 0
       AND COUNT(*) FILTER (WHERE t.direction = 'sell') > 0
       AND BOOL_AND(t.amount_usd IS NOT NULL AND t.token_amount IS NOT NULL)
             FILTER (WHERE t.direction = 'buy')
       AND BOOL_AND(t.amount_usd IS NOT NULL AND t.token_amount IS NOT NULL)
             FILTER (WHERE t.direction = 'sell')
  );

CREATE TABLE IF NOT EXISTS expectancy_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  config_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  rows JSONB NOT NULL DEFAULT '[]'::jsonb,
  CONSTRAINT expectancy_reports_config_object
    CHECK (jsonb_typeof(config_snapshot) = 'object'),
  CONSTRAINT expectancy_reports_rows_array
    CHECK (jsonb_typeof(rows) = 'array')
);

CREATE INDEX IF NOT EXISTS idx_expectancy_reports_generated_at
  ON expectancy_reports (generated_at DESC, id DESC);
