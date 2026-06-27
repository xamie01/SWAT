-- Jupiter swap simulation data on paper trades.
--
-- These columns store quote-level detail that the paper-fill path now fetches
-- from the Jupiter Swap API v1.  They are NULL for legacy paper trades and for
-- live trades (which get their fill data from the on-chain transaction).
--
-- price_impact_pct : % price impact the swap would cause (e.g. 0.45 = 0.45 %).
-- route_info       : full JSON route plan from Jupiter (DEX hops, amounts, fees).
-- quote_slot       : Solana slot at which the quote was computed.
-- min_token_amount : minimum output after slippage, in human token units.

ALTER TABLE trades ADD COLUMN IF NOT EXISTS price_impact_pct DECIMAL(8,4);
ALTER TABLE trades ADD COLUMN IF NOT EXISTS route_info JSONB;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS quote_slot BIGINT;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS min_token_amount DECIMAL(30,10);
