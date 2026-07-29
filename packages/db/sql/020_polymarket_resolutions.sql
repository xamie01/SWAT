-- G6-A6: Polymarket resolutions and wallet win rate backfills
ALTER TABLE polymarket_markets
ADD COLUMN IF NOT EXISTS winning_token_id TEXT;
