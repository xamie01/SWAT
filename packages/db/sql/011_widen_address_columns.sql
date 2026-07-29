-- Migration to widen address and token mint columns to VARCHAR(100)
-- to accommodate chain-prefixed addresses (e.g. polygon:0x... and robinhood-chain:0x...)

-- Alter wallets table address column
ALTER TABLE wallets ALTER COLUMN address TYPE VARCHAR(100);

-- Alter tokens table mint column
ALTER TABLE tokens ALTER COLUMN mint TYPE VARCHAR(100);

-- Alter transactions table referencing columns
ALTER TABLE transactions ALTER COLUMN wallet_address TYPE VARCHAR(100);
ALTER TABLE transactions ALTER COLUMN token_in TYPE VARCHAR(100);
ALTER TABLE transactions ALTER COLUMN token_out TYPE VARCHAR(100);
ALTER TABLE transactions ALTER COLUMN target_token TYPE VARCHAR(100);
