-- 071: forward durable fanout source. UNAPPLIED; no source-verifier authority.
-- Prerequisite: independently provisioned NOLOGIN swat_fanout capability, later
-- authenticated through a reviewed dedicated adapter (NOT the swat_app pool).
DO $$ BEGIN
  IF current_user <> 'swat_migrator' OR session_user <> 'swat_migrator' THEN
    RAISE EXCEPTION 'fanout migration requires the separate migrator';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = 'swat_fanout'
    AND NOT (r.rolcanlogin OR r.rolsuper OR r.rolbypassrls OR r.rolinherit OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication)
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid OR m.roleid = r.oid)
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE relowner = r.oid)
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc WHERE proowner = r.oid)
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspowner = r.oid)
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datdba = r.oid)) THEN
    RAISE EXCEPTION 'provision isolated non-owning swat_fanout capability before migration';
  END IF;
END $$;

CREATE FUNCTION public.valid_fanout_snapshot(recipients jsonb, exclusions jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE item jsonb; operators integer := 0;
BEGIN
  IF recipients IS NULL OR exclusions IS NULL OR jsonb_typeof(recipients) <> 'array'
    OR jsonb_typeof(exclusions) <> 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(recipients) > 1001 OR jsonb_array_length(exclusions) > 1001 THEN RETURN false; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(recipients) LOOP
    IF jsonb_typeof(item) <> 'object' OR NOT item ? 'userId'
      OR NOT item ? 'signalId' OR NOT item ? 'executionMode' OR NOT item ? 'targetAccount'
      OR NOT item ? 'jobId' OR jsonb_typeof(item->'descriptor') IS DISTINCT FROM 'object' THEN RETURN false; END IF;
    IF item->'userId' = 'null'::jsonb THEN operators := operators + 1;
    ELSIF jsonb_typeof(item->'userId') <> 'string' OR (item->>'userId') !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' THEN RETURN false;
    END IF;
  END LOOP;
  FOR item IN SELECT value FROM jsonb_array_elements(exclusions) LOOP
    IF jsonb_typeof(item) <> 'object' OR NOT item ? 'userId' OR jsonb_typeof(item->'code') IS DISTINCT FROM 'string'
      OR length(item->>'code') NOT BETWEEN 1 AND 128 OR item->>'code' <> btrim(item->>'code') THEN RETURN false; END IF;
    IF item->'userId' = 'null'::jsonb THEN operators := operators + 1;
    ELSIF jsonb_typeof(item->'userId') <> 'string' OR (item->>'userId') !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' THEN RETURN false;
    END IF;
  END LOOP;
  RETURN operators = 1;
END $$;
REVOKE ALL ON FUNCTION public.valid_fanout_snapshot(jsonb,jsonb) FROM PUBLIC, swat_app;
GRANT EXECUTE ON FUNCTION public.valid_fanout_snapshot(jsonb,jsonb) TO swat_fanout;

CREATE TABLE public.source_fanout_batches (
  signal_id uuid PRIMARY KEY,
  source_trade_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','enumerating','complete')),
  fence bigint NOT NULL DEFAULT 0 CHECK (fence >= 0),
  lease_owner text CHECK (length(lease_owner) BETWEEN 1 AND 128 AND lease_owner = btrim(lease_owner)),
  lease_until timestamptz,
  recipient_snapshot jsonb,
  exclusion_snapshot jsonb,
  last_error text CHECK (length(last_error) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (signal_id,source_trade_id) REFERENCES public.signals(id,source_trade_id) ON DELETE RESTRICT,
  CHECK ((lease_owner IS NULL) = (lease_until IS NULL)),
  CHECK ((state = 'enumerating') = (lease_owner IS NOT NULL)),
  CHECK ((state = 'complete') = (recipient_snapshot IS NOT NULL)),
  CHECK ((recipient_snapshot IS NULL) = (exclusion_snapshot IS NULL)),
  CHECK (recipient_snapshot IS NULL OR public.valid_fanout_snapshot(recipient_snapshot,exclusion_snapshot))
);
CREATE TABLE public.source_fanout_deliveries (
  signal_id uuid NOT NULL REFERENCES public.source_fanout_batches(signal_id) ON DELETE RESTRICT,
  user_id uuid REFERENCES public.users(id) ON DELETE RESTRICT,
  execution_mode text NOT NULL CHECK (execution_mode IN ('paper','live','shadow')),
  target_account varchar(128) NOT NULL CHECK (target_account = btrim(target_account) AND target_account ~ '^(solana|polygon|robinhood-chain|ethereum|base|arbitrum):[^[:space:]:]+$'),
  job_id text NOT NULL CHECK (length(job_id) BETWEEN 1 AND 256 AND job_id = btrim(job_id)),
  descriptor jsonb NOT NULL CHECK (jsonb_typeof(descriptor) = 'object'),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','queued','claimed','blocked','reconciliation_required','completed')),
  fence bigint NOT NULL DEFAULT 0 CHECK (fence >= 0),
  lease_owner text CHECK (length(lease_owner) BETWEEN 1 AND 128 AND lease_owner = btrim(lease_owner)),
  lease_until timestamptz,
  execution_id uuid REFERENCES public.copy_executions(id) ON DELETE RESTRICT,
  last_reason text CHECK (length(last_reason) BETWEEN 1 AND 2000),
  queued_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (signal_id,user_id,execution_mode,target_account),
  UNIQUE (signal_id,job_id),
  CHECK ((lease_owner IS NULL) = (lease_until IS NULL)),
  CHECK ((state = 'claimed') = (lease_owner IS NOT NULL)),
  CHECK (state <> 'completed' OR execution_id IS NOT NULL),
  CHECK (jsonb_typeof(descriptor->'data') IS NOT DISTINCT FROM 'object'
    AND jsonb_typeof(descriptor->'options') IS NOT DISTINCT FROM 'object'
    AND descriptor->>'chain' IS NOT DISTINCT FROM split_part(target_account,':',1)
    AND descriptor->'data'->>'signalId' IS NOT DISTINCT FROM signal_id::text
    AND descriptor->'data'->>'userId' IS NOT DISTINCT FROM user_id::text
    AND (user_id IS NULL OR descriptor->'data'->>'executionMode' IS NOT DISTINCT FROM execution_mode)
    AND descriptor->'options'->>'jobId' IS NOT DISTINCT FROM job_id)
);
CREATE INDEX source_fanout_enumeration_repair ON public.source_fanout_batches(created_at,signal_id) WHERE state <> 'complete';
CREATE INDEX source_fanout_delivery_repair ON public.source_fanout_deliveries(state,updated_at,signal_id) WHERE state <> 'completed';
CREATE INDEX source_fanout_delivery_tenant ON public.source_fanout_deliveries(user_id,signal_id);
CREATE INDEX source_fanout_delivery_execution ON public.source_fanout_deliveries(execution_id) WHERE execution_id IS NOT NULL;

CREATE FUNCTION public.reject_source_fanout_snapshot_mutation() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'durable fanout obligations cannot be deleted'; END IF;
  IF TG_TABLE_NAME = 'source_fanout_batches' THEN
    IF NEW.signal_id IS DISTINCT FROM OLD.signal_id OR NEW.source_trade_id IS DISTINCT FROM OLD.source_trade_id
      OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.fence < OLD.fence
      OR (OLD.state = 'complete' AND (NEW.state IS DISTINCT FROM OLD.state
        OR NEW.recipient_snapshot IS DISTINCT FROM OLD.recipient_snapshot OR NEW.exclusion_snapshot IS DISTINCT FROM OLD.exclusion_snapshot)) THEN
      RAISE EXCEPTION 'committed fanout identity/snapshot is immutable';
    END IF;
  ELSE
    IF NEW.signal_id IS DISTINCT FROM OLD.signal_id OR NEW.user_id IS DISTINCT FROM OLD.user_id
      OR NEW.execution_mode IS DISTINCT FROM OLD.execution_mode OR NEW.target_account IS DISTINCT FROM OLD.target_account
      OR NEW.job_id IS DISTINCT FROM OLD.job_id OR NEW.descriptor IS DISTINCT FROM OLD.descriptor OR NEW.fence < OLD.fence
      OR (OLD.execution_id IS NOT NULL AND NEW.execution_id IS DISTINCT FROM OLD.execution_id)
      OR (OLD.state = 'completed' AND NEW.state IS DISTINCT FROM OLD.state)
      OR (OLD.state = 'reconciliation_required' AND NEW.state NOT IN ('reconciliation_required','completed')) THEN
      RAISE EXCEPTION 'fanout delivery identity/descriptor/outcome is immutable';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER source_fanout_batch_immutable BEFORE UPDATE OR DELETE ON public.source_fanout_batches FOR EACH ROW EXECUTE FUNCTION public.reject_source_fanout_snapshot_mutation();
CREATE TRIGGER source_fanout_delivery_immutable BEFORE UPDATE OR DELETE ON public.source_fanout_deliveries FOR EACH ROW EXECUTE FUNCTION public.reject_source_fanout_snapshot_mutation();

-- Deferred: cohort and every obligation must exist in the SAME committed transaction.
CREATE FUNCTION public.check_source_fanout_cohort() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE batch public.source_fanout_batches%ROWTYPE; item jsonb; expected integer;
BEGIN
  SELECT * INTO batch FROM public.source_fanout_batches WHERE signal_id = NEW.signal_id;
  IF batch.state IS DISTINCT FROM 'complete' THEN
    IF TG_TABLE_NAME = 'source_fanout_deliveries' THEN RAISE EXCEPTION 'delivery requires committed cohort'; END IF;
    RETURN NULL;
  END IF;
  expected := jsonb_array_length(batch.recipient_snapshot);
  IF (SELECT count(*) FROM public.source_fanout_deliveries WHERE signal_id = batch.signal_id) <> expected THEN
    RAISE EXCEPTION 'fanout cohort obligations differ from immutable snapshot';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(batch.recipient_snapshot) LOOP
    IF item->>'signalId' IS DISTINCT FROM batch.signal_id::text
      OR item->'descriptor'->'data'->>'sourceTradeId' IS DISTINCT FROM batch.source_trade_id::text
      OR NOT EXISTS (SELECT 1 FROM public.source_fanout_deliveries d WHERE d.signal_id = batch.signal_id
        AND d.user_id::text IS NOT DISTINCT FROM item->>'userId' AND d.execution_mode = item->>'executionMode'
        AND d.target_account = item->>'targetAccount' AND d.job_id = item->>'jobId' AND d.descriptor = item->'descriptor') THEN
      RAISE EXCEPTION 'fanout snapshot descriptor/source/identity mismatch';
    END IF;
  END LOOP;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER source_fanout_batch_cohort AFTER INSERT OR UPDATE ON public.source_fanout_batches DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_source_fanout_cohort();
-- Only INSERT changes membership; state updates must work under tenant RLS without
-- exposing another recipient's snapshot. Identity UPDATE/DELETE is already fenced.
CREATE CONSTRAINT TRIGGER source_fanout_delivery_cohort AFTER INSERT ON public.source_fanout_deliveries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_source_fanout_cohort();
REVOKE ALL ON FUNCTION public.reject_source_fanout_snapshot_mutation(), public.check_source_fanout_cohort() FROM PUBLIC, swat_app, swat_fanout;

ALTER TABLE public.source_fanout_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.source_fanout_batches FORCE ROW LEVEL SECURITY;
ALTER TABLE public.source_fanout_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.source_fanout_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY fanout_service ON public.source_fanout_batches TO swat_fanout
  USING (current_user = 'swat_fanout' AND session_user = 'swat_fanout')
  WITH CHECK (current_user = 'swat_fanout' AND session_user = 'swat_fanout');
CREATE POLICY fanout_service ON public.source_fanout_deliveries TO swat_fanout
  USING (current_user = 'swat_fanout' AND session_user = 'swat_fanout')
  WITH CHECK (current_user = 'swat_fanout' AND session_user = 'swat_fanout');
CREATE POLICY fanout_tenant ON public.source_fanout_deliveries TO swat_app
  USING (user_id = public.current_app_user_id()) WITH CHECK (user_id = public.current_app_user_id());
CREATE POLICY fanout_migration ON public.source_fanout_batches TO swat_migrator USING (public.is_rls_bypassed()) WITH CHECK (public.is_rls_bypassed());
CREATE POLICY fanout_migration ON public.source_fanout_deliveries TO swat_migrator USING (public.is_rls_bypassed()) WITH CHECK (public.is_rls_bypassed());
REVOKE ALL ON public.source_fanout_batches, public.source_fanout_deliveries FROM PUBLIC, swat_app, swat_fanout;
GRANT USAGE ON SCHEMA public TO swat_fanout;
GRANT SELECT, INSERT, UPDATE ON public.source_fanout_batches, public.source_fanout_deliveries TO swat_fanout;
GRANT SELECT ON public.source_fanout_deliveries TO swat_app;
GRANT UPDATE (state,fence,lease_owner,lease_until,execution_id,last_reason,queued_at,updated_at) ON public.source_fanout_deliveries TO swat_app;
-- Existing signals/source/evidence/settings privileges are NOT expanded here.
-- Cross-tenant enumeration requires a separately reviewed read capability adapter.
