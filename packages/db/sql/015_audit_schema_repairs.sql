-- Runtime/schema alignment and EVM amount capacity.

ALTER TABLE polymarket_markets
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();

UPDATE polymarket_markets
   SET updated_at = created_at
 WHERE updated_at IS NULL;

ALTER TABLE polymarket_markets
  ALTER COLUMN updated_at SET DEFAULT NOW(),
  ALTER COLUMN updated_at SET NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'transactions'
       AND column_name = 'amount_in'
       AND data_type <> 'numeric'
  ) THEN
    ALTER TABLE transactions
      ALTER COLUMN amount_in TYPE NUMERIC USING amount_in::numeric;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'transactions'
       AND column_name = 'amount_out'
       AND data_type <> 'numeric'
  ) THEN
    ALTER TABLE transactions
      ALTER COLUMN amount_out TYPE NUMERIC USING amount_out::numeric;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS ingestion_health (
  chain VARCHAR(32) PRIMARY KEY,
  last_event_at TIMESTAMPTZ,
  last_batch_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  inserted_total BIGINT NOT NULL DEFAULT 0,
  skipped_total BIGINT NOT NULL DEFAULT 0,
  failed_total BIGINT NOT NULL DEFAULT 0,
  alert_status VARCHAR(16) NOT NULL DEFAULT 'unknown',
  alert_reservation UUID,
  alert_reserved_status VARCHAR(16),
  alert_reserved_at TIMESTAMPTZ,
  alerted_at TIMESTAMPTZ,
  recovered_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ingestion_health_chain_check
    CHECK (chain IN ('solana', 'polygon', 'robinhood-chain')),
  CONSTRAINT ingestion_health_alert_status_check
    CHECK (alert_status IN ('unknown', 'healthy', 'stale')),
  CONSTRAINT ingestion_health_reserved_status_check
    CHECK (
      alert_reserved_status IS NULL
      OR alert_reserved_status IN ('healthy', 'stale')
    )
);

INSERT INTO ingestion_health (chain)
VALUES ('solana'), ('polygon'), ('robinhood-chain')
ON CONFLICT (chain) DO NOTHING;

CREATE TABLE IF NOT EXISTS ingestion_health_batches (
  id BIGSERIAL PRIMARY KEY,
  chain VARCHAR(32) NOT NULL REFERENCES ingestion_health(chain) ON DELETE CASCADE,
  source VARCHAR(100) NOT NULL,
  batch_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_event_at TIMESTAMPTZ,
  inserted_count INTEGER NOT NULL DEFAULT 0 CHECK (inserted_count >= 0),
  skipped_count INTEGER NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
  failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ingestion_health_batches_chain_time
  ON ingestion_health_batches (chain, batch_at DESC);
