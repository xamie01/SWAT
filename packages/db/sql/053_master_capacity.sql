-- 053_master_capacity.sql
--
-- Per-master capacity accounting, denominated in price impact
-- (checklist S4-M6, ADR-0005 §4.1-4.4).
--
-- ── What this encodes ─────────────────────────────────────────────────────
--
-- Our own cohort is the adverse selection. One master's trade fans out to
-- hundreds of followers as a single directional order on the same pair within
-- minutes: user #900 buys at a price users #1-899 created. A master who notices
-- can farm it deliberately — buy small, wait for the copy flow to lift the
-- price, sell into their own followers.
--
-- The quantity that describes that harm is **aggregate copy notional as a
-- fraction of usable liquidity**, not follower count: 500 followers buying a
-- deep pair move it by basis points, 50 buying a fresh memecoin move it by tens
-- of percent. This file stores the numerator. The denominator (liquidity) is
-- NOT stored here, and the reason is the most important note in this file — see
-- "The liquidity gap" below.
--
-- `packages/db/src/master-capacity.ts` holds the decision, and it is the only
-- place that decides whether a cohort is admitted or skipped. This file's job is
-- to make the accounting honest and an incoherent row unrepresentable.
--
-- ── The liquidity gap, stated rather than papered over ────────────────────
--
-- A price-impact cap needs a usable-liquidity figure per (chain, token) at
-- fan-out time. What exists today, verified:
--
--   * `fetchDexScreenerLiquidity` (`packages/shared/src/prices.ts`) returns
--     DexScreener's `liquidity.usd` for the deepest pair, and is already called
--     at decision time by `apps/signal-engine/src/safety.ts`. It is a reported
--     both-sided pool TVL, not depth and not a quote, and it is not persisted
--     anywhere in this schema.
--   * Jupiter's quote carries a real per-trade `priceImpactPct`
--     (`packages/shared/src/jupiter.ts`, persisted to `trades.price_impact_pct`
--     by `007`) — Solana only, per order, obtained inside the executor at
--     simulation time, i.e. after fan-out was already decided.
--   * Polymarket's order book gives genuine depth and the executor already
--     walks it against a bps bound (`apps/trade-executor/src/polymarket.ts`) —
--     again at submission time. Polymarket outcome tokens trade on Polymarket's
--     own CLOB rather than on a DEX pair, so the DexScreener route is not
--     expected to cover them; that is a property of the venue and is NOT
--     verified anywhere in this repo, so treat it as reasoning to confirm
--     rather than a measured fact.
--
-- So there is an approximate figure for AMM pairs and NOTHING for Polymarket
-- before fan-out. Liquidity is therefore an injected input to the decision, with
-- its basis attached, and an unknown figure produces an explicit "unassessed"
-- result rather than a pass. **No liquidity column is added here on purpose:** a
-- column nothing populates reads as 0 or NULL, and either would turn this cap
-- into a control that blocks everything or permits everything while looking
-- like it works.
--
-- ── Decision 1: a cohort-level ledger, with no user id ───────────────────
--
-- `master_capacity_ledger` records ONE row per fan-out event per execution mode
-- — the whole cohort's notional, not one row per follower. Two reasons:
--
--   * Follower counts are never displayed (`S4-M9`), and a per-user ledger
--     would make a headcount trivially derivable from capacity data. There is
--     no `user_id` on this table and there must never be one.
--   * Capacity binds uniformly on every user (`S4-M7`): the decision is a
--     property of (master, token, window). A table that cannot see users cannot
--     be used to prioritise between them.
--
-- ── Decision 2: why not sum `copy_executions` ────────────────────────────
--
-- Because there is no USD notional there to sum. `028` stores
-- `requested_/confirmed_base_quantity` and `..._quote_quantity` in TOKEN units;
-- the quote token is USDC on Polymarket and on Solana stablecoin routes, but a
-- Uniswap V3 route on robinhood-chain may quote in WETH, so a quote quantity is
-- not a USD figure. `source_trades.amount_usd` is nullable and absent on two of
-- three chains by design (robinhood-chain never records one, Solana omits it off
-- USDC/USDT routes — see `S4-M23`). Summing either would produce a confident
-- wrong number, which for a cap is worse than an honest gap.
--
-- Hence `notional_usd NUMERIC NULL` plus `notional_basis`: an unpriced leg is
-- recorded as unpriced, the reader counts those legs, and the decision reports
-- its impact figure as a LOWER BOUND instead of a pass.
--
-- ── Decision 3: the window is not stored ─────────────────────────────────
--
-- Rows carry `committed_at` and the reader sums over an injected window, rather
-- than the writer bucketing into a fixed window. Bucketing would freeze one
-- window length into the data, and the two candidate windows have different
-- jobs: about 5 minutes is one fan-out's drain through a single concurrency-1
-- worker, about an hour is how long repeated buys still ride the same displaced
-- price. Both are judgements, neither is measured, and either can be changed
-- later without a backfill only if the raw timestamps are what is stored.
--
-- ── Decision 4: the per-master budget share ──────────────────────────────
--
-- `master_capacity_policy.daily_budget_share_bps` is the per-master allocation
-- inside the platform daily relayer budget that `S4-P15` depends on. Without it
-- one master doing 400 trades a day copied by 25 users consumes the whole budget
-- and blanks the venue for users copying OTHER masters — the uniform skip,
-- applied naively, would let one master's followers deny service to everyone
-- else's. NULL means "no explicit share": those masters split what is left
-- equally (`allocateMasterBudget`), because there is no defensible basis for
-- giving one master more of a shared quota and any basis we invented would be
-- the priority rule the uniform-skip decision exists to avoid.
--
-- ── Idempotency ──────────────────────────────────────────────────────────
--
-- `migrate.ts` has NO applied-migrations table: it replays EVERY file in
-- `packages/db/sql/` on EVERY invocation, in filename order, one transaction per
-- file. Every statement below is replay-safe.
--
-- Both tables are created with their key columns only, and every remaining
-- column is stated ONCE in an `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`. That
-- is deliberate and it is the fix for the trap found in `049`: a
-- `CREATE TABLE IF NOT EXISTS` body is skipped entirely on any database where
-- the file has already run, so a column later added inside that body never
-- reaches those databases. Columns added to this file in future MUST be
-- nullable or defaulted, since `ADD COLUMN ... NOT NULL` without a default
-- fails on a populated table.
--
-- Constraints are guarded by name in `pg_constraint`, as `051` does: every name
-- below is explicit, newly introduced by this file, well inside the 63-byte
-- identifier limit, and never reused by a replacement, so the name is the
-- identity and a name guard cannot mis-fire.


-- ═══════════════════════════════════════════════════════════════════════════
-- 1. master_capacity_ledger — the numerator
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS master_capacity_ledger (
  id BIGSERIAL PRIMARY KEY
);

-- Chain-prefixed, per the repo-wide address invariant (`solana:ABC...`,
-- `polygon:0x...`). `chain` is stored alongside it for filter parity with
-- `source_trades` and `copy_executions`, and the two are held in agreement by
-- `chk_master_capacity_ledger_prefix` below.
ALTER TABLE master_capacity_ledger
  ADD COLUMN IF NOT EXISTS master_wallet_address VARCHAR(128) NOT NULL;

ALTER TABLE master_capacity_ledger
  ADD COLUMN IF NOT EXISTS chain VARCHAR(64) NOT NULL;

ALTER TABLE master_capacity_ledger
  ADD COLUMN IF NOT EXISTS token_mint VARCHAR(128) NOT NULL;

-- The fan-out event this cohort notional belongs to. RESTRICT rather than
-- CASCADE: deleting a source trade would silently free capacity that was really
-- consumed, and capacity accounting that can be rewritten by a delete is not
-- accounting.
ALTER TABLE master_capacity_ledger
  ADD COLUMN IF NOT EXISTS source_trade_id UUID NOT NULL
    REFERENCES source_trades(id) ON DELETE RESTRICT;

-- Paper and shadow flow does not move a market, so a capacity check that mixed
-- modes would skip live users because of paper volume. The mode is recorded and
-- the reader filters on it.
ALTER TABLE master_capacity_ledger
  ADD COLUMN IF NOT EXISTS execution_mode VARCHAR(16) NOT NULL;

-- NULL means "this leg could not be priced" — never zero. See Decision 2.
ALTER TABLE master_capacity_ledger
  ADD COLUMN IF NOT EXISTS notional_usd NUMERIC;

ALTER TABLE master_capacity_ledger
  ADD COLUMN IF NOT EXISTS notional_basis VARCHAR(32) NOT NULL;

ALTER TABLE master_capacity_ledger
  ADD COLUMN IF NOT EXISTS committed_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'master_capacity_ledger'::regclass
       AND conname = 'chk_master_capacity_ledger_chain'
  ) THEN
    ALTER TABLE master_capacity_ledger
      ADD CONSTRAINT chk_master_capacity_ledger_chain
      CHECK (chain IN ('solana', 'polygon', 'robinhood-chain'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'master_capacity_ledger'::regclass
       AND conname = 'chk_master_capacity_ledger_mode'
  ) THEN
    ALTER TABLE master_capacity_ledger
      ADD CONSTRAINT chk_master_capacity_ledger_mode
      CHECK (execution_mode IN ('paper', 'live', 'shadow'));
  END IF;
END $$;

-- The address invariant, enforced rather than trusted. A bare `0x...` written
-- into a prefixed column is the defect class CLAUDE.md calls out, and here it
-- would silently split one master's capacity across two identities.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'master_capacity_ledger'::regclass
       AND conname = 'chk_master_capacity_ledger_prefix'
  ) THEN
    ALTER TABLE master_capacity_ledger
      ADD CONSTRAINT chk_master_capacity_ledger_prefix
      CHECK (master_wallet_address LIKE chain || ':%');
  END IF;
END $$;

-- The invariant that makes "silently zero" unrepresentable: an unpriced leg has
-- a NULL notional and a NULL notional is an unpriced leg. Without this, a writer
-- that could not price a leg could record 0 with a priced basis, and the cap
-- would read real flow as no flow.
--
-- `ELSE FALSE` is not needed because the equality covers every case, but the
-- basis list IS fail-closed: a basis not in the list is rejected loudly rather
-- than being admitted with unknown meaning.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'master_capacity_ledger'::regclass
       AND conname = 'chk_master_capacity_ledger_basis'
  ) THEN
    ALTER TABLE master_capacity_ledger
      ADD CONSTRAINT chk_master_capacity_ledger_basis
      CHECK (
        notional_basis IN (
          'quote-stablecoin', 'source-amount-usd', 'marked-to-price', 'unpriced'
        )
        AND (notional_basis = 'unpriced') = (notional_usd IS NULL)
        AND (notional_usd IS NULL OR notional_usd >= 0)
      );
  END IF;
END $$;

-- One row per fan-out event per mode. This is what makes a retried fan-out
-- unable to double-count itself into its own cap, and it is why the writer can
-- be a plain `INSERT ... ON CONFLICT DO NOTHING`.
CREATE UNIQUE INDEX IF NOT EXISTS unq_master_capacity_ledger_event
  ON master_capacity_ledger (source_trade_id, execution_mode);

-- The one read this table exists to serve: sum a (master, token) window.
-- `committed_at DESC` because every query is a recent window, never history.
CREATE INDEX IF NOT EXISTS idx_master_capacity_ledger_window
  ON master_capacity_ledger (master_wallet_address, chain, token_mint, committed_at DESC);


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. master_capacity_policy — per-master overrides and the budget share
-- ═══════════════════════════════════════════════════════════════════════════

-- Keyed on (master_wallet_address, chain) even though the prefix already carries
-- the chain, so the key shape matches every other per-chain table here and a
-- join needs no string surgery. The prefix CHECK keeps the two in agreement.
CREATE TABLE IF NOT EXISTS master_capacity_policy (
  master_wallet_address VARCHAR(128) NOT NULL,
  chain VARCHAR(64) NOT NULL,
  PRIMARY KEY (master_wallet_address, chain)
);

-- NULL means "platform default", which is the common case: an override is an
-- operator action, not a setting every master carries. The platform defaults
-- live in `master-capacity.ts` and are DERIVED from `DEFAULT_SLIPPAGE_BPS`
-- (`S4-P4`), so they are deliberately not duplicated into `config` here — a
-- second copy would drift from the tolerance it is a fraction of.
ALTER TABLE master_capacity_policy
  ADD COLUMN IF NOT EXISTS max_aggregate_impact_bps INTEGER;

ALTER TABLE master_capacity_policy
  ADD COLUMN IF NOT EXISTS follower_soft_cap INTEGER;

ALTER TABLE master_capacity_policy
  ADD COLUMN IF NOT EXISTS daily_budget_share_bps INTEGER;

-- Why an override exists at all, for whoever reads the row later.
ALTER TABLE master_capacity_policy
  ADD COLUMN IF NOT EXISTS note TEXT;

ALTER TABLE master_capacity_policy
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'master_capacity_policy'::regclass
       AND conname = 'chk_master_capacity_policy_chain'
  ) THEN
    ALTER TABLE master_capacity_policy
      ADD CONSTRAINT chk_master_capacity_policy_chain
      CHECK (chain IN ('solana', 'polygon', 'robinhood-chain'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'master_capacity_policy'::regclass
       AND conname = 'chk_master_capacity_policy_prefix'
  ) THEN
    ALTER TABLE master_capacity_policy
      ADD CONSTRAINT chk_master_capacity_policy_prefix
      CHECK (master_wallet_address LIKE chain || ':%');
  END IF;
END $$;

-- Ranges, mirroring the guards in `master-capacity.ts` so a value written by
-- hand cannot be one the decision function would throw on. 10000 bps = 100%:
-- an impact cap of 100% is already absurd and anything above it is a typo, and
-- a budget share above 100% cannot be honoured by definition. A soft cap of 0
-- is excluded because "copy nobody" is already expressible, and more legibly,
-- by not being a selectable master at all.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'master_capacity_policy'::regclass
       AND conname = 'chk_master_capacity_policy_ranges'
  ) THEN
    ALTER TABLE master_capacity_policy
      ADD CONSTRAINT chk_master_capacity_policy_ranges
      CHECK (
        (max_aggregate_impact_bps IS NULL
          OR (max_aggregate_impact_bps > 0 AND max_aggregate_impact_bps <= 10000))
        AND (follower_soft_cap IS NULL OR follower_soft_cap >= 1)
        AND (daily_budget_share_bps IS NULL
          OR (daily_budget_share_bps >= 0 AND daily_budget_share_bps <= 10000))
      );
  END IF;
END $$;

-- The budget allocator reads every explicit share at once (`S4-P15`), so the
-- partial index is over exactly the rows it wants.
CREATE INDEX IF NOT EXISTS idx_master_capacity_policy_budget
  ON master_capacity_policy (chain, daily_budget_share_bps)
  WHERE daily_budget_share_bps IS NOT NULL;


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Documentation
-- ═══════════════════════════════════════════════════════════════════════════

COMMENT ON TABLE master_capacity_ledger IS
  'Cohort-level copy notional per fan-out event (S4-M6). ONE row per '
  '(source_trade_id, execution_mode) covering the WHOLE cohort — there is no '
  'user_id and there must never be one: follower counts are never displayed '
  '(S4-M9) and capacity binds uniformly on every user (S4-M7), so a table that '
  'cannot see users cannot be used to prioritise between them. Summed over an '
  'injected window by fetchMasterWindowNotional in '
  'packages/db/src/master-capacity.ts.';

COMMENT ON COLUMN master_capacity_ledger.notional_usd IS
  'Cohort USD notional for this fan-out event, or NULL when the legs could not '
  'be priced. NULL means unknown, NEVER zero: copy_executions stores token '
  'quantities and no USD figure, and source_trades.amount_usd is NULL on '
  'robinhood-chain and on non-stablecoin Solana routes. A window containing '
  'NULLs is reported as a LOWER BOUND rather than as a pass.';

COMMENT ON COLUMN master_capacity_ledger.notional_basis IS
  'How notional_usd was obtained: quote-stablecoin (quote token is USD-pegged), '
  'source-amount-usd (from source_trades.amount_usd), marked-to-price (quantity '
  'times a fetched price), or unpriced (notional_usd IS NULL, enforced by '
  'chk_master_capacity_ledger_basis).';

COMMENT ON COLUMN master_capacity_ledger.execution_mode IS
  'Paper and shadow flow does not move a market. Recorded so the capacity read '
  'can filter to live flow instead of skipping live users over paper volume.';

COMMENT ON TABLE master_capacity_policy IS
  'Per-master capacity overrides and the per-master share of the daily relayer '
  'budget (S4-M6, consumed by S4-P15). An absent row means platform defaults, '
  'which are derived in packages/db/src/master-capacity.ts from '
  'DEFAULT_SLIPPAGE_BPS (S4-P4) rather than duplicated here.';

COMMENT ON COLUMN master_capacity_policy.daily_budget_share_bps IS
  'This master''s reserved share of the platform daily relayer/venue budget, in '
  'bps. NULL means no explicit share: those masters split the remainder equally '
  '(allocateMasterBudget). Exists so one master doing 400 trades a day cannot '
  'consume the whole budget and blank the venue for users copying OTHER '
  'masters — the uniform skip applied naively would let one master''s followers '
  'deny service to everyone else''s.';

COMMENT ON COLUMN master_capacity_policy.max_aggregate_impact_bps IS
  'Override for the aggregate cohort price-impact ceiling per (master, token, '
  'window). NULL uses PLATFORM_MAX_AGGREGATE_IMPACT_BPS, which is a fraction of '
  'the chain default slippage tolerance — the cohort must not spend the whole '
  'budget that protects the last copier from a bad fill.';

COMMENT ON COLUMN master_capacity_policy.follower_soft_cap IS
  'Override for the CRUDE secondary cap on followers per master per chain. '
  'Venue-blind by construction; the price-impact cap is the primary control. It '
  'exists because the primary cap cannot see the per-chain concurrency-1 trade '
  'worker: 500 tiny copies of a deep pair pass the impact test and still put '
  '500 orders behind one worker.';
