-- 054_copy_evidence_quote_units.sql
--
-- Give `copy_execution_evidence.quote_quantity` a unit (checklist S4-M35).
--
-- ── The bug ───────────────────────────────────────────────────────────────
--
-- `quote_quantity` was a mixed-unit column. Each executor path wrote whatever
-- its venue settled in, and nothing recorded which that was:
--
--   * Polymarket live wrote `spendAmountUsd`              -- USD
--   * paper simulation wrote `simAmountUsd`               -- USD
--   * Solana live wrote `nativeLamportsDelta / 1e9`       -- SOL
--   * robinhood-chain live wrote `result.amountEth`       -- ETH
--
-- `rebuildCopyPosition` then folded that column into `copy_positions.cost_basis_usd`
-- with `COALESCE(quote_quantity, base_quantity * price_usd, 0)` -- PREFERRING
-- `quote_quantity`, so on the two live paths the USD fallback never fired and a
-- column named `_usd` accumulated SOL and ETH.
--
-- ── What this migration does ──────────────────────────────────────────────
--
-- Decided 2026-08-23: record BOTH, not either/or.
--
--   1. `quote_quantity` becomes USD, always, for every row written from here on.
--      The conversion happens at write time through the one conversion rule in
--      `packages/db/src/quote-valuation.ts`, which `persistTrade` now shares.
--   2. `quote_native_quantity` + `quote_currency` + `quote_native_usd_price`
--      preserve what was actually settled and the rate used, because a USD
--      figure alone cannot be re-derived if the rate was wrong, cannot be
--      audited, and cannot answer "how much SOL did this position cost".
--
-- ── The historical rows ───────────────────────────────────────────────────
--
-- The unit of an existing row is NOT recoverable from `chain` alone -- the
-- Solana paper path settles in USD while the Solana live path settles in SOL.
-- It IS recoverable from (`evidence_type`, `chain`), because that pair is what
-- identifies the executor path:
--
--   * `venue_fill`        -> Polymarket only             -> USD
--   * `paper_simulation`  -> `simAmountUsd`              -> USD
--   * `chain_receipt`     -> solana live                 -> SOL
--   * `chain_receipt`     -> robinhood-chain live        -> ETH
--   * `chain_receipt`     -> polygon                     -> USD (no writer exists;
--                            polygon settles in USDC, so if such a row is ever
--                            found its amount is USD)
--
-- (`balance_reconciliation` has no writer in the codebase, so no such row can
-- exist; any that somehow does is left with a NULL currency, i.e. unknown.)
--
-- So the backfill below moves each legacy amount into `quote_native_quantity`,
-- stamps its currency, and -- for the SOL and ETH rows only -- NULLs
-- `quote_quantity`, because that value never was USD and no historical rate is
-- available to convert it. NULL here means *unknown*, which is the honest
-- reading: `rebuildCopyPosition` then falls back to `base_quantity * price_usd`,
-- which is USD by construction, exactly as it should have done all along.
--
-- Nothing invents a price. A row whose USD value is unknown stays unknown.
--
-- `copy_positions.cost_basis_usd` rows written before this migration keep their
-- wrong value until the position's next fill: `rebuildCopyPosition` is a full
-- recompute over the whole evidence ledger, so the first rebuild after this
-- migration repairs the basis from the repaired evidence. No separate position
-- backfill is needed and none is attempted here.
--
-- ── Idempotency ──────────────────────────────────────────────────────────
--
-- `migrate.ts` re-runs every file on every invocation. Every statement here is
-- `IF NOT EXISTS`/additive, the backfill is guarded on `quote_currency IS NULL`
-- so a replay is a no-op, and the CHECK constraints are guarded on
-- `pg_constraint.conkey` SHAPE rather than on a name (Postgres truncates
-- identifiers at 63 bytes, so a name guard can silently fail to match).

-- ── 1. Evidence: the native record ───────────────────────────────────────

ALTER TABLE copy_execution_evidence
  ADD COLUMN IF NOT EXISTS quote_native_quantity NUMERIC,
  ADD COLUMN IF NOT EXISTS quote_currency VARCHAR(8),
  ADD COLUMN IF NOT EXISTS quote_native_usd_price NUMERIC;

COMMENT ON COLUMN copy_execution_evidence.quote_quantity IS
  'USD value of the quote leg. Always USD, never a native token amount (S4-M35). '
  'NULL means the USD value is unknown -- never zero standing in for unknown.';
COMMENT ON COLUMN copy_execution_evidence.quote_native_quantity IS
  'Amount the venue actually settled, in quote_currency. The observed figure; '
  'quote_quantity is derived from it.';
COMMENT ON COLUMN copy_execution_evidence.quote_currency IS
  'Unit of quote_native_quantity: USD, SOL or ETH. NULL only on a row with no '
  'quote leg at all, or a pre-S4-M35 row whose executor path is unidentifiable.';
COMMENT ON COLUMN copy_execution_evidence.quote_native_usd_price IS
  'USD per unit of quote_currency used for the conversion, so quote_quantity is '
  're-derivable and auditable. 1 for USD.';

-- ── 2. Backfill the historical rows ──────────────────────────────────────
--
-- The payload-immutability trigger (028) raises on any UPDATE that changes
-- quote_quantity, so it comes off for the duration of the backfill and goes back
-- on below, re-created to cover the three new columns as well.

DROP TRIGGER IF EXISTS trg_copy_evidence_payload_immutable ON copy_execution_evidence;

UPDATE copy_execution_evidence evidence
   SET quote_native_quantity = evidence.quote_quantity,
       quote_currency = resolved.currency,
       quote_native_usd_price = CASE WHEN resolved.currency = 'USD' THEN 1 ELSE NULL END,
       quote_quantity = CASE WHEN resolved.currency = 'USD' THEN evidence.quote_quantity ELSE NULL END
  FROM (
    SELECT
      inner_evidence.id,
      CASE
        WHEN inner_evidence.evidence_type IN ('venue_fill', 'paper_simulation') THEN 'USD'
        WHEN inner_evidence.evidence_type = 'chain_receipt' AND execution.chain = 'solana' THEN 'SOL'
        WHEN inner_evidence.evidence_type = 'chain_receipt' AND execution.chain = 'robinhood-chain' THEN 'ETH'
        WHEN inner_evidence.evidence_type = 'chain_receipt' AND execution.chain = 'polygon' THEN 'USD'
        ELSE NULL
      END AS currency
    FROM copy_execution_evidence inner_evidence
    JOIN copy_executions execution ON execution.id = inner_evidence.execution_id
  ) resolved
 WHERE resolved.id = evidence.id
   AND resolved.currency IS NOT NULL
   AND evidence.quote_currency IS NULL
   AND evidence.quote_quantity IS NOT NULL;

-- ── 3. Evidence: constraints and the widened immutable payload ───────────
--
-- Pairing rule: an amount without its unit is the bug this migration exists to
-- fix, so it is made unrepresentable. A unit without an amount is equally
-- incoherent. Both or neither.
DO $$
DECLARE
  pairing_shape smallint[];
BEGIN
  SELECT array_agg(attnum ORDER BY attnum)
    INTO pairing_shape
    FROM pg_attribute
   WHERE attrelid = 'copy_execution_evidence'::regclass
     AND attname IN ('quote_native_quantity', 'quote_currency');

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'copy_execution_evidence'::regclass
       AND contype = 'c'
       AND conkey @> pairing_shape
       AND conkey <@ pairing_shape
  ) THEN
    ALTER TABLE copy_execution_evidence
      ADD CONSTRAINT chk_copy_evidence_quote_unit_paired
      CHECK ((quote_native_quantity IS NULL) = (quote_currency IS NULL));
  END IF;
END $$;

DO $$
DECLARE
  currency_shape smallint[];
BEGIN
  SELECT array_agg(attnum)
    INTO currency_shape
    FROM pg_attribute
   WHERE attrelid = 'copy_execution_evidence'::regclass
     AND attname = 'quote_currency';

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'copy_execution_evidence'::regclass
       AND contype = 'c'
       AND conkey @> currency_shape
       AND conkey <@ currency_shape
  ) THEN
    ALTER TABLE copy_execution_evidence
      ADD CONSTRAINT chk_copy_evidence_quote_currency
      CHECK (quote_currency IS NULL OR quote_currency IN ('USD', 'SOL', 'ETH'));
  END IF;
END $$;

DO $$
DECLARE
  native_shape smallint[];
BEGIN
  SELECT array_agg(attnum)
    INTO native_shape
    FROM pg_attribute
   WHERE attrelid = 'copy_execution_evidence'::regclass
     AND attname = 'quote_native_quantity';

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'copy_execution_evidence'::regclass
       AND contype = 'c'
       AND conkey @> native_shape
       AND conkey <@ native_shape
  ) THEN
    ALTER TABLE copy_execution_evidence
      ADD CONSTRAINT chk_copy_evidence_quote_native_nonneg
      CHECK (quote_native_quantity IS NULL OR quote_native_quantity >= 0);
  END IF;
END $$;

DO $$
DECLARE
  rate_shape smallint[];
BEGIN
  SELECT array_agg(attnum)
    INTO rate_shape
    FROM pg_attribute
   WHERE attrelid = 'copy_execution_evidence'::regclass
     AND attname = 'quote_native_usd_price';

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'copy_execution_evidence'::regclass
       AND contype = 'c'
       AND conkey @> rate_shape
       AND conkey <@ rate_shape
  ) THEN
    ALTER TABLE copy_execution_evidence
      ADD CONSTRAINT chk_copy_evidence_quote_rate_nonneg
      CHECK (quote_native_usd_price IS NULL OR quote_native_usd_price >= 0);
  END IF;
END $$;

-- The immutable payload now includes the unit. Recording an amount and later
-- relabelling its currency would rewrite history exactly as silently as the
-- original bug did.
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
    OR NEW.quote_native_quantity IS DISTINCT FROM OLD.quote_native_quantity
    OR NEW.quote_currency IS DISTINCT FROM OLD.quote_currency
    OR NEW.quote_native_usd_price IS DISTINCT FROM OLD.quote_native_usd_price
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

CREATE TRIGGER trg_copy_evidence_payload_immutable
  BEFORE UPDATE ON copy_execution_evidence
  FOR EACH ROW EXECUTE FUNCTION reject_copy_evidence_payload_mutation();

-- ── 4. Executions: unknown must not read as zero ─────────────────────────
--
-- `COALESCE(SUM(quote_quantity), 0)` reported the same complete-looking number
-- whether every fill was valued, some were, or none were, because SUM skips
-- NULLs. Two changes make the three cases distinguishable:
--
--   * `confirmed_quote_quantity` becomes nullable, and is NULL when at least one
--     confirmed fill exists and none of them carries a USD value. Zero now means
--     zero.
--   * `quote_unassessed_fill_count` says how many confirmed fills the sum omits,
--     so a partial total can be read as the lower bound it is.

ALTER TABLE copy_executions
  ALTER COLUMN confirmed_quote_quantity DROP NOT NULL;

ALTER TABLE copy_executions
  ADD COLUMN IF NOT EXISTS quote_unassessed_fill_count INTEGER NOT NULL DEFAULT 0;

DO $$
DECLARE
  unassessed_shape smallint[];
BEGIN
  SELECT array_agg(attnum)
    INTO unassessed_shape
    FROM pg_attribute
   WHERE attrelid = 'copy_executions'::regclass
     AND attname = 'quote_unassessed_fill_count';

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'copy_executions'::regclass
       AND contype = 'c'
       AND conkey @> unassessed_shape
       AND conkey <@ unassessed_shape
  ) THEN
    ALTER TABLE copy_executions
      ADD CONSTRAINT chk_copy_executions_quote_unassessed_nonneg
      CHECK (quote_unassessed_fill_count >= 0);
  END IF;
END $$;

COMMENT ON COLUMN copy_executions.confirmed_quote_quantity IS
  'USD sum over confirmed fills that have a known USD value. NULL means no '
  'confirmed fill has one -- distinct from 0, which means no fills or a genuine '
  'zero. Read together with quote_unassessed_fill_count.';
COMMENT ON COLUMN copy_executions.quote_unassessed_fill_count IS
  'Confirmed fills omitted from confirmed_quote_quantity because their USD value '
  'is unknown. Non-zero means that sum is a lower bound, not a settled total.';

-- ── 5. Positions: the same honesty for cost basis ─────────────────────────

ALTER TABLE copy_positions
  ADD COLUMN IF NOT EXISTS cost_basis_unvalued_fill_count INTEGER NOT NULL DEFAULT 0;

DO $$
DECLARE
  basis_shape smallint[];
BEGIN
  SELECT array_agg(attnum)
    INTO basis_shape
    FROM pg_attribute
   WHERE attrelid = 'copy_positions'::regclass
     AND attname = 'cost_basis_unvalued_fill_count';

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'copy_positions'::regclass
       AND contype = 'c'
       AND conkey @> basis_shape
       AND conkey <@ basis_shape
  ) THEN
    ALTER TABLE copy_positions
      ADD CONSTRAINT chk_copy_positions_unvalued_fill_nonneg
      CHECK (cost_basis_unvalued_fill_count >= 0);
  END IF;
END $$;

COMMENT ON COLUMN copy_positions.cost_basis_usd IS
  'USD cost basis rebuilt from the evidence ledger. Only fills with a known USD '
  'value contribute; see cost_basis_unvalued_fill_count before treating this as '
  'the whole basis.';
COMMENT ON COLUMN copy_positions.cost_basis_unvalued_fill_count IS
  'Applied buy fills that contributed nothing to cost_basis_usd because neither a '
  'USD quote value nor a USD price was recorded. Non-zero means the basis is a '
  'lower bound.';

-- Native cost basis is deliberately NOT summarised onto copy_positions: one
-- position can mix a USD paper fill with a SOL live fill, so a single native
-- total would itself be a mixed-unit column -- the exact defect this migration
-- removes. The per-fill native record on copy_execution_evidence is the
-- auditable answer to "how much SOL did this cost", and this index makes that
-- question cheap to ask.
CREATE INDEX IF NOT EXISTS idx_copy_evidence_quote_currency
  ON copy_execution_evidence (execution_id, quote_currency)
  WHERE quote_currency IS NOT NULL;
