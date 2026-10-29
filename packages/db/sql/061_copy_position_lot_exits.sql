-- 061_copy_position_lot_exits.sql
-- User/risk initiated exits have evidence but no master source event.

ALTER TABLE copy_executions
  ALTER COLUMN source_trade_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS exit_lot_id UUID REFERENCES copy_position_master_lots(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS exit_trigger TEXT CHECK (exit_trigger IN ('close-all', 'stop-loss', 'manual', 'redemption'));

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'copy_executions'::regclass AND conname = 'chk_copy_execution_origin') THEN
    ALTER TABLE copy_executions ADD CONSTRAINT chk_copy_execution_origin CHECK (
      (source_trade_id IS NOT NULL AND exit_lot_id IS NULL AND exit_trigger IS NULL)
      OR (source_trade_id IS NULL AND exit_lot_id IS NOT NULL AND exit_trigger IS NOT NULL AND direction = 'sell')
    );
  END IF;
END $$;

ALTER TABLE copy_executions DROP CONSTRAINT IF EXISTS chk_copy_executions_source_snapshot;
ALTER TABLE copy_executions ADD CONSTRAINT chk_copy_executions_source_snapshot CHECK (
  (exit_lot_id IS NOT NULL AND direction = 'sell'
    AND source_position_before_quantity IS NULL AND source_sell_fraction IS NULL)
  OR (exit_lot_id IS NULL AND (
    signal_id IS NULL
    OR (direction = 'buy' AND source_position_before_quantity IS NULL AND source_sell_fraction IS NULL)
    OR (direction = 'sell' AND source_position_before_quantity IS NOT NULL
      AND source_sell_fraction IS NOT NULL AND source_position_before_quantity > 0
      AND source_sell_fraction > 0 AND source_sell_fraction <= 1)
  ))
);

DROP INDEX IF EXISTS uq_copy_executions_source_target_mode_user;
CREATE UNIQUE INDEX uq_copy_executions_source_target_mode_user
  ON copy_executions (source_trade_id, target_account, execution_mode, user_id)
  NULLS NOT DISTINCT WHERE source_trade_id IS NOT NULL;
DROP INDEX IF EXISTS unq_copy_executions_signal_target_mode;
CREATE UNIQUE INDEX unq_copy_executions_signal_target_mode
  ON copy_executions (signal_id, target_account, execution_mode, user_id)
  NULLS NOT DISTINCT WHERE signal_id IS NOT NULL AND source_trade_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_copy_execution_open_lot_exit
  ON copy_executions (exit_lot_id)
  WHERE exit_lot_id IS NOT NULL AND state NOT IN ('failed', 'cancelled', 'confirmed');

ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS exit_lot_id UUID REFERENCES copy_position_master_lots(id) ON DELETE RESTRICT;
ALTER TABLE trades DROP CONSTRAINT IF EXISTS chk_trades_copy_execution_identity_complete;
ALTER TABLE trades ADD CONSTRAINT chk_trades_copy_execution_identity_complete CHECK (
  copy_execution_id IS NULL OR
  (signal_id IS NOT NULL AND source_trade_id IS NOT NULL AND exit_lot_id IS NULL) OR
  (signal_id IS NOT NULL AND source_trade_id IS NULL AND exit_lot_id IS NOT NULL)
);

CREATE OR REPLACE FUNCTION enforce_copy_lot_exit_identity()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.exit_lot_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM copy_position_master_lots lot
    JOIN copy_positions position ON position.id = lot.position_id
    WHERE lot.id = NEW.exit_lot_id
      AND lot.user_id IS NOT DISTINCT FROM NEW.user_id
      AND lot.chain = NEW.chain AND lot.token_mint = NEW.token_mint
      AND lot.signal_id IS NOT DISTINCT FROM NEW.signal_id
      AND position.target_account = NEW.target_account
  ) THEN
    RAISE EXCEPTION 'lot exit identity does not match its owning position';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_copy_lot_exit_identity ON copy_executions;
CREATE TRIGGER trg_copy_lot_exit_identity BEFORE INSERT OR UPDATE OF exit_lot_id, user_id, chain, token_mint, signal_id, target_account
  ON copy_executions FOR EACH ROW EXECUTE FUNCTION enforce_copy_lot_exit_identity();

CREATE OR REPLACE FUNCTION enforce_trade_lot_exit_identity()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.exit_lot_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM copy_executions execution
    WHERE execution.id = NEW.copy_execution_id AND execution.exit_lot_id = NEW.exit_lot_id
      AND execution.user_id IS NOT DISTINCT FROM NEW.user_id
      AND execution.signal_id IS NOT DISTINCT FROM NEW.signal_id
      AND execution.chain = NEW.chain AND execution.token_mint = NEW.token_mint
      AND execution.execution_mode = NEW.execution_mode
  ) THEN
    RAISE EXCEPTION 'trade lot exit identity does not match execution';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_trade_lot_exit_identity ON trades;
CREATE TRIGGER trg_trade_lot_exit_identity BEFORE INSERT OR UPDATE ON trades
  FOR EACH ROW EXECUTE FUNCTION enforce_trade_lot_exit_identity();
