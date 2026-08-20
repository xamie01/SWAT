-- 048_user_balances.sql
-- Cached per-user, per-chain, per-asset balances (checklist S4-8). Refreshed by a
-- poller and after each trade; read by the fan-out sizing path.
--
-- This table is a CACHE OF AN ON-CHAIN FACT, not a ledger. That single sentence
-- drives most of what follows, starting with ON DELETE CASCADE: deleting these
-- rows loses nothing, because the poller rebuilds them from the chain. Compare
-- 047, where RESTRICT is right because the row is the only pointer to funds.
--
-- PRIMARY KEY (user_id, chain, asset) with no surrogate id: the triple IS the
-- fact, matching the reasoning in 044_user_wallet_subscriptions.sql. Nothing
-- references a balance row, so there is nothing for an id to be referenced by.
--
-- Staleness is a hard gate in the reader, not a warning. Sizing a live trade off
-- a stale balance is how a user ends up with more exposure than they hold: the
-- previous trade's debit has not been observed yet, so the next trade sizes off
-- pre-trade funds. Fan-out makes it acute — N jobs for one user across chains can
-- all read the same pre-trade snapshot inside one poll interval.
--
-- Idempotent: CREATE ... IF NOT EXISTS only.

CREATE TABLE IF NOT EXISTS user_balances (
  user_id       UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chain         VARCHAR(32)  NOT NULL,
  -- The asset identifier as the venue names it: a chain-prefixed mint/contract
  -- for a token, or the chain's native symbol. VARCHAR(128) rather than 100
  -- because a Polymarket CTF position id is longer than an address.
  asset         VARCHAR(128) NOT NULL,
  -- Human-scale amount. NUMERIC, never a float: a float64 cannot hold 18-decimal
  -- base units without drift, and this number is multiplied into position sizes.
  amount        NUMERIC      NOT NULL DEFAULT 0 CHECK (amount >= 0),
  -- Stored alongside `amount` rather than looked up at read time. A SELL needs an
  -- exact base-unit quantity (S3-7), which means reconstructing the integer from
  -- `amount`, which needs `decimals`. Deriving it from token metadata on read
  -- would make the sizing path depend on a second network call that can fail.
  decimals      SMALLINT     NOT NULL DEFAULT 0 CHECK (decimals BETWEEN 0 AND 36),
  -- Nullable, and carrying its own timestamp, because a price fetch can fail
  -- independently of a balance fetch. Encoding "we know the amount but not the
  -- price" as `usd = 0` would make a funded user look empty to the sizing path,
  -- which then sizes to zero — a silent failure that looks like a working system.
  -- NULL forces the reader to say "unknown" and refuse.
  usd           NUMERIC      CHECK (usd IS NULL OR usd >= 0),
  usd_priced_at TIMESTAMPTZ,
  fetched_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  -- Distinguishes a scheduled poll from a post-trade refresh. When a balance
  -- looks wrong the first question is always "when and why did we last write
  -- this", and reconstructing the why from timestamps alone is guesswork.
  source        VARCHAR(24)  NOT NULL DEFAULT 'poller',

  PRIMARY KEY (user_id, chain, asset),
  -- Same three-value union as every other chain column in the schema.
  CONSTRAINT chk_ub_chain CHECK (chain IN ('solana','polygon','robinhood-chain')),
  CONSTRAINT chk_ub_source CHECK (source IN ('poller','post-trade','manual-refresh')),
  -- A priced balance must say WHEN it was priced, otherwise the staleness gate
  -- cannot tell a fresh valuation from one carried over from an old poll. Stated
  -- one-directionally on purpose: the converse is allowed, so a poller may record
  -- "priced at T, price unavailable" as (usd NULL, usd_priced_at T) rather than
  -- having to discard the attempt.
  CONSTRAINT chk_ub_usd_priced_at CHECK (usd IS NULL OR usd_priced_at IS NOT NULL)
);

-- Serves both the poller's "what is oldest" scan and the sizing path's staleness
-- check. Not composite with user_id: the poller's question is global.
CREATE INDEX IF NOT EXISTS idx_user_balances_stale ON user_balances(fetched_at);
