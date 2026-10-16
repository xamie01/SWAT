-- 058_master_attributed_inventory.sql
--
-- S4-M3 / ADR-0007: keep the physical venue position aggregate, and add a
-- source-master accounting lot beside it.  A source trade is the authority for
-- attribution; the current subscription row is deliberately not consulted.
--
-- The migration is expand-and-backfill in one replay-safe file.  Existing
-- application rows already point at a canonical source trade, so their master
-- can be recovered without guessing from current subscriptions.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Master-attributed lot ledger
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS copy_position_lots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_account VARCHAR(128) NOT NULL,
  user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  master_wallet_address VARCHAR(128) NOT NULL,
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
  cost_basis_unvalued_fill_count INTEGER NOT NULL DEFAULT 0 CHECK (cost_basis_unvalued_fill_count >= 0),
  last_evidence_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE copy_position_lots
  ADD COLUMN IF NOT EXISTS cost_basis_unvalued_fill_count INTEGER NOT NULL DEFAULT 0;

-- PostgreSQL 15+ is required by the existing tenancy indexes.  NULLS NOT
-- DISTINCT keeps the pre-multi-tenant operator's NULL user in one lot key.
DROP INDEX IF EXISTS uq_copy_position_lots_identity;
CREATE UNIQUE INDEX IF NOT EXISTS uq_copy_position_lots_identity
  ON copy_position_lots (
    target_account, user_id, master_wallet_address, chain, token_mint
  ) NULLS NOT DISTINCT;

CREATE INDEX IF NOT EXISTS idx_copy_position_lots_user_open
  ON copy_position_lots (user_id, chain, token_mint)
  WHERE confirmed_quantity > 0;

CREATE INDEX IF NOT EXISTS idx_copy_position_lots_master
  ON copy_position_lots (master_wallet_address, chain, token_mint, user_id);

COMMENT ON TABLE copy_position_lots IS
  'Master-attributed accounting lots over the aggregate copy_positions venue balance (S4-M3).';
COMMENT ON COLUMN copy_position_lots.master_wallet_address IS
  'Chain-prefixed source wallet from source_trades; never resolved from the current subscription.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Evidence applications carry the immutable lot identity
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE copy_position_applications
  ADD COLUMN IF NOT EXISTS master_wallet_address VARCHAR(128);

ALTER TABLE copy_position_applications
  ADD COLUMN IF NOT EXISTS lot_id UUID;

-- Repair the tenancy dimension for any application written by the short
-- expand-phase between 050 and the current writer.  The execution is the
-- authority for user_id; the source trade is the authority for master.
UPDATE copy_position_applications application
   SET user_id = execution.user_id,
       master_wallet_address = source.wallet_address
  FROM copy_executions execution
  JOIN source_trades source ON source.id = execution.source_trade_id
 WHERE execution.id = application.execution_id
   AND (
     application.user_id IS NULL AND execution.user_id IS NOT NULL
     OR application.master_wallet_address IS NULL
   );

-- A corrected tenant application needs a tenant-owned aggregate position
-- before its position_id can be repaired.  Legacy operator rows remain NULL.
INSERT INTO copy_positions (target_account, chain, token_mint, user_id)
SELECT DISTINCT application.target_account,
                application.chain,
                application.token_mint,
                application.user_id
  FROM copy_position_applications application
 WHERE application.user_id IS NOT NULL
ON CONFLICT (target_account, chain, token_mint, user_id) DO NOTHING;

UPDATE copy_position_applications application
   SET position_id = position.id
  FROM copy_positions position
 WHERE application.position_id IS DISTINCT FROM position.id
   AND position.target_account = application.target_account
   AND position.chain = application.chain
   AND position.token_mint = application.token_mint
   AND position.user_id IS NOT DISTINCT FROM application.user_id;

-- Every application must have a canonical source trade, so this backfill is
-- deterministic.  A NULL here means the database is inconsistent and the
-- migration must fail rather than create an unattributed financial row.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM copy_position_applications
     WHERE master_wallet_address IS NULL
  ) THEN
    RAISE EXCEPTION '058: copy_position_applications contains an unattributed row';
  END IF;
END $$;

ALTER TABLE copy_position_applications
  ALTER COLUMN master_wallet_address SET NOT NULL;

-- Build one lot per existing (tenant, source master, chain, token) identity.
-- ON CONFLICT without a target is intentional: the identity is represented by
-- a NULLS NOT DISTINCT index, which must remain the sole uniqueness authority.
INSERT INTO copy_position_lots (
  target_account, user_id, master_wallet_address, chain, token_mint
)
SELECT DISTINCT
       application.target_account,
       application.user_id,
       application.master_wallet_address,
       application.chain,
       application.token_mint
  FROM copy_position_applications application
 WHERE application.master_wallet_address IS NOT NULL
ON CONFLICT DO NOTHING;

UPDATE copy_position_applications application
   SET lot_id = lot.id
  FROM copy_position_lots lot
 WHERE application.lot_id IS DISTINCT FROM lot.id
   AND lot.target_account = application.target_account
   AND lot.user_id IS NOT DISTINCT FROM application.user_id
   AND lot.master_wallet_address = application.master_wallet_address
   AND lot.chain = application.chain
   AND lot.token_mint = application.token_mint;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM copy_position_applications
     WHERE lot_id IS NULL
  ) THEN
    RAISE EXCEPTION '058: copy_position_applications contains a row without a master lot';
  END IF;
END $$;

ALTER TABLE copy_position_applications
  ALTER COLUMN lot_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'copy_position_applications'::regclass
       AND conname = 'fk_copy_position_applications_lot'
  ) THEN
    ALTER TABLE copy_position_applications
      ADD CONSTRAINT fk_copy_position_applications_lot
      FOREIGN KEY (lot_id) REFERENCES copy_position_lots(id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_copy_position_applications_lot
  ON copy_position_applications (lot_id)
  WHERE active;

CREATE INDEX IF NOT EXISTS idx_copy_position_applications_master
  ON copy_position_applications (
    target_account, user_id, master_wallet_address, chain, token_mint
  )
  WHERE active;

COMMENT ON COLUMN copy_position_applications.master_wallet_address IS
  'Immutable source master copied from source_trades.wallet_address (S4-M3).';
COMMENT ON COLUMN copy_position_applications.lot_id IS
  'Master-attributed lot updated together with the aggregate copy position (S4-M3).';
