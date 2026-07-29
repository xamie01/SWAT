ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS fee_usd NUMERIC;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'trades'::regclass
      AND conname = 'chk_trades_fee_usd_nonnegative'
  ) THEN
    ALTER TABLE trades
      ADD CONSTRAINT chk_trades_fee_usd_nonnegative
      CHECK (fee_usd IS NULL OR fee_usd >= 0);
  END IF;
END $$;
