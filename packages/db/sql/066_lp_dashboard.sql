-- 059_lp_dashboard.sql
-- LP Dashboard (apps/lp): pool discovery cache, user LP positions, risk
-- guardrail configuration, and tracked LP wallets.
--
-- Track A of the LP Dashboard build plan. Two tables here are caches of an
-- on-chain or computed fact (`lp_pools`, the scanner's output) and follow the
-- `user_balances` precedent: replaceable, CASCADE on user delete, staleness is
-- carried as data. The others are fund-touching (`lp_positions`, its state
-- history) and follow the `copy_executions` precedent: an SQL-level state
-- machine (CHECK + transition trigger + history table), not just a code one.
--
-- Chain coverage is deliberately narrower than the platform: LP operates on
-- Meteora DLMM (Solana) and Uniswap v3/v4 (Robinhood Chain) only —
-- `LpChain` in `@swat/shared` mirrors these CHECKs.
--
-- Addresses follow the repo-wide invariant: pool, position, and mint columns
-- are chain-prefixed (`solana:…`, `robinhood-chain:0x…`). The reserve
-- sub-vault pointer is a user-owned account and follows the `047` convention:
-- NOT chain-prefixed; the `*_chain` column carries the discriminator.

-- ---------------------------------------------------------------------------
-- 1. lp_pools — the scanner's discovery cache (Tracks B and C write, H reads).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lp_pools (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chain             VARCHAR(32)  NOT NULL CHECK (chain IN ('solana', 'robinhood-chain')),
  protocol          VARCHAR(32)  NOT NULL CHECK (protocol IN ('meteora-dlmm', 'uniswap-v3', 'uniswap-v4')),
  pool_address      VARCHAR(128) NOT NULL,
  pair_label        VARCHAR(128) NOT NULL,
  base_token_mint   VARCHAR(128) NOT NULL,
  quote_token_mint  VARCHAR(128) NOT NULL,
  fee_bps           NUMERIC(12,4) NOT NULL DEFAULT 0 CHECK (fee_bps >= 0),
  bin_step          INTEGER,
  tick_spacing      INTEGER,
  -- Quote-per-base at scan time; anchors ladder planning between scans.
  current_price     NUMERIC,
  tvl               NUMERIC NOT NULL DEFAULT 0 CHECK (tvl >= 0),
  active_tvl        NUMERIC NOT NULL DEFAULT 0 CHECK (active_tvl >= 0),
  volume_24h        NUMERIC NOT NULL DEFAULT 0 CHECK (volume_24h >= 0),
  fee_apr_24h       NUMERIC CHECK (fee_apr_24h IS NULL OR fee_apr_24h >= 0),
  fee_apr_7d        NUMERIC CHECK (fee_apr_7d IS NULL OR fee_apr_7d >= 0),
  -- Written by Track C. NULL means "not yet risk-assessed": the Discover feed
  -- must not show such a row, so its index is partial on this column.
  risk_score        NUMERIC CHECK (risk_score IS NULL OR (risk_score >= 0 AND risk_score <= 100)),
  risk_flags        JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_scanned_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_lp_pools_identity UNIQUE (chain, protocol, pool_address),
  -- Meteora pools are bin-based, Uniswap pools tick-based; exactly one shape.
  CONSTRAINT chk_lp_pools_granularity CHECK (
    (protocol = 'meteora-dlmm' AND bin_step IS NOT NULL AND tick_spacing IS NULL)
    OR (protocol IN ('uniswap-v3', 'uniswap-v4') AND tick_spacing IS NOT NULL AND bin_step IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_lp_pools_discovery
  ON lp_pools (chain, volume_24h DESC)
  WHERE risk_score IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_lp_pools_scanned_at
  ON lp_pools (last_scanned_at);

COMMENT ON TABLE lp_pools IS
  'Scanner output cache: one row per LP pool seen on a supported chain. Risk columns come from the Track C risk filter; rows without a risk score never reach the Discover feed.';

-- ---------------------------------------------------------------------------
-- 2. lp_guardrail_configs — per-user risk guardrails (Track G reads).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lp_guardrail_configs (
  user_id                   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Cap on the share of the user's deployed LP capital a single pool may hold.
  max_pool_allocation_pct   NUMERIC(5,2) NOT NULL DEFAULT 50.00
    CHECK (max_pool_allocation_pct > 0 AND max_pool_allocation_pct <= 100),
  -- Share of realized profit swept to the reserve sub-vault on close/harvest.
  profit_bank_pct           NUMERIC(5,2) NOT NULL DEFAULT 50.00
    CHECK (profit_bank_pct >= 0 AND profit_bank_pct <= 100),
  -- User-owned reserve account (NOT chain-prefixed — 047 convention). The
  -- pairing constraint mirrors `chk_ueg_secret_matches_kind`: both halves or
  -- neither. The account itself is an existing non-custodial vault pattern
  -- (ADR-0003), not a new custody path.
  reserve_sub_vault_chain   VARCHAR(32) CHECK (reserve_sub_vault_chain IN ('solana', 'robinhood-chain')),
  reserve_sub_vault_address VARCHAR(128),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_lp_guardrail_configs_user UNIQUE (user_id),
  CONSTRAINT chk_lp_guardrail_reserve_pairing CHECK (
    (reserve_sub_vault_chain IS NULL) = (reserve_sub_vault_address IS NULL)
  )
);

COMMENT ON TABLE lp_guardrail_configs IS
  'Per-user LP risk guardrails: single-pool exposure cap, profit-banking share, and the reserve sub-vault profit sweeps land in. Defaults are the plan defaults (50% / 50%).';

-- ---------------------------------------------------------------------------
-- 3. lp_positions — the user's laddered LP positions (Tracks E, F, G, H).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lp_positions (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  chain                     VARCHAR(32) NOT NULL CHECK (chain IN ('solana', 'robinhood-chain')),
  protocol                  VARCHAR(32) NOT NULL CHECK (protocol IN ('meteora-dlmm', 'uniswap-v3', 'uniswap-v4')),
  pool_address              VARCHAR(128) NOT NULL,
  -- Ladder distribution: Meteora strategy shapes; Uniswap maps 'spot' to a
  -- narrow full-range-ish rung set, 'curve'/'bidask' to weighted tick rungs.
  strategy_type             VARCHAR(16) NOT NULL CHECK (strategy_type IN ('spot', 'curve', 'bidask')),
  -- Human-readable price bounds of the whole ladder, in quote-per-base terms.
  range_lower               NUMERIC NOT NULL CHECK (range_lower > 0),
  range_upper               NUMERIC NOT NULL CHECK (range_upper > range_lower),
  -- Per-rung array, ordered: [{ priceLower, priceUpper, weight, binId?, tickLower?, tickUpper? }, …].
  rung_allocations          JSONB NOT NULL DEFAULT '[]'::jsonb,
  deposit_amount            NUMERIC NOT NULL CHECK (deposit_amount > 0),
  deposit_asset             VARCHAR(128) NOT NULL,
  state                     VARCHAR(32) NOT NULL DEFAULT 'building'
    CHECK (state IN ('building', 'active', 'near_edge', 'out_of_range', 'rebalancing', 'closed')),
  -- Chain-prefixed. NULL while the ladder is still being built or is paper-only.
  on_chain_position_address VARCHAR(128),
  opened_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at                 TIMESTAMPTZ,
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- A closed position carries its close time; an open one does not. Evaluated
  -- after the BEFORE trigger below runs, so the closing UPDATE sets both.
  CONSTRAINT chk_lp_positions_close_pairing CHECK (
    (state = 'closed') = (closed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_lp_positions_monitor
  ON lp_positions (chain, state)
  WHERE state IN ('active', 'near_edge', 'out_of_range');

CREATE INDEX IF NOT EXISTS idx_lp_positions_user
  ON lp_positions (user_id, opened_at DESC);

CREATE INDEX IF NOT EXISTS idx_lp_positions_pool
  ON lp_positions (pool_address)
  WHERE state <> 'closed';

COMMENT ON TABLE lp_positions IS
  'One user LP ladder. Fund-touching: state transitions are enforced twice (code, via canTransitionLpPosition in @swat/shared; SQL, via the trigger below) and every transition is journaled.';

-- ---------------------------------------------------------------------------
-- 4. lp_position_state_history — the journal the trigger and code both append.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lp_position_state_history (
  id          BIGSERIAL PRIMARY KEY,
  position_id UUID NOT NULL REFERENCES lp_positions(id) ON DELETE RESTRICT,
  from_state  VARCHAR(32),
  to_state    VARCHAR(32) NOT NULL
    CHECK (to_state IN ('building', 'active', 'near_edge', 'out_of_range', 'rebalancing', 'closed')),
  reason      TEXT,
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lp_position_state_history_position
  ON lp_position_state_history (position_id, changed_at);

-- ---------------------------------------------------------------------------
-- 5. State-machine trigger — cloned from enforce_copy_execution_state_transition
-- (028) with the LP transition table. The machine in @swat/shared
-- (LP_POSITION_TRANSITIONS) is the readable source of truth; this trigger makes
-- an incoherent row unrepresentable even if a future caller skips the code path.
-- Keep the two tables in sync when a state is added.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION enforce_lp_position_state_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.state = OLD.state THEN
    RETURN NEW;
  END IF;

  IF NOT (
    (OLD.state = 'building' AND NEW.state IN ('active', 'closed'))
    OR (OLD.state = 'active' AND NEW.state IN ('near_edge', 'out_of_range', 'closed'))
    OR (OLD.state = 'near_edge' AND NEW.state IN ('active', 'out_of_range', 'rebalancing', 'closed'))
    OR (OLD.state = 'out_of_range' AND NEW.state IN ('active', 'rebalancing', 'closed'))
    OR (OLD.state = 'rebalancing' AND NEW.state IN ('active', 'near_edge', 'out_of_range', 'closed'))
  ) THEN
    RAISE EXCEPTION 'invalid lp position transition: % -> %', OLD.state, NEW.state;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_lp_position_state_transition ON lp_positions;
CREATE TRIGGER trg_lp_position_state_transition
  BEFORE UPDATE OF state ON lp_positions
  FOR EACH ROW EXECUTE FUNCTION enforce_lp_position_state_transition();

-- ---------------------------------------------------------------------------
-- 6. lp_tracked_wallets + observation tables — the LP wallet indexer (Track D).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lp_tracked_wallets (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chain                   VARCHAR(32) NOT NULL CHECK (chain IN ('solana', 'robinhood-chain')),
  -- Chain-prefixed: a tracked external wallet, same shape as `source_trades.wallet_address`.
  wallet_address          VARCHAR(128) NOT NULL,
  label                   VARCHAR(128),
  polling_cadence_seconds INTEGER NOT NULL DEFAULT 300
    CHECK (polling_cadence_seconds BETWEEN 30 AND 86400),
  last_indexed_at         TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_lp_tracked_wallets_identity UNIQUE (chain, wallet_address)
);

-- Time series the PnL calculator consumes: one row per observed position per pass.
CREATE TABLE IF NOT EXISTS lp_wallet_snapshots (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tracked_wallet_id  UUID NOT NULL REFERENCES lp_tracked_wallets(id) ON DELETE CASCADE,
  position_address   VARCHAR(128) NOT NULL,
  pool_address       VARCHAR(128) NOT NULL,
  captured_at        TIMESTAMPTZ NOT NULL,
  position_value_usd NUMERIC NOT NULL DEFAULT 0 CHECK (position_value_usd >= 0),
  uncollected_fees_usd NUMERIC NOT NULL DEFAULT 0 CHECK (uncollected_fees_usd >= 0),
  in_range           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_lp_wallet_snapshots_observation
    UNIQUE (tracked_wallet_id, position_address, captured_at)
);

CREATE INDEX IF NOT EXISTS idx_lp_wallet_snapshots_series
  ON lp_wallet_snapshots (tracked_wallet_id, position_address, captured_at);

-- Computed per-position outcomes (Track D3/D5). The indexer upserts one row per
-- position it can close the books on; the leaderboard query aggregates only this
-- table, so the screen never re-derives PnL from the raw series at request time.
CREATE TABLE IF NOT EXISTS lp_wallet_position_results (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tracked_wallet_id  UUID NOT NULL REFERENCES lp_tracked_wallets(id) ON DELETE CASCADE,
  position_address   VARCHAR(128) NOT NULL,
  pool_address       VARCHAR(128) NOT NULL,
  chain              VARCHAR(32) NOT NULL CHECK (chain IN ('solana', 'robinhood-chain')),
  strategy_type      VARCHAR(16) NOT NULL CHECK (strategy_type IN ('spot', 'curve', 'bidask')),
  net_result_usd     NUMERIC NOT NULL DEFAULT 0,
  first_observed_at  TIMESTAMPTZ NOT NULL,
  last_observed_at   TIMESTAMPTZ NOT NULL,
  closed             BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_lp_wallet_position_results UNIQUE (tracked_wallet_id, position_address)
);

CREATE INDEX IF NOT EXISTS idx_lp_wallet_position_results_wallet
  ON lp_wallet_position_results (tracked_wallet_id);

COMMENT ON TABLE lp_wallet_position_results IS
  'Net LP result per tracked wallet position, computed by the Track D PnL calculator from lp_wallet_snapshots series. Aggregated by the leaderboard query; win rate counts closed rows only.';
