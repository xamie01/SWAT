-- Canonical source-event, position, and copy-execution lifecycle.
-- This migration extends 023/027 forward so previously-applied migrations remain immutable.

ALTER TABLE source_trades
  ALTER COLUMN transaction_hash DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS source_event_type TEXT,
  ADD COLUMN IF NOT EXISTS source_event_id VARCHAR(256),
  ADD COLUMN IF NOT EXISTS source_event_index VARCHAR(128),
  ADD COLUMN IF NOT EXISTS event_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS observed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS confirmation_state TEXT,
  ADD COLUMN IF NOT EXISTS confirmation_updated_at TIMESTAMPTZ;

UPDATE source_trades
SET source_event_type = COALESCE(source_event_type, 'transaction'),
    source_event_id = COALESCE(source_event_id, transaction_hash),
    source_event_index = COALESCE(source_event_index, '0'),
    event_at = COALESCE(event_at, created_at),
    observed_at = COALESCE(observed_at, created_at),
    confirmation_state = COALESCE(
      confirmation_state,
      CASE
        WHEN status IN ('observed', 'confirmed', 'finalized', 'reversed') THEN status
        ELSE 'observed'
      END
    ),
    confirmation_updated_at = COALESCE(confirmation_updated_at, created_at)
WHERE source_event_type IS NULL
   OR source_event_id IS NULL
   OR source_event_index IS NULL
   OR event_at IS NULL
   OR observed_at IS NULL
   OR confirmation_state IS NULL
   OR confirmation_updated_at IS NULL;

ALTER TABLE source_trades
  ALTER COLUMN source_event_type SET NOT NULL,
  ALTER COLUMN source_event_id SET NOT NULL,
  ALTER COLUMN source_event_index SET NOT NULL,
  ALTER COLUMN source_event_index SET DEFAULT '0',
  ALTER COLUMN event_at SET NOT NULL,
  ALTER COLUMN observed_at SET NOT NULL,
  ALTER COLUMN observed_at SET DEFAULT NOW(),
  ALTER COLUMN confirmation_state SET NOT NULL,
  ALTER COLUMN confirmation_state SET DEFAULT 'observed',
  ALTER COLUMN confirmation_updated_at SET NOT NULL,
  ALTER COLUMN confirmation_updated_at SET DEFAULT NOW();

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'source_trades'::regclass
      AND conname = 'source_trades_chain_transaction_hash_wallet_address_token_mint_direction_key'
  ) THEN
    ALTER TABLE source_trades
      DROP CONSTRAINT source_trades_chain_transaction_hash_wallet_address_token_mint_direction_key;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'source_trades'::regclass
      AND conname = 'source_trades_direction_check'
  ) THEN
    ALTER TABLE source_trades DROP CONSTRAINT source_trades_direction_check;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'source_trades'::regclass
      AND conname = 'chk_source_trades_direction'
  ) THEN
    ALTER TABLE source_trades
      ADD CONSTRAINT chk_source_trades_direction
      CHECK (direction IN ('buy', 'sell', 'transfer_in', 'transfer_out'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'source_trades'::regclass
      AND conname = 'chk_source_trades_chain'
  ) THEN
    ALTER TABLE source_trades
      ADD CONSTRAINT chk_source_trades_chain
      CHECK (chain IN ('solana', 'polygon', 'robinhood-chain'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'source_trades'::regclass
      AND conname = 'chk_source_trades_event_type'
  ) THEN
    ALTER TABLE source_trades
      ADD CONSTRAINT chk_source_trades_event_type
      CHECK (source_event_type IN ('transaction', 'order', 'venue_trade'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'source_trades'::regclass
      AND conname = 'chk_source_trades_confirmation'
  ) THEN
    ALTER TABLE source_trades
      ADD CONSTRAINT chk_source_trades_confirmation
      CHECK (confirmation_state IN ('observed', 'confirmed', 'finalized', 'reversed'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'source_trades'::regclass
      AND conname = 'chk_source_trades_quantities'
  ) THEN
    ALTER TABLE source_trades
      ADD CONSTRAINT chk_source_trades_quantities
      CHECK (
        token_amount > 0
        AND (amount_usd IS NULL OR amount_usd >= 0)
        AND (price_usd IS NULL OR price_usd >= 0)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'source_trades'::regclass
      AND conname = 'chk_source_trades_transaction_identity'
  ) THEN
    ALTER TABLE source_trades
      ADD CONSTRAINT chk_source_trades_transaction_identity
      CHECK (source_event_type <> 'transaction' OR transaction_hash IS NOT NULL);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS unq_source_trades_canonical_event
  ON source_trades (chain, source_event_type, source_event_id, source_event_index);

CREATE INDEX IF NOT EXISTS idx_source_trades_position_order
  ON source_trades (wallet_address, chain, token_mint, event_at, id)
  WHERE confirmation_state IN ('confirmed', 'finalized');

CREATE OR REPLACE FUNCTION reject_source_trade_payload_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.chain IS DISTINCT FROM OLD.chain
    OR NEW.source_event_type IS DISTINCT FROM OLD.source_event_type
    OR NEW.source_event_id IS DISTINCT FROM OLD.source_event_id
    OR NEW.source_event_index IS DISTINCT FROM OLD.source_event_index
    OR NEW.transaction_hash IS DISTINCT FROM OLD.transaction_hash
    OR NEW.wallet_address IS DISTINCT FROM OLD.wallet_address
    OR NEW.token_mint IS DISTINCT FROM OLD.token_mint
    OR NEW.direction IS DISTINCT FROM OLD.direction
    OR NEW.amount_usd IS DISTINCT FROM OLD.amount_usd
    OR NEW.token_amount IS DISTINCT FROM OLD.token_amount
    OR NEW.price_usd IS DISTINCT FROM OLD.price_usd
    OR NEW.event_at IS DISTINCT FROM OLD.event_at
    OR NEW.observed_at IS DISTINCT FROM OLD.observed_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'source trade payload is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_source_confirmation_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.confirmation_state = OLD.confirmation_state THEN
    RETURN NEW;
  END IF;

  IF NOT (
    (OLD.confirmation_state = 'observed' AND NEW.confirmation_state IN ('confirmed', 'finalized', 'reversed'))
    OR (OLD.confirmation_state = 'confirmed' AND NEW.confirmation_state IN ('finalized', 'reversed'))
    OR (OLD.confirmation_state = 'finalized' AND NEW.confirmation_state = 'reversed')
  ) THEN
    RAISE EXCEPTION 'invalid source confirmation transition: % -> %', OLD.confirmation_state, NEW.confirmation_state;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_source_trade_payload_immutable ON source_trades;
CREATE TRIGGER trg_source_trade_payload_immutable
  BEFORE UPDATE ON source_trades
  FOR EACH ROW EXECUTE FUNCTION reject_source_trade_payload_mutation();

DROP TRIGGER IF EXISTS trg_source_confirmation_transition ON source_trades;
CREATE TRIGGER trg_source_confirmation_transition
  BEFORE UPDATE OF confirmation_state ON source_trades
  FOR EACH ROW EXECUTE FUNCTION enforce_source_confirmation_transition();

CREATE TABLE IF NOT EXISTS source_trade_confirmation_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_trade_id UUID NOT NULL REFERENCES source_trades(id) ON DELETE RESTRICT,
  confirmation_state TEXT NOT NULL
    CHECK (confirmation_state IN ('observed', 'confirmed', 'finalized', 'reversed')),
  evidence_id VARCHAR(256) NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_trade_id, confirmation_state, evidence_id)
);

ALTER TABLE wallet_positions
  ADD COLUMN IF NOT EXISTS opening_balance NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS opening_cost_basis_usd NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_acquired_quantity NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_reduced_quantity NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS unmatched_reduction_quantity NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_event_at TIMESTAMPTZ;

UPDATE wallet_positions
SET opening_balance = balance,
    opening_cost_basis_usd = cost_basis_usd
WHERE opening_balance = 0
  AND opening_cost_basis_usd = 0
  AND (balance <> 0 OR cost_basis_usd <> 0)
  AND NOT EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'source_position_applications'
  );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'wallet_positions'::regclass
      AND conname = 'chk_wallet_positions_lifecycle_totals'
  ) THEN
    ALTER TABLE wallet_positions
      ADD CONSTRAINT chk_wallet_positions_lifecycle_totals
      CHECK (
        opening_balance >= 0
        AND opening_cost_basis_usd >= 0
        AND total_acquired_quantity >= 0
        AND total_reduced_quantity >= 0
        AND unmatched_reduction_quantity >= 0
        AND cost_basis_usd >= 0
      );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS source_position_applications (
  source_trade_id UUID PRIMARY KEY REFERENCES source_trades(id) ON DELETE RESTRICT,
  wallet_address VARCHAR(128) NOT NULL,
  chain VARCHAR(64) NOT NULL CHECK (chain IN ('solana', 'polygon', 'robinhood-chain')),
  token_mint VARCHAR(128) NOT NULL,
  active BOOLEAN NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (wallet_address, chain, token_mint)
    REFERENCES wallet_positions(wallet_address, chain, token_mint)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_source_position_applications_position
  ON source_position_applications (wallet_address, chain, token_mint)
  WHERE active;

CREATE TABLE IF NOT EXISTS copy_positions (
  target_account VARCHAR(128) NOT NULL,
  chain VARCHAR(64) NOT NULL CHECK (chain IN ('solana', 'polygon', 'robinhood-chain')),
  token_mint VARCHAR(128) NOT NULL,
  opening_quantity NUMERIC NOT NULL DEFAULT 0 CHECK (opening_quantity >= 0),
  opening_cost_basis_usd NUMERIC NOT NULL DEFAULT 0 CHECK (opening_cost_basis_usd >= 0),
  confirmed_quantity NUMERIC NOT NULL DEFAULT 0 CHECK (confirmed_quantity >= 0),
  reserved_sell_quantity NUMERIC NOT NULL DEFAULT 0 CHECK (reserved_sell_quantity >= 0),
  cost_basis_usd NUMERIC NOT NULL DEFAULT 0 CHECK (cost_basis_usd >= 0),
  total_acquired_quantity NUMERIC NOT NULL DEFAULT 0 CHECK (total_acquired_quantity >= 0),
  total_reduced_quantity NUMERIC NOT NULL DEFAULT 0 CHECK (total_reduced_quantity >= 0),
  unmatched_reduction_quantity NUMERIC NOT NULL DEFAULT 0 CHECK (unmatched_reduction_quantity >= 0),
  last_evidence_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (target_account, chain, token_mint)
);

CREATE TABLE IF NOT EXISTS copy_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_trade_id UUID NOT NULL REFERENCES source_trades(id) ON DELETE RESTRICT,
  chain VARCHAR(64) NOT NULL CHECK (chain IN ('solana', 'polygon', 'robinhood-chain')),
  target_account VARCHAR(128) NOT NULL,
  token_mint VARCHAR(128) NOT NULL,
  direction VARCHAR(16) NOT NULL CHECK (direction IN ('buy', 'sell')),
  execution_mode VARCHAR(16) NOT NULL CHECK (execution_mode IN ('paper', 'live', 'shadow')),
  client_order_id VARCHAR(128) NOT NULL,
  state VARCHAR(32) NOT NULL DEFAULT 'requested'
    CHECK (state IN (
      'requested', 'simulated', 'submitted', 'partially_filled', 'confirmed',
      'failed', 'cancelled', 'reconciliation_required'
    )),
  requested_base_quantity NUMERIC,
  requested_quote_quantity NUMERIC,
  confirmed_base_quantity NUMERIC NOT NULL DEFAULT 0 CHECK (confirmed_base_quantity >= 0),
  confirmed_quote_quantity NUMERIC NOT NULL DEFAULT 0 CHECK (confirmed_quote_quantity >= 0),
  reserved_base_quantity NUMERIC NOT NULL DEFAULT 0 CHECK (reserved_base_quantity >= 0),
  max_submission_attempts SMALLINT NOT NULL DEFAULT 3 CHECK (max_submission_attempts BETWEEN 1 AND 10),
  submission_attempts SMALLINT NOT NULL DEFAULT 0 CHECK (submission_attempts >= 0),
  simulation_id VARCHAR(256),
  simulated_at TIMESTAMPTZ,
  submission_type VARCHAR(32) CHECK (submission_type IN ('transaction', 'order')),
  submission_id VARCHAR(256),
  venue_order_id VARCHAR(256),
  transaction_hash VARCHAR(256),
  last_error TEXT,
  next_reconciliation_at TIMESTAMPTZ,
  reconciliation_claimed_at TIMESTAMPTZ,
  reconciliation_claim_id UUID,
  reconciliation_attempts SMALLINT NOT NULL DEFAULT 0 CHECK (reconciliation_attempts >= 0),
  max_reconciliation_attempts SMALLINT NOT NULL DEFAULT 10 CHECK (max_reconciliation_attempts BETWEEN 1 AND 100),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  submitted_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (requested_base_quantity IS NOT NULL AND requested_base_quantity > 0)
    OR (requested_quote_quantity IS NOT NULL AND requested_quote_quantity > 0)
  ),
  CHECK (requested_base_quantity IS NULL OR requested_base_quantity > 0),
  CHECK (requested_quote_quantity IS NULL OR requested_quote_quantity > 0),
  CHECK (submission_attempts <= max_submission_attempts),
  CHECK ((submission_type IS NULL) = (submission_id IS NULL)),
  UNIQUE (source_trade_id, target_account, execution_mode),
  UNIQUE (chain, target_account, client_order_id)
);

CREATE INDEX IF NOT EXISTS idx_copy_executions_reconciliation
  ON copy_executions (next_reconciliation_at, requested_at)
  WHERE state IN ('submitted', 'partially_filled', 'reconciliation_required');

CREATE TABLE IF NOT EXISTS copy_execution_state_history (
  id BIGSERIAL PRIMARY KEY,
  execution_id UUID NOT NULL REFERENCES copy_executions(id) ON DELETE RESTRICT,
  from_state VARCHAR(32),
  to_state VARCHAR(32) NOT NULL,
  reason TEXT,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION enforce_copy_execution_state_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.state = OLD.state THEN
    RETURN NEW;
  END IF;

  IF NOT (
    (OLD.state = 'requested' AND NEW.state IN ('simulated', 'failed', 'cancelled', 'reconciliation_required'))
    OR (OLD.state = 'simulated' AND NEW.state IN ('submitted', 'confirmed', 'failed', 'cancelled', 'reconciliation_required'))
    OR (OLD.state = 'submitted' AND NEW.state IN ('partially_filled', 'confirmed', 'failed', 'cancelled', 'reconciliation_required'))
    OR (OLD.state = 'partially_filled' AND NEW.state IN ('partially_filled', 'confirmed', 'cancelled', 'reconciliation_required'))
    OR (OLD.state = 'reconciliation_required' AND NEW.state IN ('submitted', 'partially_filled', 'confirmed', 'failed', 'cancelled', 'reconciliation_required'))
    OR (OLD.state = 'confirmed' AND NEW.state = 'reconciliation_required')
  ) THEN
    RAISE EXCEPTION 'invalid copy execution transition: % -> %', OLD.state, NEW.state;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_copy_execution_state_transition ON copy_executions;
CREATE TRIGGER trg_copy_execution_state_transition
  BEFORE UPDATE OF state ON copy_executions
  FOR EACH ROW EXECUTE FUNCTION enforce_copy_execution_state_transition();

CREATE TABLE IF NOT EXISTS copy_execution_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id UUID NOT NULL REFERENCES copy_executions(id) ON DELETE RESTRICT,
  evidence_type VARCHAR(32) NOT NULL
    CHECK (evidence_type IN ('chain_receipt', 'venue_fill', 'balance_reconciliation', 'paper_simulation')),
  evidence_id VARCHAR(256) NOT NULL,
  base_quantity NUMERIC NOT NULL CHECK (base_quantity > 0),
  quote_quantity NUMERIC CHECK (quote_quantity IS NULL OR quote_quantity >= 0),
  price_usd NUMERIC CHECK (price_usd IS NULL OR price_usd >= 0),
  confirmation_state TEXT NOT NULL DEFAULT 'observed'
    CHECK (confirmation_state IN ('observed', 'confirmed', 'finalized', 'reversed')),
  completes_execution BOOLEAN NOT NULL DEFAULT FALSE,
  occurred_at TIMESTAMPTZ NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmation_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (execution_id, evidence_type, evidence_id)
);

CREATE OR REPLACE FUNCTION reject_copy_evidence_payload_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.execution_id IS DISTINCT FROM OLD.execution_id
    OR NEW.evidence_type IS DISTINCT FROM OLD.evidence_type
    OR NEW.evidence_id IS DISTINCT FROM OLD.evidence_id
    OR NEW.base_quantity IS DISTINCT FROM OLD.base_quantity
    OR NEW.quote_quantity IS DISTINCT FROM OLD.quote_quantity
    OR NEW.price_usd IS DISTINCT FROM OLD.price_usd
    OR NEW.completes_execution IS DISTINCT FROM OLD.completes_execution
    OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at
    OR NEW.observed_at IS DISTINCT FROM OLD.observed_at
  THEN
    RAISE EXCEPTION 'copy execution evidence payload is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_copy_evidence_payload_immutable ON copy_execution_evidence;
CREATE TRIGGER trg_copy_evidence_payload_immutable
  BEFORE UPDATE ON copy_execution_evidence
  FOR EACH ROW EXECUTE FUNCTION reject_copy_evidence_payload_mutation();

DROP TRIGGER IF EXISTS trg_copy_evidence_confirmation_transition ON copy_execution_evidence;
CREATE TRIGGER trg_copy_evidence_confirmation_transition
  BEFORE UPDATE OF confirmation_state ON copy_execution_evidence
  FOR EACH ROW EXECUTE FUNCTION enforce_source_confirmation_transition();

CREATE TABLE IF NOT EXISTS copy_position_applications (
  evidence_id UUID PRIMARY KEY REFERENCES copy_execution_evidence(id) ON DELETE RESTRICT,
  execution_id UUID NOT NULL REFERENCES copy_executions(id) ON DELETE RESTRICT,
  target_account VARCHAR(128) NOT NULL,
  chain VARCHAR(64) NOT NULL CHECK (chain IN ('solana', 'polygon', 'robinhood-chain')),
  token_mint VARCHAR(128) NOT NULL,
  active BOOLEAN NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (target_account, chain, token_mint)
    REFERENCES copy_positions(target_account, chain, token_mint)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_copy_position_applications_position
  ON copy_position_applications (target_account, chain, token_mint)
  WHERE active;
