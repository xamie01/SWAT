-- Multi-venue foundation: add chain discriminators to core entities.
-- Existing rows default to Solana to preserve current behavior.

ALTER TABLE wallets
  ADD COLUMN IF NOT EXISTS chain VARCHAR(32) DEFAULT 'solana';

UPDATE wallets
SET chain = 'solana'
WHERE chain IS NULL;

ALTER TABLE wallets
  ALTER COLUMN chain SET DEFAULT 'solana',
  ALTER COLUMN chain SET NOT NULL;

ALTER TABLE wallets
  DROP CONSTRAINT IF EXISTS wallets_chain_check;

ALTER TABLE wallets
  ADD CONSTRAINT wallets_chain_check
  CHECK (chain IN ('solana', 'polygon', 'robinhood-chain'));

CREATE INDEX IF NOT EXISTS idx_wallets_chain_status
  ON wallets (chain, status);

ALTER TABLE tokens
  ADD COLUMN IF NOT EXISTS chain VARCHAR(32) DEFAULT 'solana';

UPDATE tokens
SET chain = 'solana'
WHERE chain IS NULL;

ALTER TABLE tokens
  ALTER COLUMN chain SET DEFAULT 'solana',
  ALTER COLUMN chain SET NOT NULL;

ALTER TABLE tokens
  DROP CONSTRAINT IF EXISTS tokens_chain_check;

ALTER TABLE tokens
  ADD CONSTRAINT tokens_chain_check
  CHECK (chain IN ('solana', 'polygon', 'robinhood-chain'));

CREATE INDEX IF NOT EXISTS idx_tokens_chain_first_seen
  ON tokens (chain, first_seen DESC);

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS chain VARCHAR(32) DEFAULT 'solana';

UPDATE transactions
SET chain = 'solana'
WHERE chain IS NULL;

ALTER TABLE transactions
  ALTER COLUMN chain SET DEFAULT 'solana',
  ALTER COLUMN chain SET NOT NULL;

ALTER TABLE transactions
  DROP CONSTRAINT IF EXISTS transactions_chain_check;

ALTER TABLE transactions
  ADD CONSTRAINT transactions_chain_check
  CHECK (chain IN ('solana', 'polygon', 'robinhood-chain'));

CREATE INDEX IF NOT EXISTS idx_tx_chain_wallet_ts
  ON transactions (chain, wallet_address, timestamp DESC);

DROP INDEX IF EXISTS idx_tx_dedup;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tx_dedup
  ON transactions (chain, signature, wallet_address, COALESCE(target_token, ''));
