-- UNAPPLIED PACKAGE19 CONTRACT PROPOSAL. Not a migration, never executed.
-- Installation, role/RLS policy, authorized epoch writer, old-liability coverage,
-- receipt evidence and runtime stop-barrier acceptance are external prerequisites.
-- No ready/enabled seed: empty or unready policy must refuse new spending.
CREATE TABLE IF NOT EXISTS risk_policy_control (
  account VARCHAR(128) NOT NULL,
  chain VARCHAR(64) NOT NULL,
  execution_mode VARCHAR(16) NOT NULL CHECK (execution_mode IN ('paper','live','shadow')),
  epoch BIGINT NOT NULL CHECK (epoch > 0),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  cap_usd NUMERIC(38,18) NOT NULL CHECK (cap_usd > 0 AND cap_usd <> 'NaN'::numeric),
  accounting_ready BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (account, chain, execution_mode)
);
CREATE TABLE IF NOT EXISTS risk_spend_reservations (
  account VARCHAR(128) NOT NULL,
  chain VARCHAR(64) NOT NULL,
  execution_mode VARCHAR(16) NOT NULL,
  execution_id UUID NOT NULL REFERENCES copy_executions(id) ON DELETE RESTRICT,
  policy_epoch BIGINT NOT NULL CHECK (policy_epoch > 0),
  requested_usd NUMERIC(38,18) NOT NULL CHECK (requested_usd > 0 AND requested_usd <> 'NaN'::numeric),
  confirmed_usd NUMERIC(38,18) NOT NULL DEFAULT 0 CHECK (confirmed_usd >= 0 AND confirmed_usd <> 'NaN'::numeric),
  liability_usd NUMERIC(38,18) NOT NULL CHECK (liability_usd >= confirmed_usd AND liability_usd <> 'NaN'::numeric),
  state VARCHAR(16) NOT NULL DEFAULT 'reserved'
    CHECK (state IN ('reserved','submitted','unknown','partial','confirmed','released')),
  reserved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  settled_at TIMESTAMPTZ,
  PRIMARY KEY (account, chain, execution_mode, execution_id),
  UNIQUE (execution_id),
  FOREIGN KEY (account, chain, execution_mode) REFERENCES risk_policy_control ON DELETE RESTRICT,
  CHECK ((state IN ('confirmed','released')) = (settled_at IS NOT NULL)),
  CHECK (state IN ('confirmed','released') OR liability_usd >= requested_usd),
  CHECK (state <> 'released' OR (confirmed_usd = 0 AND liability_usd = 0))
);
CREATE INDEX IF NOT EXISTS package19_risk_spend_open
  ON risk_spend_reservations (account, chain, execution_mode, settled_at);
-- No grants, seeds or RLS bypass. Default table-owner-only access is NOT tenant
-- acceptance. Integrator must install least-privilege scope policies and require
-- typed evidence-derived updates, immutable terms and monotonic control epochs.
