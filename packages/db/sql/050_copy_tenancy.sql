-- 050_copy_tenancy.sql
--
-- Tenancy key (`user_id`) on the three execution-ledger tables (checklist
-- S4-10): `trades`, `copy_executions`, `copy_positions`.
--
-- ── The bug this closes ────────────────────────────────────────────────────
--
-- `copy_positions` was keyed `PRIMARY KEY (target_account, chain, token_mint)`
-- (028_copy_execution_lifecycle.sql). In LIVE mode each user trades from a
-- distinct address, so that key separated users by accident. In PAPER mode
-- `resolvePaperCopyTargetAccount(chain)` returns ONE synthetic address per
-- chain with no user dimension, so every paper user on a chain shared a single
-- `copy_positions` row: user A's buy inflated user B's `confirmed_quantity`,
-- and B's exit computed P&L against A's cost basis. Paper is the default mode
-- for every free-tier user, so this was the common path, not an edge case.
--
-- The fix is the key, not the address. A shared synthetic paper target is
-- correct and honest once `user_id` is part of the uniqueness key: it reflects
-- that paper mode has no real counterparty. Minting a per-user fake address
-- would instead invent a counterparty that does not exist.
--
-- ── Expand-and-contract ───────────────────────────────────────────────────
--
-- Legacy operator rows keep `user_id NULL` by design. Nothing is backfilled
-- destructively in this release and no column becomes NOT NULL. NULL means
-- "the single pre-multi-tenant operator account".
--
-- ── Idempotency ───────────────────────────────────────────────────────────
--
-- `migrate.ts` has NO applied-migrations tracking table: it replays EVERY file
-- in `packages/db/sql/` on EVERY invocation, in filename order, one
-- transaction per file. So a bare `DROP CONSTRAINT` / `ADD PRIMARY KEY` pair
-- would succeed once and then break `pnpm db:migrate` for every developer and
-- for CI on the second run.
--
-- Every statement below is therefore replay-safe. Three idioms, all already
-- established in this directory:
--   * `ADD COLUMN IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` (043).
--   * `DROP INDEX IF EXISTS x; CREATE UNIQUE INDEX IF NOT EXISTS x ...` — 046
--     uses exactly this pair, because `CREATE ... IF NOT EXISTS` alone will
--     NOT change the definition of an index that already exists, so widening
--     an existing index requires dropping it first.
--   * `DO $$ ... IF EXISTS (SELECT 1 FROM pg_constraint ...) ... $$` (028, 030).
--
-- The constraint guards below match on `pg_constraint.conkey` shape rather
-- than on constraint NAME, for two reasons. First, PostgreSQL truncates
-- generated constraint names to 63 bytes, and
-- `copy_executions_source_trade_id_target_account_execution_mode_key` is 67 —
-- so its real name on disk is truncated and hardcoding it is a guess. Second,
-- the new primary key on `copy_positions` is *also* called
-- `copy_positions_pkey`, so a name-only `DROP CONSTRAINT IF EXISTS
-- copy_positions_pkey` would drop the NEW key on replay and then fail, because
-- `copy_position_applications` now references it. Matching on column count
-- distinguishes the old 3-column key from the new 1-column one.
--
-- ── ON DELETE RESTRICT, not CASCADE ───────────────────────────────────────
--
-- 041/044/045 use CASCADE because auth wallets, subscriptions and watches are
-- *preferences*: deleting the user should delete them. These three tables are
-- not preferences, they are financial history:
--
--   * `trades` is the P&L and tax record. It has to outlive the account it
--     describes; a `DELETE FROM users` must not silently destroy it.
--   * `copy_executions` and `copy_positions` are the ledger that `trades` is
--     derived from, and the whole copy lifecycle already uses ON DELETE
--     RESTRICT internally (028, 030) so that evidence can never be orphaned.
--     CASCADE here would be inconsistent with that graph and would delete the
--     evidence chain behind a retained trade.
--
-- This follows 047_user_execution_grants.sql, which made the same call for the
-- same reason ("a cascade destroys both from one DELETE FROM users"). A user
-- with financial rows is soft-deleted; hard deletion is a separate,
-- deliberate operation that has to deal with these rows explicitly.


-- ═══════════════════════════════════════════════════════════════════════════
-- 1. copy_positions: surrogate key + tenancy dimension
-- ═══════════════════════════════════════════════════════════════════════════

-- A surrogate key is needed because the natural key is about to gain a
-- NULLable column, and a NULLable column cannot participate in a primary key.
-- `pgcrypto` is enabled in 001_init.sql:1, so gen_random_uuid() is available.
--
-- The default is volatile, so PostgreSQL rewrites the table and evaluates it
-- per row: every pre-existing position gets its own id rather than all sharing
-- one. (The PG11+ "fast default" optimisation deliberately does not apply to
-- volatile defaults.)
ALTER TABLE copy_positions
  ADD COLUMN IF NOT EXISTS id UUID NOT NULL DEFAULT gen_random_uuid();

-- `copy_position_applications` carries a composite foreign key onto the exact
-- three columns of the primary key we are about to drop (028, lines 431-433).
-- PostgreSQL will refuse `DROP CONSTRAINT copy_positions_pkey` while that FK
-- depends on it ("cannot drop constraint ... because other objects depend on
-- it"), so it has to go first. Dropped explicitly by lookup rather than with
-- CASCADE, so this cannot take out an object we did not know about.
--
-- `cardinality(confkey) = 3` targets the OLD composite FK specifically and
-- never the new single-column one added at the end of this section, which is
-- what makes the replay idempotent instead of a drop/recreate churn.
DO $$
DECLARE
  legacy_fk RECORD;
BEGIN
  FOR legacy_fk IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'copy_position_applications'::regclass
       AND contype = 'f'
       AND confrelid = 'copy_positions'::regclass
       AND cardinality(confkey) = 3
  LOOP
    EXECUTE format(
      'ALTER TABLE copy_position_applications DROP CONSTRAINT %I',
      legacy_fk.conname
    );
  END LOOP;
END $$;

-- Drop the old three-column primary key, and ONLY the old one. See the
-- name-vs-shape note in the header: the replacement key below reuses the name
-- `copy_positions_pkey`, so the guard has to be on column count.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'copy_positions'::regclass
       AND contype = 'p'
       AND cardinality(conkey) = 3
  ) THEN
    ALTER TABLE copy_positions DROP CONSTRAINT copy_positions_pkey;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'copy_positions'::regclass
       AND contype = 'p'
  ) THEN
    ALTER TABLE copy_positions
      ADD CONSTRAINT copy_positions_pkey PRIMARY KEY (id);
  END IF;
END $$;

ALTER TABLE copy_positions
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE RESTRICT;

-- The tenancy-aware replacement for the dropped natural key.
--
-- NULLS NOT DISTINCT is load-bearing, not decoration — the same reasoning as
-- 046_polymarket_redemptions.sql. Under the default NULLS DISTINCT, two rows
-- that agree on (target_account, chain, token_mint) but both have
-- `user_id NULL` would NOT collide. Since every legacy operator row has
-- `user_id NULL`, this migration would then *remove* the uniqueness that
-- exists today while appearing to add a dimension: `ensureCopyPosition` would
-- insert a fresh duplicate operator position on every single call, and the
-- position ledger would fragment silently.
--
-- Requires PostgreSQL 15+. CI and production both run 16.
DROP INDEX IF EXISTS uq_copy_positions_account_chain_token_user;
CREATE UNIQUE INDEX IF NOT EXISTS uq_copy_positions_account_chain_token_user
  ON copy_positions (target_account, chain, token_mint, user_id) NULLS NOT DISTINCT;

CREATE INDEX IF NOT EXISTS idx_copy_positions_user
  ON copy_positions (user_id, chain, token_mint);

COMMENT ON COLUMN copy_positions.user_id IS
  'Owning tenant. NULL means the pre-multi-tenant operator account. Part of '
  'the uniqueness key so that paper users sharing one synthetic target_account '
  'still hold independent quantities and cost bases (S4-10).';


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. copy_position_applications: follow copy_positions
-- ═══════════════════════════════════════════════════════════════════════════
--
-- NOT in the S4-10 brief, but the fix does not work without it. This table is
-- what `rebuildCopyPosition` aggregates a position from
-- (packages/db/src/copy-trade-lifecycle.ts), and it filters
-- `WHERE application.target_account = $1 AND chain = $2 AND token_mint = $3`.
-- With a shared paper target and no user dimension here, BOTH users' evidence
-- rows land in EACH user's ledger — so splitting `copy_positions` alone would
-- produce two rows holding identical, doubled quantities. Threading the
-- tenancy key onto the applications rows is what makes the split real.
--
-- Mirroring the tenancy column here matches how this table already works: it
-- redundantly carries target_account/chain/token_mint rather than joining for
-- them.
ALTER TABLE copy_position_applications
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE RESTRICT;

-- Restores the referential integrity that dropping the composite FK above
-- gave up. It points at the surrogate `copy_positions.id` rather than at the
-- new four-column unique index, deliberately:
--
--   * a composite FK onto (target_account, chain, token_mint, user_id) would
--     be MATCH SIMPLE, which treats a row with ANY null referencing column as
--     automatically satisfying the constraint — so every legacy `user_id NULL`
--     row (i.e. all of them today) would lose FK enforcement entirely; and
--   * whether PostgreSQL accepts a NULLS NOT DISTINCT index as a foreign-key
--     target at all is not something this migration should be betting on.
--
-- A single-column FK onto a plain primary key has neither problem.
--
-- Left NULLable for the expand phase: tightening it to NOT NULL now would
-- break any old executor process still writing application rows without it.
-- The contract phase does that once all writers are on this version.
ALTER TABLE copy_position_applications
  ADD COLUMN IF NOT EXISTS position_id UUID;

-- Backfill: only fills NULLs, so replaying it is a no-op.
--
-- `position.user_id IS NOT DISTINCT FROM application.user_id` makes the join key
-- exactly mirror `uq_copy_positions_account_chain_token_user`, which is what
-- keeps this correct on replay. Without it the join is
-- (target_account, chain, token_mint) only, which is unambiguous *today* —
-- every position still has user_id NULL — but stops being so the moment real
-- tenants exist: several positions would then match, and `UPDATE ... FROM`
-- picks one of them nondeterministically, silently attaching one tenant's
-- evidence row to another tenant's position. That is reachable rather than
-- theoretical, because the expand phase deliberately tolerates an old executor
-- still writing application rows without `position_id` (see the note above).
--
-- `IS NOT DISTINCT FROM` treats NULL as a value, so a legacy application row
-- matches the legacy position and a tenant's row matches that tenant's
-- position. Since the unique index guarantees at most one position per
-- (target_account, chain, token_mint, user_id) with NULLS NOT DISTINCT, there
-- can never be more than one match.
UPDATE copy_position_applications application
   SET position_id = position.id
  FROM copy_positions position
 WHERE application.position_id IS NULL
   AND position.target_account = application.target_account
   AND position.chain = application.chain
   AND position.token_mint = application.token_mint
   AND position.user_id IS NOT DISTINCT FROM application.user_id;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'copy_position_applications'::regclass
       AND conname = 'fk_copy_position_applications_position'
  ) THEN
    ALTER TABLE copy_position_applications
      ADD CONSTRAINT fk_copy_position_applications_position
      FOREIGN KEY (position_id)
      REFERENCES copy_positions (id)
      ON DELETE RESTRICT;
  END IF;
END $$;

-- Complements 028's `idx_copy_position_applications_position` (left in place),
-- which is the index the rebuild's `ordered_events` CTE scans. Without user_id
-- that index no longer covers the predicate.
CREATE INDEX IF NOT EXISTS idx_copy_position_applications_position_user
  ON copy_position_applications (target_account, chain, token_mint, user_id)
  WHERE active;


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. copy_executions: tenancy on the identity keys
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ADR-0001 already flagged a tenancy collision here. Verified against the
-- schema as it stands: `user_id` was NOT present, and three of the identity
-- keys collide between two paper users sharing a synthetic target_account.
ALTER TABLE copy_executions
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE RESTRICT;

-- 028 declared `UNIQUE (source_trade_id, target_account, execution_mode)` as a
-- table constraint. Two paper users copying the same source trade in the same
-- mode agree on all three columns, so the second user's execution could never
-- be inserted — one user's claim silently blocked everyone else's.
--
-- Matched on column set rather than name: the generated name is 67 bytes and
-- so is truncated on disk (see header).
DO $$
DECLARE
  legacy_unique RECORD;
BEGIN
  FOR legacy_unique IN
    SELECT con.conname
      FROM pg_constraint con
     WHERE con.conrelid = 'copy_executions'::regclass
       AND con.contype = 'u'
       -- `attname` is of type `name`, and there is no `name[] = text[]`
       -- operator, so the cast to text is required rather than cosmetic.
       AND (
         SELECT array_agg(att.attname::text ORDER BY att.attname::text)
           FROM unnest(con.conkey) AS conkey_entry(attnum)
           JOIN pg_attribute att
             ON att.attrelid = con.conrelid
            AND att.attnum = conkey_entry.attnum
       ) = ARRAY['execution_mode', 'source_trade_id', 'target_account']
  LOOP
    EXECUTE format(
      'ALTER TABLE copy_executions DROP CONSTRAINT %I',
      legacy_unique.conname
    );
  END LOOP;
END $$;

-- NULLS NOT DISTINCT for the same reason as above: without it the legacy
-- operator rows (user_id NULL) stop colliding with each other, which would
-- turn this from "one execution per source trade per target per mode per
-- tenant" into no guard at all for the operator — the exact duplicate-copy
-- defect 023's `unq_trades_source_trade_mode` was added to prevent.
DROP INDEX IF EXISTS uq_copy_executions_source_target_mode_user;
CREATE UNIQUE INDEX IF NOT EXISTS uq_copy_executions_source_target_mode_user
  ON copy_executions (source_trade_id, target_account, execution_mode, user_id)
  NULLS NOT DISTINCT;

-- Same collision on the signal-scoped key from 030.
DROP INDEX IF EXISTS unq_copy_executions_signal_target_mode;
CREATE UNIQUE INDEX IF NOT EXISTS unq_copy_executions_signal_target_mode
  ON copy_executions (signal_id, target_account, execution_mode, user_id)
  NULLS NOT DISTINCT
  WHERE signal_id IS NOT NULL;

-- Deliberately NOT widened:
--
--   * `UNIQUE (chain, target_account, client_order_id)` — a client order id is
--     a hash that now includes the acting user (see
--     `buildCopyExecutionClientOrderId`), so it is already per-tenant
--     distinct. Adding user_id would be redundant, and would additionally
--     stop the index from catching a genuine cross-tenant id collision.
--   * `unq_copy_executions_submission_identity` (chain, submission_type,
--     submission_id) — a venue- or chain-assigned identity is globally unique
--     by construction. Adding a tenancy column would WEAKEN it: two tenants
--     claiming the same on-chain submission is precisely the corruption this
--     index exists to reject.
--   * `unq_copy_executions_id_signal_source` — a composite FK target, not a
--     tenancy guard.

CREATE INDEX IF NOT EXISTS idx_copy_executions_user
  ON copy_executions (user_id, requested_at DESC);

COMMENT ON COLUMN copy_executions.user_id IS
  'Owning tenant. NULL means the pre-multi-tenant operator account (S4-10).';


-- ═══════════════════════════════════════════════════════════════════════════
-- 4. trades: tenancy on the reporting/idempotency key
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE RESTRICT;

-- 023 added `unq_trades_source_trade_mode (source_trade_id, execution_mode)`
-- to stop duplicate executor runs copying one source trade twice. With more
-- than one tenant that guard is too strong: the SECOND tenant's legitimate
-- paper copy of the same source trade is indistinguishable from a duplicate
-- run and is rejected. Widening by user_id keeps the anti-duplicate guarantee
-- per tenant while letting distinct tenants each hold their own copy.
DROP INDEX IF EXISTS unq_trades_source_trade_mode;
CREATE UNIQUE INDEX IF NOT EXISTS unq_trades_source_trade_mode
  ON trades (source_trade_id, execution_mode, user_id)
  NULLS NOT DISTINCT
  WHERE source_trade_id IS NOT NULL;

-- Deliberately NOT widened:
--
--   * `unq_trades_copy_execution (copy_execution_id)` — already 1:1 with a
--     `copy_executions` row, which is itself now tenant-scoped. The tenancy
--     comes through the reference; adding user_id would let two trades share
--     one execution.
--   * `idx_trades_live_venue_order_id (executor, venue_order_id)` — a venue
--     order id is globally unique per executor. Adding a tenancy column would
--     WEAKEN it, letting two tenants both claim one real venue order.

CREATE INDEX IF NOT EXISTS idx_trades_user
  ON trades (user_id, executed_at DESC);

COMMENT ON COLUMN trades.user_id IS
  'Owning tenant. NULL means the pre-multi-tenant operator account. '
  'ON DELETE RESTRICT: a trade is financial history and must outlive the '
  'account it belongs to (S4-10).';
