-- 041_user_auth_wallets.sql
-- Identity wallets: an address the user has proven control of via SIWE
-- (EIP-4361) or SIWS. These are NOT tracked wallets -- they authenticate a
-- person and, from Stage 4, are the only permitted withdrawal destinations.
--
-- UNIQUE is (chain_kind, address) GLOBALLY, not per user. One wallet proves one
-- identity. Without this, two accounts could each claim the same address and
-- Stage 4's withdraw-to-linked-wallet-only control would have no single answer
-- to "whose address is this?" -- which is the control's entire premise.
--
-- chain_kind, not chain: an EVM signature proves control of that address on
-- every EVM chain at once, so pinning a linked wallet to `polygon` rather than
-- `robinhood-chain` would be arbitrary and wrong.
--
-- Addresses here are NOT chain-prefixed. The repo-wide `${chain}:${address}`
-- invariant governs tracked wallets and transactions; chain_kind already
-- carries the discriminator for identity. Write EVM lowercased and Solana
-- case-preserved, matching resolveChainAddress semantics.
--
-- Idempotent: CREATE ... IF NOT EXISTS only.

CREATE TABLE IF NOT EXISTS user_auth_wallets (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chain_kind  VARCHAR(16)  NOT NULL,
  address     VARCHAR(100) NOT NULL,
  verified_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_auth_wallet_kind CHECK (chain_kind IN ('evm','solana')),
  CONSTRAINT uq_auth_wallet UNIQUE (chain_kind, address)
);

CREATE INDEX IF NOT EXISTS idx_user_auth_wallets_user
  ON user_auth_wallets(user_id);
