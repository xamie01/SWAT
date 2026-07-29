INSERT INTO config (key, value)
VALUES (
  'execution_config',
  '{"solana": "paper", "polygon": "paper", "robinhood-chain": "paper"}'::jsonb
)
ON CONFLICT (key) DO NOTHING;
