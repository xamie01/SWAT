-- G6-A8: End-to-end latency tracking
ALTER TABLE signals
ADD COLUMN IF NOT EXISTS detected_at TIMESTAMPTZ;

ALTER TABLE trades
ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ;
