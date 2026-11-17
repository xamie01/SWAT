-- Forward-only LP paper accounting. Legacy acquisitions remain unknown: no mode
-- or USD price is inferred from today's global execution clamp.
ALTER TABLE lp_positions
  ADD COLUMN acquisition_mode VARCHAR(16) NOT NULL DEFAULT 'unknown'
    CHECK (acquisition_mode IN ('unknown', 'paper', 'live')),
  ADD COLUMN acquisition_provenance TEXT,
  ADD COLUMN deposit_value_usd NUMERIC CHECK (deposit_value_usd > 0 AND deposit_value_usd <> 'NaN'::numeric),
  ADD COLUMN valuation_evidence JSONB,
  ADD COLUMN paper_plan JSONB,
  ADD COLUMN acquisition_key TEXT,
  ADD COLUMN acquisition_fingerprint TEXT;
CREATE UNIQUE INDEX uq_lp_acquisition_key ON lp_positions(user_id, acquisition_key)
  WHERE acquisition_key IS NOT NULL;
ALTER TABLE lp_positions ADD CONSTRAINT chk_lp_paper_acquisition CHECK (
  acquisition_mode <> 'paper' OR
  (acquisition_provenance IS NOT NULL AND deposit_value_usd IS NOT NULL
   AND valuation_evidence IS NOT NULL AND paper_plan IS NOT NULL
   AND acquisition_key IS NOT NULL AND acquisition_fingerprint IS NOT NULL
   AND on_chain_position_address IS NULL)
);
CREATE OR REPLACE FUNCTION enforce_lp_acquisition_immutable() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.acquisition_mode, NEW.acquisition_provenance, NEW.deposit_value_usd,
         NEW.valuation_evidence, NEW.deposit_amount, NEW.deposit_asset,
         NEW.acquisition_key, NEW.acquisition_fingerprint, NEW.user_id, NEW.chain,
         NEW.protocol, NEW.pool_address)
     IS DISTINCT FROM
     ROW(OLD.acquisition_mode, OLD.acquisition_provenance, OLD.deposit_value_usd,
         OLD.valuation_evidence, OLD.deposit_amount, OLD.deposit_asset,
         OLD.acquisition_key, OLD.acquisition_fingerprint, OLD.user_id, OLD.chain,
         OLD.protocol, OLD.pool_address) THEN
    RAISE EXCEPTION 'LP acquisition evidence is immutable';
  END IF;
  IF NEW.acquisition_mode = 'paper' AND NEW.on_chain_position_address IS NOT NULL THEN
    RAISE EXCEPTION 'paper LP position cannot carry a broadcast address';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_lp_acquisition_immutable BEFORE UPDATE ON lp_positions
  FOR EACH ROW EXECUTE FUNCTION enforce_lp_acquisition_immutable();

-- Durable outbox: Redis is only a delivery hint. Work and its resulting plan,
-- history and completion are committed on the same checked-out client.
CREATE TABLE lp_paper_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  position_id UUID NOT NULL REFERENCES lp_positions(id) ON DELETE RESTRICT,
  operation_key TEXT NOT NULL,
  kind VARCHAR(16) NOT NULL CHECK (kind IN ('rebalance', 'close')),
  fingerprint TEXT NOT NULL,
  plan JSONB,
  status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  UNIQUE(user_id, operation_key),
  CHECK ((status = 'pending') = (completed_at IS NULL)),
  CHECK (kind <> 'rebalance' OR plan IS NOT NULL)
);
CREATE INDEX idx_lp_paper_operations_recovery ON lp_paper_operations(created_at) WHERE status = 'pending';
CREATE UNIQUE INDEX uq_lp_paper_pending_position ON lp_paper_operations(position_id) WHERE status = 'pending';
