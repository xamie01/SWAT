-- 063_crypto_billing.sql
--
-- Pure crypto-native billing ledger in USDC for Solana and Polygon (checklist Stage 5).
--
-- Replaces fiat/Stripe payment infrastructure to eliminate banking bottlenecks,
-- chargeback risk, and fiat de-platforming. Supports:
--   - Operator Tier: 35 USDC / 30 Days (Stackable)
--   - Ultra Tier: 150 USDC / 30 Days (Stackable)
--   - Lifetime Pass: 1999 USDC (Permanent access; tier_expires_at = NULL per 039)
--
-- Idempotent: CREATE ... IF NOT EXISTS only. Replays cleanly on migrate.ts.

-- 1. Crypto payments ledger (audit trail and replay-attack guard)
CREATE TABLE IF NOT EXISTS crypto_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  chain VARCHAR(32) NOT NULL CHECK (chain IN ('solana', 'polygon')),
  tx_hash VARCHAR(128) NOT NULL,
  amount_usdc NUMERIC(16, 6) NOT NULL CHECK (amount_usdc > 0),
  tier VARCHAR(16) NOT NULL CHECK (tier IN ('operator', 'ultra')),
  plan_id VARCHAR(32) NOT NULL CHECK (plan_id IN ('operator_monthly', 'ultra_monthly', 'lifetime')),
  duration_days INT CHECK (duration_days IS NULL OR duration_days > 0),
  payer_address VARCHAR(128),
  treasury_address VARCHAR(128) NOT NULL,
  memo VARCHAR(64),
  status VARCHAR(24) NOT NULL DEFAULT 'confirmed'
    CHECK (status IN ('confirmed', 'underpaid', 'refund_requested')),
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Crucial security constraint: a blockchain transaction hash on a given chain
-- can NEVER be credited more than once across the entire system.
CREATE UNIQUE INDEX IF NOT EXISTS uq_crypto_payments_chain_tx
  ON crypto_payments(chain, tx_hash);

CREATE INDEX IF NOT EXISTS idx_crypto_payments_user
  ON crypto_payments(user_id, confirmed_at DESC);

CREATE INDEX IF NOT EXISTS idx_crypto_payments_memo
  ON crypto_payments(memo)
  WHERE memo IS NOT NULL;


-- 2. User payment intents (tracks reference memos for external / exchange deposits)
CREATE TABLE IF NOT EXISTS user_payment_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reference_memo VARCHAR(32) NOT NULL,
  plan_id VARCHAR(32) NOT NULL CHECK (plan_id IN ('operator_monthly', 'ultra_monthly', 'lifetime')),
  tier VARCHAR(16) NOT NULL CHECK (tier IN ('operator', 'ultra')),
  expected_amount_usdc NUMERIC(16, 6) NOT NULL CHECK (expected_amount_usdc > 0),
  status VARCHAR(24) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'completed', 'expired')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_user_payment_intents_memo
  ON user_payment_intents(reference_memo);

CREATE INDEX IF NOT EXISTS idx_user_payment_intents_user
  ON user_payment_intents(user_id, status);

CREATE INDEX IF NOT EXISTS idx_user_payment_intents_expiry
  ON user_payment_intents(expires_at)
  WHERE status = 'pending';
