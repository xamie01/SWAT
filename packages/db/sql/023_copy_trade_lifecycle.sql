-- 023_copy_trade_lifecycle.sql

CREATE TABLE IF NOT EXISTS source_trades (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chain VARCHAR(64) NOT NULL,
    transaction_hash VARCHAR(128) NOT NULL,
    wallet_address VARCHAR(128) NOT NULL,
    token_mint VARCHAR(128) NOT NULL,
    direction VARCHAR(16) NOT NULL CHECK (direction IN ('buy', 'sell')),
    amount_usd NUMERIC,
    token_amount NUMERIC NOT NULL,
    price_usd NUMERIC,
    status VARCHAR(32) NOT NULL DEFAULT 'confirmed',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(chain, transaction_hash, wallet_address, token_mint, direction)
);

CREATE TABLE IF NOT EXISTS wallet_positions (
    wallet_address VARCHAR(128) NOT NULL,
    chain VARCHAR(64) NOT NULL,
    token_mint VARCHAR(128) NOT NULL,
    balance NUMERIC NOT NULL DEFAULT 0 CHECK (balance >= 0),
    cost_basis_usd NUMERIC NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(wallet_address, chain, token_mint)
);

ALTER TABLE trades ADD COLUMN IF NOT EXISTS source_trade_id UUID REFERENCES source_trades(id) ON DELETE SET NULL;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS target_amount_usd NUMERIC;

-- G1-C2: Add schema constraint to prevent duplicate executor runs from copying the same source trade multiple times.
-- Note: A single source trade might have 'paper', 'shadow', and 'live' executed trades, so uniqueness is keyed on source + execution_mode.
CREATE UNIQUE INDEX IF NOT EXISTS unq_trades_source_trade_mode 
ON trades (source_trade_id, execution_mode)
WHERE source_trade_id IS NOT NULL;
