-- Widen remaining address and mint columns to accommodate chain-prefixed addresses
ALTER TABLE cluster_memberships ALTER COLUMN wallet_address TYPE VARCHAR(100);
ALTER TABLE wallet_relationships ALTER COLUMN wallet_a TYPE VARCHAR(100);
ALTER TABLE wallet_relationships ALTER COLUMN wallet_b TYPE VARCHAR(100);
ALTER TABLE signals ALTER COLUMN token_mint TYPE VARCHAR(100);
ALTER TABLE trades ALTER COLUMN wallet_address TYPE VARCHAR(100);
ALTER TABLE trades ALTER COLUMN token_mint TYPE VARCHAR(100);

-- Add chain discriminator to signals table conditionally
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'signals' AND column_name = 'chain'
  ) THEN
    ALTER TABLE signals ADD COLUMN chain VARCHAR(32) NOT NULL DEFAULT 'solana';
    ALTER TABLE signals ADD CONSTRAINT chk_signals_chain CHECK (chain IN ('solana', 'polygon', 'robinhood-chain'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_signals_chain ON signals (chain);

-- Add chain discriminator to trades table conditionally
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'trades' AND column_name = 'chain'
  ) THEN
    ALTER TABLE trades ADD COLUMN chain VARCHAR(32) NOT NULL DEFAULT 'solana';
    ALTER TABLE trades ADD CONSTRAINT chk_trades_chain CHECK (chain IN ('solana', 'polygon', 'robinhood-chain'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_trades_chain ON trades (chain);
