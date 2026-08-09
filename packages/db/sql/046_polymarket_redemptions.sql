-- 046_polymarket_redemptions.sql
--
-- Redemption ledger for resolved Polymarket positions (checklist S3-18).
--
-- Why this table exists at all. A resolved Polymarket market stops accepting
-- orders, so a winning position cannot be *sold* — it must be redeemed, which
-- converts each winning outcome token into 1 pUSD and each losing token into 0.
-- Until this landed, `assertPolymarketMarketTradable` correctly refused to trade
-- a resolving market but nothing ever claimed the proceeds, so a winning
-- position stayed open in the ledger forever and its collateral was stranded.
--
-- Why a ledger rather than an idempotent re-read. `redeemPositions()` takes no
-- amount and redeems the wallet's whole balance for both outcomes, so a second
-- call after a successful first one is a no-op on-chain but still costs gas and
-- still produces a transaction hash the reconciler would treat as a new fill.
-- The unique constraint below is what makes the sweep safe to run on a timer.

CREATE TABLE IF NOT EXISTS polymarket_redemptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Tenancy key per ADR 0001. Nullable during Stage 3 because the executor
  -- still runs as the single 'operator' account; Stage 4 backfills and tightens.
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,

  condition_id TEXT NOT NULL,

  -- Claim/confirm lifecycle, mirroring how copy_executions separates a claimed
  -- intent from a confirmed on-chain fact. A crash between claim and confirm
  -- must not look like a completed redemption.
  status TEXT NOT NULL DEFAULT 'claimed'
    CHECK (status IN ('claimed', 'confirmed', 'failed')),

  transaction_hash TEXT,

  -- Recorded so P&L can attribute the proceeds without re-deriving them from
  -- chain state. Units are pUSD, 6dp, stored as NUMERIC to avoid float drift.
  redeemed_collateral NUMERIC(38, 6),
  winning_token_id TEXT,

  failure_reason TEXT,

  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at TIMESTAMPTZ,

  -- A confirmed redemption must carry its evidence, and a claimed one must not
  -- pretend to. Without this, a failed confirm could leave a row that reads as
  -- settled with no hash to verify against.
  CONSTRAINT chk_polymarket_redemption_confirmed_evidence CHECK (
    status <> 'confirmed'
    OR (transaction_hash IS NOT NULL AND confirmed_at IS NOT NULL)
  )
);

-- The exactly-once guard. One live claim per (user, market): a second sweep
-- while the first is still claimed or already confirmed cannot insert.
-- Partial, so a 'failed' attempt does not permanently poison the market.
--
-- NULLS NOT DISTINCT is load-bearing, not decoration. `user_id` is NULL for the
-- whole of Stage 3 (single 'operator' account), and by default NULL never
-- conflicts with NULL — so without this the index is silently INERT and two
-- concurrent sweeps both claim the same market. Verified by probe: with plain
-- NULLS DISTINCT a second claim inserts happily; with this clause it raises a
-- unique violation, while a 'failed' row is still free to be retried.
--
-- Requires PostgreSQL 15+. CI and production both run 16.
DROP INDEX IF EXISTS uq_polymarket_redemption_live_claim;
CREATE UNIQUE INDEX IF NOT EXISTS uq_polymarket_redemption_live_claim
  ON polymarket_redemptions (user_id, condition_id) NULLS NOT DISTINCT
  WHERE status IN ('claimed', 'confirmed');

-- Covers the sweep's own lookup: "which markets have I not yet redeemed?"
CREATE INDEX IF NOT EXISTS idx_polymarket_redemptions_condition_status
  ON polymarket_redemptions (condition_id, status);

-- Stuck-claim recovery scan: claimed rows older than the confirm timeout.
CREATE INDEX IF NOT EXISTS idx_polymarket_redemptions_claimed_at
  ON polymarket_redemptions (claimed_at)
  WHERE status = 'claimed';

COMMENT ON TABLE polymarket_redemptions IS
  'Exactly-once ledger for redeeming resolved Polymarket positions into pUSD. '
  'A resolved market cannot be sold, so redemption is the only exit path.';
