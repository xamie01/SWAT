-- 033_breaker_account_key.sql
-- Copy existing chain-keyed breaker rows to operator-scoped keys.
-- Idempotent: uses ON CONFLICT DO NOTHING so it can be replayed safely.

INSERT INTO config(key, value, created_at, updated_at)
SELECT 'breaker:operator:solana', value, NOW(), NOW()
FROM config
WHERE key = 'breaker:solana'
ON CONFLICT (key) DO NOTHING;

INSERT INTO config(key, value, created_at, updated_at)
SELECT 'breaker:operator:polygon', value, NOW(), NOW()
FROM config
WHERE key = 'breaker:polygon'
ON CONFLICT (key) DO NOTHING;

INSERT INTO config(key, value, created_at, updated_at)
SELECT 'breaker:operator:robinhood-chain', value, NOW(), NOW()
FROM config
WHERE key = 'breaker:robinhood-chain'
ON CONFLICT (key) DO NOTHING;
