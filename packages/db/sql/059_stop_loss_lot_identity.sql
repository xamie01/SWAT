-- 059_stop_loss_lot_identity.sql
-- Add the master-lot dimension to stop-loss claims. LP migrations use their
-- separate sql-lp/059 namespace and are never loaded by the core profile.

ALTER TABLE signal_stop_losses
  ADD COLUMN IF NOT EXISTS position_key VARCHAR(256) NOT NULL DEFAULT '';

DO $$
DECLARE
  primary_key_name text;
BEGIN
  SELECT conname INTO primary_key_name
    FROM pg_constraint
   WHERE conrelid = 'signal_stop_losses'::regclass
     AND contype = 'p'
     AND cardinality(conkey) = 2;
  IF primary_key_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE signal_stop_losses DROP CONSTRAINT %I', primary_key_name);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'signal_stop_losses'::regclass
       AND contype = 'p'
       AND cardinality(conkey) = 3
  ) THEN
    ALTER TABLE signal_stop_losses
      ADD CONSTRAINT signal_stop_losses_pkey PRIMARY KEY (account, signal_id, position_key);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_signal_stop_losses_position
  ON signal_stop_losses (account, position_key, triggered_at DESC);
