-- 058_copy_position_lots.sql
--
-- Master-attributed inventory for downstream exits (S4-M3 / ADR-0007).
-- A copy position is an aggregate tenant/token ledger; these rows preserve which
-- source master and signal supplied each open quantity. All statements are replay-safe
-- because db:migrate replays every SQL file on every invocation.

CREATE TABLE IF NOT EXISTS copy_position_master_lots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  position_id UUID NOT NULL REFERENCES copy_positions(id) ON DELETE RESTRICT,
  user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  master_wallet_address VARCHAR(128) NOT NULL,
  chain VARCHAR(64) NOT NULL CHECK (chain IN ('solana', 'polygon', 'robinhood-chain')),
  token_mint VARCHAR(128) NOT NULL,
  signal_id UUID REFERENCES signals(id) ON DELETE RESTRICT,
  source_trade_id UUID NOT NULL REFERENCES source_trades(id) ON DELETE RESTRICT,
  acquisition_execution_id UUID NOT NULL REFERENCES copy_executions(id) ON DELETE RESTRICT,
  acquisition_evidence_id UUID NOT NULL REFERENCES copy_execution_evidence(id) ON DELETE RESTRICT,
  acquired_quantity NUMERIC NOT NULL CHECK (acquired_quantity > 0),
  reduced_quantity NUMERIC NOT NULL DEFAULT 0 CHECK (reduced_quantity >= 0),
  remaining_quantity NUMERIC NOT NULL CHECK (remaining_quantity >= 0),
  acquired_cost_basis_usd NUMERIC,
  remaining_cost_basis_usd NUMERIC,
  acquired_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_copy_position_lot_quantity_bounds
    CHECK (reduced_quantity <= acquired_quantity AND remaining_quantity <= acquired_quantity),
  CONSTRAINT chk_copy_position_lot_cost_bounds
    CHECK (
      acquired_cost_basis_usd IS NULL
      OR (acquired_cost_basis_usd >= 0 AND remaining_cost_basis_usd IS NOT NULL AND remaining_cost_basis_usd >= 0)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_copy_position_master_lots_evidence
  ON copy_position_master_lots (acquisition_evidence_id);

CREATE INDEX IF NOT EXISTS idx_copy_position_master_lots_open
  ON copy_position_master_lots (position_id, master_wallet_address, acquired_at, id)
  WHERE remaining_quantity > 0;

CREATE INDEX IF NOT EXISTS idx_copy_position_master_lots_signal
  ON copy_position_master_lots (user_id, master_wallet_address, signal_id)
  WHERE remaining_quantity > 0;

-- Every reduction is durable and idempotent per sell evidence and source lot.
CREATE TABLE IF NOT EXISTS copy_position_master_lot_reductions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id UUID NOT NULL REFERENCES copy_position_master_lots(id) ON DELETE RESTRICT,
  sell_execution_id UUID NOT NULL REFERENCES copy_executions(id) ON DELETE RESTRICT,
  sell_evidence_id UUID NOT NULL REFERENCES copy_execution_evidence(id) ON DELETE RESTRICT,
  quantity NUMERIC NOT NULL CHECK (quantity > 0),
  proceeds_usd NUMERIC,
  reduced_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (lot_id, sell_evidence_id)
);

CREATE INDEX IF NOT EXISTS idx_copy_position_master_lot_reductions_evidence
  ON copy_position_master_lot_reductions (sell_evidence_id);

CREATE OR REPLACE FUNCTION enforce_copy_position_lot_parent()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  position_user_id UUID;
  position_chain VARCHAR(64);
  position_token_mint VARCHAR(128);
BEGIN
  SELECT user_id, chain, token_mint
    INTO position_user_id, position_chain, position_token_mint
    FROM copy_positions
   WHERE id = NEW.position_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'copy position lot references missing position %', NEW.position_id;
  END IF;
  IF position_user_id IS DISTINCT FROM NEW.user_id
     OR position_chain IS DISTINCT FROM NEW.chain
     OR position_token_mint IS DISTINCT FROM NEW.token_mint THEN
    RAISE EXCEPTION 'copy position lot ownership does not match parent position %', NEW.position_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_copy_position_lot_parent ON copy_position_master_lots;
CREATE TRIGGER trg_copy_position_lot_parent
  BEFORE INSERT OR UPDATE OF position_id, user_id, chain, token_mint
  ON copy_position_master_lots
  FOR EACH ROW EXECUTE FUNCTION enforce_copy_position_lot_parent();

COMMENT ON TABLE copy_position_master_lots IS
  'Master/signal-attributed inventory lots under a tenant copy position. '
  'Open quantity is never borrowed across masters (ADR-0007, S4-M3).';

COMMENT ON COLUMN copy_position_master_lots.user_id IS
  'Tenant copied by this lot. NULL is the legacy operator account.';
