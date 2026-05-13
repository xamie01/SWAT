-- Schema Alignment Migration
-- Adds missing columns specified in the project roadmap

-- wallets
ALTER TABLE wallets ADD COLUMN IF NOT EXISTS priority VARCHAR(20) DEFAULT 'normal';

-- tokens
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS mint_authority_disabled BOOLEAN DEFAULT FALSE;
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS freeze_authority_disabled BOOLEAN DEFAULT FALSE;

-- wallet_clusters
ALTER TABLE wallet_clusters ADD COLUMN IF NOT EXISTS cluster_type VARCHAR(20);

-- signals
ALTER TABLE signals ADD COLUMN IF NOT EXISTS safety_flags TEXT[];
ALTER TABLE signals ADD COLUMN IF NOT EXISTS safety_warnings TEXT[];
ALTER TABLE signals ADD COLUMN IF NOT EXISTS alerted_at TIMESTAMP;

-- trades
ALTER TABLE trades ADD COLUMN IF NOT EXISTS execution_mode VARCHAR(10);
ALTER TABLE trades ADD COLUMN IF NOT EXISTS executor VARCHAR(20);
ALTER TABLE trades ADD COLUMN IF NOT EXISTS amount_sol DECIMAL(16,8);

-- discovery_log
CREATE TABLE IF NOT EXISTS discovery_log (
  id BIGSERIAL PRIMARY KEY,
  source VARCHAR(20) NOT NULL,
  seed_value VARCHAR(100),
  wallets_discovered INTEGER DEFAULT 0,
  ran_at TIMESTAMP DEFAULT NOW()
);
