-- G6-A10: Preserve chain identity in cross-chain clustering
ALTER TABLE wallet_clusters
ADD COLUMN IF NOT EXISTS chain VARCHAR(32) NOT NULL DEFAULT 'solana';

-- Add an index for faster lookups per-chain
CREATE INDEX IF NOT EXISTS idx_wallet_clusters_chain ON wallet_clusters(chain);
