CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS wallets (
  address VARCHAR(44) PRIMARY KEY,
  nickname VARCHAR(100),
  source VARCHAR(50) NOT NULL DEFAULT 'manual',
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  first_seen TIMESTAMP DEFAULT NOW(),
  last_active TIMESTAMP,
  total_trades INTEGER DEFAULT 0,
  win_rate DECIMAL(5,2),
  realized_roi DECIMAL(12,4),
  unrealized_roi DECIMAL(12,4),
  avg_hold_time_hours DECIMAL(8,2),
  early_entry_score DECIMAL(5,2),
  consistency_score DECIMAL(5,2),
  composite_score DECIMAL(5,2),
  tier VARCHAR(20),
  portfolio_value_usd DECIMAL(16,2),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tokens (
  mint VARCHAR(44) PRIMARY KEY,
  symbol VARCHAR(20),
  name VARCHAR(100),
  decimals INTEGER,
  logo_uri TEXT,
  first_seen TIMESTAMP DEFAULT NOW(),
  launch_timestamp TIMESTAMP,
  total_supply BIGINT,
  is_verified BOOLEAN DEFAULT FALSE,
  tags TEXT[],
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS transactions (
  id BIGSERIAL PRIMARY KEY,
  signature VARCHAR(88) NOT NULL,
  wallet_address VARCHAR(44) REFERENCES wallets(address),
  token_in VARCHAR(44) REFERENCES tokens(mint),
  token_out VARCHAR(44) REFERENCES tokens(mint),
  amount_in BIGINT NOT NULL,
  amount_out BIGINT NOT NULL,
  amount_in_usd DECIMAL(16,6),
  amount_out_usd DECIMAL(16,6),
  direction VARCHAR(4) NOT NULL,
  target_token VARCHAR(44),
  program_id VARCHAR(44),
  slot BIGINT,
  timestamp TIMESTAMP NOT NULL,
  block_time BIGINT,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(signature, wallet_address, target_token)
);
CREATE INDEX IF NOT EXISTS idx_tx_wallet ON transactions(wallet_address, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_tx_token ON transactions(target_token, timestamp DESC);

CREATE TABLE IF NOT EXISTS wallet_clusters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100),
  description TEXT,
  confidence DECIMAL(3,2) NOT NULL,
  wallet_count INTEGER DEFAULT 0,
  total_realized_roi DECIMAL(12,4),
  total_unrealized_roi DECIMAL(12,4),
  avg_composite_score DECIMAL(5,2),
  first_seen TIMESTAMP DEFAULT NOW(),
  last_active TIMESTAMP DEFAULT NOW(),
  status VARCHAR(20) DEFAULT 'active',
  tags TEXT[],
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cluster_memberships (
  cluster_id UUID REFERENCES wallet_clusters(id) ON DELETE CASCADE,
  wallet_address VARCHAR(44) REFERENCES wallets(address),
  joined_at TIMESTAMP DEFAULT NOW(),
  confidence DECIMAL(3,2),
  PRIMARY KEY (cluster_id, wallet_address)
);

CREATE TABLE IF NOT EXISTS wallet_relationships (
  id SERIAL PRIMARY KEY,
  wallet_a VARCHAR(44) NOT NULL,
  wallet_b VARCHAR(44) NOT NULL,
  relationship_type VARCHAR(20) NOT NULL,
  confidence DECIMAL(3,2) NOT NULL,
  evidence JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(wallet_a, wallet_b, relationship_type)
);
CREATE INDEX IF NOT EXISTS idx_rel_a ON wallet_relationships(wallet_a);
CREATE INDEX IF NOT EXISTS idx_rel_b ON wallet_relationships(wallet_b);

CREATE TABLE IF NOT EXISTS signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern_type VARCHAR(20) NOT NULL,
  cluster_id UUID REFERENCES wallet_clusters(id),
  token_mint VARCHAR(44) REFERENCES tokens(mint),
  confidence DECIMAL(5,2) NOT NULL,
  signal_score DECIMAL(5,2) NOT NULL,
  trigger_data JSONB NOT NULL,
  status VARCHAR(20) DEFAULT 'pending',
  executed_at TIMESTAMP,
  executed_price DECIMAL(16,8),
  executed_amount DECIMAL(16,8),
  trade_signature VARCHAR(88),
  pnl_usd DECIMAL(16,6),
  created_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_signals_status ON signals(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_signals_cluster ON signals(cluster_id, created_at DESC);

CREATE TABLE IF NOT EXISTS trades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_id UUID REFERENCES signals(id),
  wallet_address VARCHAR(44),
  token_mint VARCHAR(44),
  direction VARCHAR(4) NOT NULL,
  amount_usd DECIMAL(16,6),
  token_amount BIGINT,
  price_usd DECIMAL(16,8),
  slippage_bps INTEGER,
  priority_fee_lamports BIGINT,
  signature VARCHAR(88),
  status VARCHAR(20) DEFAULT 'pending',
  simulation_result JSONB,
  error_message TEXT,
  executed_at TIMESTAMP DEFAULT NOW(),
  confirmed_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS config (
  key VARCHAR(50) PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW()
);

INSERT INTO config (key, value) VALUES
('trading', '{"enabled": false, "mode": "paper", "max_position_pct": 5, "max_daily_exposure_pct": 25, "min_liquidity_usd": 50000}'::jsonb),
('risk', '{"stop_loss_pct": 20, "take_profit_levels": [{"pct": 50, "sell": 50}, {"pct": 100, "sell": 25}], "circuit_breaker_failures": 3}'::jsonb),
('signals', '{"min_signal_score": 60, "auto_execute_min_score": 80}'::jsonb)
ON CONFLICT (key) DO NOTHING;
