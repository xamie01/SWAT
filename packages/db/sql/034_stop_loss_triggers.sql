-- 034_stop_loss_triggers.sql
-- Durable record of stop-loss exits, one row per (account, signal).
-- The primary key is the idempotency guard: a breached position can only ever
-- claim a trigger once, so the sweep emits exactly one closing sell.
-- Idempotent: CREATE ... IF NOT EXISTS only, no data rewrite.

CREATE TABLE IF NOT EXISTS signal_stop_losses (
  account             VARCHAR(64)   NOT NULL DEFAULT 'operator',
  signal_id           UUID          NOT NULL REFERENCES signals(id),
  chain               VARCHAR(32)   NOT NULL,
  token_mint          VARCHAR(100)  NOT NULL,
  threshold_pct       DECIMAL(9,4)  NOT NULL,
  drawdown_pct        DECIMAL(12,4) NOT NULL,
  open_quantity       DECIMAL(38,18) NOT NULL,
  open_cost_basis_usd DECIMAL(20,6) NOT NULL,
  price_usd           DECIMAL(38,18),
  triggered_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account, signal_id)
);

CREATE INDEX IF NOT EXISTS idx_signal_stop_losses_triggered
  ON signal_stop_losses(triggered_at DESC);
