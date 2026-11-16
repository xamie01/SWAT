-- UNAPPLIED PROPOSAL ONLY. Not a migration; never executed by this assignment.
-- Installed functionality remains BLOCKED until reviewed DDL/privileges/RLS,
-- authoritative source verification and transactional runtime wiring exist.
-- Tables intentionally do not widen source confirmation authority.
CREATE TABLE source_fanout_batches (
  signal_id UUID PRIMARY KEY,
  source_trade_id UUID NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'enumerating', 'complete')),
  fence BIGINT NOT NULL DEFAULT 0 CHECK (fence >= 0),
  lease_owner TEXT,
  lease_until TIMESTAMPTZ,
  recipient_snapshot JSONB,
  exclusion_snapshot JSONB,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (signal_id, source_trade_id) REFERENCES signals (id, source_trade_id) ON DELETE RESTRICT,
  CHECK ((lease_owner IS NULL) = (lease_until IS NULL)),
  CHECK ((state = 'enumerating') = (lease_owner IS NOT NULL)),
  CHECK ((state = 'complete') = (recipient_snapshot IS NOT NULL)),
  CHECK (recipient_snapshot IS NULL OR (jsonb_typeof(recipient_snapshot) = 'array' AND jsonb_array_length(recipient_snapshot) BETWEEN 1 AND 1001)),
  CHECK (exclusion_snapshot IS NULL OR (jsonb_typeof(exclusion_snapshot) = 'array' AND jsonb_array_length(exclusion_snapshot) <= 1000))
);

CREATE TABLE source_fanout_deliveries (
  signal_id UUID NOT NULL REFERENCES source_fanout_batches(signal_id) ON DELETE RESTRICT,
  user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  execution_mode TEXT NOT NULL CHECK (execution_mode IN ('paper', 'live', 'shadow')),
  target_account VARCHAR(128) NOT NULL CHECK (length(target_account) > 0 AND target_account = btrim(target_account)),
  job_id TEXT NOT NULL CHECK (length(job_id) BETWEEN 1 AND 256),
  descriptor JSONB NOT NULL CHECK (jsonb_typeof(descriptor) = 'object'),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'queued', 'claimed', 'blocked', 'reconciliation_required', 'completed')),
  fence BIGINT NOT NULL DEFAULT 0 CHECK (fence >= 0),
  lease_owner TEXT,
  lease_until TIMESTAMPTZ,
  execution_id UUID REFERENCES copy_executions(id) ON DELETE RESTRICT,
  last_reason TEXT,
  queued_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE NULLS NOT DISTINCT (signal_id, user_id, execution_mode, target_account),
  UNIQUE (signal_id, job_id),
  CHECK ((lease_owner IS NULL) = (lease_until IS NULL)),
  CHECK (state <> 'claimed' OR lease_owner IS NOT NULL),
  CHECK (state <> 'completed' OR execution_id IS NOT NULL)
);
CREATE INDEX source_fanout_delivery_repair ON source_fanout_deliveries (state, updated_at, signal_id) WHERE state <> 'completed';

-- Committed cohort/identity and descriptors must never be replaced by retry enumeration.
CREATE FUNCTION reject_source_fanout_snapshot_mutation() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'source_fanout_batches' THEN
    IF NEW.signal_id IS DISTINCT FROM OLD.signal_id OR NEW.source_trade_id IS DISTINCT FROM OLD.source_trade_id
       OR (OLD.state = 'complete' AND (NEW.state IS DISTINCT FROM OLD.state OR NEW.recipient_snapshot IS DISTINCT FROM OLD.recipient_snapshot OR NEW.exclusion_snapshot IS DISTINCT FROM OLD.exclusion_snapshot)) THEN
      RAISE EXCEPTION 'committed fanout identity/snapshot is immutable';
    END IF;
  ELSE
    IF NEW.signal_id IS DISTINCT FROM OLD.signal_id OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.execution_mode IS DISTINCT FROM OLD.execution_mode OR NEW.target_account IS DISTINCT FROM OLD.target_account OR NEW.job_id IS DISTINCT FROM OLD.job_id OR NEW.descriptor IS DISTINCT FROM OLD.descriptor THEN
      RAISE EXCEPTION 'fanout delivery identity/descriptor is immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER source_fanout_batch_immutable BEFORE UPDATE ON source_fanout_batches FOR EACH ROW EXECUTE FUNCTION reject_source_fanout_snapshot_mutation();
CREATE TRIGGER source_fanout_delivery_immutable BEFORE UPDATE ON source_fanout_deliveries FOR EACH ROW EXECUTE FUNCTION reject_source_fanout_snapshot_mutation();
-- No grants, RLS deployment or historical data repair is proposed/applied here.
