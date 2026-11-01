-- Migration: 065_polymarket_perps.sql
-- Description: Core schema for Polymarket Perpetual Futures (Perps) infrastructure,
--              including instruments catalogue, open leveraged positions, order executions,
--              collateral accounts, and row-level security isolation.

CREATE TABLE IF NOT EXISTS polymarket_perps_instruments (
  instrument_id INT PRIMARY KEY,
  symbol VARCHAR(32) NOT NULL UNIQUE,
  category VARCHAR(32) NOT NULL DEFAULT 'crypto',
  base_asset VARCHAR(16) NOT NULL,
  quote_asset VARCHAR(16) NOT NULL DEFAULT 'USD',
  price_decimals INT NOT NULL DEFAULT 2,
  quantity_decimals INT NOT NULL DEFAULT 4,
  max_leverage NUMERIC(10, 2) NOT NULL DEFAULT 10,
  min_notional NUMERIC(18, 6) NOT NULL DEFAULT 1,
  max_market_notional NUMERIC(18, 6) NOT NULL DEFAULT 100000,
  is_active BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_perps_instruments_symbol ON polymarket_perps_instruments(symbol);
CREATE INDEX IF NOT EXISTS idx_perps_instruments_category ON polymarket_perps_instruments(category);

CREATE TABLE IF NOT EXISTS polymarket_perps_accounts (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  total_account_value NUMERIC(18, 6) NOT NULL DEFAULT 0,
  available_order_margin NUMERIC(18, 6) NOT NULL DEFAULT 0,
  total_initial_margin NUMERIC(18, 6) NOT NULL DEFAULT 0,
  total_maintenance_margin NUMERIC(18, 6) NOT NULL DEFAULT 0,
  withdrawable NUMERIC(18, 6) NOT NULL DEFAULT 0,
  in_liquidation BOOLEAN NOT NULL DEFAULT false,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS polymarket_perps_positions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  instrument_id INT NOT NULL REFERENCES polymarket_perps_instruments(instrument_id),
  symbol VARCHAR(32) NOT NULL,
  side VARCHAR(8) NOT NULL CHECK (side IN ('LONG', 'SHORT')),
  size NUMERIC(28, 8) NOT NULL,
  entry_price NUMERIC(18, 6) NOT NULL,
  leverage NUMERIC(10, 2) NOT NULL DEFAULT 1,
  initial_margin NUMERIC(18, 6) NOT NULL DEFAULT 0,
  maintenance_margin NUMERIC(18, 6) NOT NULL DEFAULT 0,
  liquidation_price NUMERIC(18, 6),
  unrealized_pnl NUMERIC(18, 6) NOT NULL DEFAULT 0,
  take_profit_price NUMERIC(18, 6),
  stop_loss_price NUMERIC(18, 6),
  status VARCHAR(16) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closing', 'closed', 'liquidated')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_perps_positions_user_status ON polymarket_perps_positions(user_id, status);
CREATE INDEX IF NOT EXISTS idx_perps_positions_instrument ON polymarket_perps_positions(instrument_id);

CREATE TABLE IF NOT EXISTS polymarket_perps_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_order_id VARCHAR(64) UNIQUE,
  venue_order_id VARCHAR(64),
  instrument_id INT NOT NULL REFERENCES polymarket_perps_instruments(instrument_id),
  symbol VARCHAR(32) NOT NULL,
  side VARCHAR(8) NOT NULL CHECK (side IN ('BUY', 'SELL')),
  order_type VARCHAR(16) NOT NULL DEFAULT 'IOC' CHECK (order_type IN ('IOC', 'GTC', 'FOK')),
  price NUMERIC(18, 6) NOT NULL,
  quantity NUMERIC(28, 8) NOT NULL,
  filled_quantity NUMERIC(28, 8) NOT NULL DEFAULT 0,
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  builder_address VARCHAR(42),
  builder_fee_rate NUMERIC(10, 6) DEFAULT 0,
  raw_response JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_perps_orders_user_created ON polymarket_perps_orders(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_perps_orders_venue_id ON polymarket_perps_orders(venue_order_id);

-- Row Level Security for Perps tables
DO $$
DECLARE
  tbl text;
  tables text[] := ARRAY[
    'polymarket_perps_accounts',
    'polymarket_perps_positions',
    'polymarket_perps_orders'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = tbl) THEN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
      EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies 
        WHERE schemaname = 'public' AND tablename = tbl AND policyname = 'tenant_isolation_policy'
      ) THEN
        EXECUTE format(
          'CREATE POLICY tenant_isolation_policy ON %I FOR ALL USING (is_rls_bypassed() OR user_id = current_app_user_id()) WITH CHECK (is_rls_bypassed() OR user_id = current_app_user_id())',
          tbl
        );
      END IF;
    END IF;
  END LOOP;
END $$;
