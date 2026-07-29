-- Link immutable source events to their derived signal, canonical execution,
-- and compatibility trade row without changing legacy aggregate signals.

ALTER TABLE signals
  ADD COLUMN IF NOT EXISTS source_trade_id UUID REFERENCES source_trades(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS source_side VARCHAR(16),
  ADD COLUMN IF NOT EXISTS source_position_before_quantity NUMERIC,
  ADD COLUMN IF NOT EXISTS source_position_evidence_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS source_sell_fraction NUMERIC,
  ADD COLUMN IF NOT EXISTS source_dispatched_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS unq_signals_source_trade
  ON signals (source_trade_id)
  WHERE source_trade_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS unq_signals_id_source_trade
  ON signals (id, source_trade_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'signals'::regclass
      AND conname = 'chk_signals_source_trade_snapshot'
  ) THEN
    ALTER TABLE signals
      ADD CONSTRAINT chk_signals_source_trade_snapshot
      CHECK (
        (source_trade_id IS NULL
          AND source_side IS NULL
          AND source_position_before_quantity IS NULL
          AND source_position_evidence_at IS NULL
          AND source_sell_fraction IS NULL)
        OR
        (source_trade_id IS NOT NULL
          AND source_side = 'buy'
          AND source_position_before_quantity IS NULL
          AND source_position_evidence_at IS NULL
          AND source_sell_fraction IS NULL)
        OR
        (source_trade_id IS NOT NULL
          AND source_side = 'sell'
          AND source_position_before_quantity > 0
          AND source_position_evidence_at IS NOT NULL
          AND source_sell_fraction > 0
          AND source_sell_fraction <= 1)
      );
  END IF;
END $$;

ALTER TABLE copy_executions
  ADD COLUMN IF NOT EXISTS signal_id UUID,
  ADD COLUMN IF NOT EXISTS source_position_before_quantity NUMERIC,
  ADD COLUMN IF NOT EXISTS source_sell_fraction NUMERIC;

CREATE UNIQUE INDEX IF NOT EXISTS unq_copy_executions_id_signal_source
  ON copy_executions (id, signal_id, source_trade_id);

CREATE UNIQUE INDEX IF NOT EXISTS unq_copy_executions_signal_target_mode
  ON copy_executions (signal_id, target_account, execution_mode)
  WHERE signal_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS unq_copy_executions_submission_identity
  ON copy_executions (chain, submission_type, submission_id)
  WHERE submission_id IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'copy_executions'::regclass
      AND conname = 'fk_copy_executions_signal_source'
  ) THEN
    ALTER TABLE copy_executions
      ADD CONSTRAINT fk_copy_executions_signal_source
      FOREIGN KEY (signal_id, source_trade_id)
      REFERENCES signals (id, source_trade_id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'copy_executions'::regclass
      AND conname = 'chk_copy_executions_source_snapshot'
  ) THEN
    ALTER TABLE copy_executions
      ADD CONSTRAINT chk_copy_executions_source_snapshot
      CHECK (
        signal_id IS NULL
        OR (direction = 'buy'
          AND source_position_before_quantity IS NULL
          AND source_sell_fraction IS NULL)
        OR (direction = 'sell'
          AND source_position_before_quantity > 0
          AND source_sell_fraction > 0
          AND source_sell_fraction <= 1)
      );
  END IF;
END $$;

ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS copy_execution_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS unq_trades_copy_execution
  ON trades (copy_execution_id)
  WHERE copy_execution_id IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'trades'::regclass
      AND conname = 'fk_trades_copy_execution_identity'
  ) THEN
    ALTER TABLE trades
      ADD CONSTRAINT fk_trades_copy_execution_identity
      FOREIGN KEY (copy_execution_id, signal_id, source_trade_id)
      REFERENCES copy_executions (id, signal_id, source_trade_id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'trades'::regclass
      AND conname = 'chk_trades_copy_execution_identity_complete'
  ) THEN
    ALTER TABLE trades
      ADD CONSTRAINT chk_trades_copy_execution_identity_complete
      CHECK (
        copy_execution_id IS NULL
        OR (signal_id IS NOT NULL AND source_trade_id IS NOT NULL)
      );
  END IF;
END $$;
