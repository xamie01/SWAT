-- 035_copy_eligibility_policy.sql
-- Durable record of why a signal was refused at the canonical copy-execution
-- claim boundary, one row per (account, signal).
--
-- The reason has to outlive the process that decided it: `signals.status` alone
-- says a signal was rejected but not which gate rejected it, so an operator
-- reading the table after the fact cannot tell a paused source wallet from a
-- dormant one. The primary key is (account, signal_id) because eligibility is
-- account-scoped (Standing Rule 2) — the same signal can be copyable for one
-- account and not another.
--
-- Idempotent: CREATE ... IF NOT EXISTS only, no data rewrite.

CREATE TABLE IF NOT EXISTS copy_eligibility_rejections (
  account        VARCHAR(64)  NOT NULL DEFAULT 'operator',
  signal_id      UUID         NOT NULL REFERENCES signals(id),
  chain          VARCHAR(32)  NOT NULL,
  wallet_address VARCHAR(100),
  reasons        TEXT[]       NOT NULL,
  rejected_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account, signal_id)
);

CREATE INDEX IF NOT EXISTS idx_copy_eligibility_rejections_rejected
  ON copy_eligibility_rejections(rejected_at DESC);
