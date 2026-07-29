INSERT INTO config (key, value) VALUES
  ('breaker:solana', '{"consecutiveFailures":0,"trippedAt":null}'::jsonb),
  ('breaker:polygon', '{"consecutiveFailures":0,"trippedAt":null}'::jsonb),
  ('breaker:robinhood-chain', '{"consecutiveFailures":0,"trippedAt":null}'::jsonb)
ON CONFLICT (key) DO NOTHING;
