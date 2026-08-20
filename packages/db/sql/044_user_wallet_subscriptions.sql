-- 044_user_wallet_subscriptions.sql
-- Per-user tracking, on a global-dedup model (D9).
--
-- `wallets`, `transactions`, clusters, and scoring stay GLOBAL: one wallet is
-- indexed once no matter how many users track it. Subscription is a join, never
-- a copy — that is what keeps indexing cost sublinear in user count.
--
-- The primary key is (user_id, wallet_address) rather than a surrogate id
-- because the pair IS the fact; there is no such thing as two distinct
-- subscriptions by one user to one wallet.
--
-- ON DELETE CASCADE on both sides is safe HERE because a subscription is a
-- preference, not a financial record. The same is emphatically not true of
-- trades/copy_executions, which must outlive the account (D13, ADR-0001).
--
-- Idempotent: CREATE ... IF NOT EXISTS only.

CREATE TABLE IF NOT EXISTS user_wallet_subscriptions (
  user_id        UUID         NOT NULL REFERENCES users(id)      ON DELETE CASCADE,
  -- wallets.address is the table's own primary key and is chain-prefixed
  -- (`${chain}:${raw}`). Never store a bare address here.
  wallet_address VARCHAR(100) NOT NULL REFERENCES wallets(address) ON DELETE CASCADE,
  label          VARCHAR(64),
  source         VARCHAR(24)  NOT NULL DEFAULT 'manual',
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, wallet_address),
  CONSTRAINT chk_subscription_source
    CHECK (source IN ('manual','platform-signal','discovered'))
);

-- Reverse lookup: "does this wallet have any subscribers?" The nightly pause
-- sweep asks that for every wallet, so it must not be a sequential scan.
CREATE INDEX IF NOT EXISTS idx_uws_wallet
  ON user_wallet_subscriptions(wallet_address);

CREATE INDEX IF NOT EXISTS idx_uws_user_created
  ON user_wallet_subscriptions(user_id, created_at DESC);
