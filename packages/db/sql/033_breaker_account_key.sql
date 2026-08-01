-- 033_breaker_account_key.sql
-- Copy existing chain-keyed breaker rows to operator-scoped keys.
-- Idempotent: uses ON CONFLICT DO NOTHING so it can be replayed safely.
-- `config` has no created_at column (see 001_init.sql), so only updated_at is set.

INSERT INTO config(key, value, updated_at)
SELECT 'breaker:operator:solana', value, NOW()
FROM config
WHERE key = 'breaker:solana'
ON CONFLICT (key) DO NOTHING;

INSERT INTO config(key, value, updated_at)
SELECT 'breaker:operator:polygon', value, NOW()
FROM config
WHERE key = 'breaker:polygon'
ON CONFLICT (key) DO NOTHING;

INSERT INTO config(key, value, updated_at)
SELECT 'breaker:operator:robinhood-chain', value, NOW()
FROM config
WHERE key = 'breaker:robinhood-chain'
ON CONFLICT (key) DO NOTHING;
