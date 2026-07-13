-- Create index to optimize hasRecentBuy() cooldown checks using correct executed_at column
CREATE INDEX IF NOT EXISTS idx_trades_token_mint_cooldown 
  ON trades (token_mint, direction, status, executed_at DESC);

-- Create index to optimize Polymarket conditional token lookups
CREATE INDEX IF NOT EXISTS idx_tokens_polymarket_condition_id 
  ON tokens (polymarket_condition_id) 
  WHERE polymarket_condition_id IS NOT NULL;

-- Create index to optimize transaction token_in lookups
CREATE INDEX IF NOT EXISTS idx_transactions_token_in 
  ON transactions (token_in);
