-- 060_close_all_claims.sql
-- Durable exactly-once claims for explicit tenant close-all sells.

CREATE TABLE IF NOT EXISTS copy_position_close_all_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id UUID NOT NULL REFERENCES copy_position_master_lots(id) ON DELETE RESTRICT,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  wallet_address VARCHAR(128) NOT NULL,
  requested_quantity NUMERIC NOT NULL CHECK (requested_quantity > 0),
  status VARCHAR(16) NOT NULL DEFAULT 'claimed'
    CHECK (status IN ('claimed', 'confirmed', 'released')),
  execution_id UUID REFERENCES copy_executions(id) ON DELETE RESTRICT,
  evidence_id UUID REFERENCES copy_execution_evidence(id) ON DELETE RESTRICT,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmed_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  CHECK (
    (status = 'claimed' AND confirmed_at IS NULL AND released_at IS NULL)
    OR (status = 'confirmed' AND confirmed_at IS NOT NULL AND released_at IS NULL)
    OR (status = 'released' AND released_at IS NOT NULL AND confirmed_at IS NULL)
  ),
  UNIQUE (lot_id, status) DEFERRABLE INITIALLY IMMEDIATE
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_close_all_claim_active_lot
  ON copy_position_close_all_claims (lot_id)
  WHERE status IN ('claimed', 'confirmed');

CREATE INDEX IF NOT EXISTS idx_close_all_claims_pending
  ON copy_position_close_all_claims (status, claimed_at)
  WHERE status = 'claimed';
