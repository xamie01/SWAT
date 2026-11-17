-- 074: canonical worker foundation. FORWARD ONLY, NOT APPLIED.
-- No live grant, source verifier, price provider, risk writer or runtime role
-- capability is installed here. Missing policy snapshots refuse legacy work.
DO $$ BEGIN
  IF current_user <> 'swat_migrator' OR session_user <> 'swat_migrator' THEN
    RAISE EXCEPTION 'worker migration requires separate migrator';
  END IF;
END $$;
ALTER TABLE public.master_capacity_ledger ADD COLUMN unassessed_fill_count bigint NOT NULL DEFAULT 0
  CHECK (unassessed_fill_count >= 0);
ALTER TABLE public.copy_execution_evidence ADD COLUMN fee_usd numeric(38,18)
  CHECK (fee_usd IS NULL OR (fee_usd >= 0 AND fee_usd <> 'NaN'::numeric));
CREATE OR REPLACE FUNCTION public.reject_copy_evidence_payload_mutation() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['confirmation_state','confirmation_updated_at'])
    IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['confirmation_state','confirmation_updated_at']) THEN
    RAISE EXCEPTION 'copy execution evidence payload including fee is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TABLE public.copy_execution_policy_snapshots (
  execution_id uuid PRIMARY KEY REFERENCES public.copy_executions(id) ON DELETE RESTRICT,
  user_id uuid REFERENCES public.users(id) ON DELETE RESTRICT,
  chain varchar(64) NOT NULL,
  target_account varchar(100) NOT NULL,
  token_mint varchar(100) NOT NULL,
  master_wallet_address varchar(100) NOT NULL,
  execution_mode varchar(16) NOT NULL CHECK (execution_mode IN ('paper','live','shadow')),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  minimum_score numeric NOT NULL CHECK (minimum_score BETWEEN 0 AND 100),
  captured_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.copy_execution_worker_attempts (
  execution_id uuid PRIMARY KEY REFERENCES public.copy_executions(id) ON DELETE RESTRICT,
  user_id uuid REFERENCES public.users(id) ON DELETE RESTRICT,
  policy_revision varchar(64) NOT NULL,
  risk_epoch bigint CHECK (risk_epoch > 0),
  fence bigint NOT NULL DEFAULT 1 CHECK (fence > 0),
  state varchar(32) NOT NULL DEFAULT 'prepared' CHECK (state IN ('prepared','dispatched','settled','unknown')),
  prepared_at timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz,
  settled_at timestamptz
);
CREATE FUNCTION public.guard_worker_policy_snapshot() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'canonical captured policy is immutable'; END IF;
  -- No approved capture writer exists. Ordinary app INSERT cannot manufacture
  -- an opted-in policy snapshot. Provision a reviewed capability separately.
  IF NOT public.is_rls_bypassed() THEN RAISE EXCEPTION 'approved policy capture writer unavailable'; END IF;
  IF (NEW.snapshot->'scope'->>'account') IS DISTINCT FROM COALESCE(NEW.user_id::text,'operator')
    OR (NEW.snapshot->'scope'->>'chain') IS DISTINCT FROM NEW.chain
    OR (NEW.snapshot->'scope'->>'tokenMint') IS DISTINCT FROM NEW.token_mint
    OR (NEW.snapshot->'scope'->>'masterWalletAddress') IS DISTINCT FROM NEW.master_wallet_address THEN
    RAISE EXCEPTION 'captured policy JSON scope mismatch';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.copy_executions e WHERE e.id = NEW.execution_id
    AND e.user_id IS NOT DISTINCT FROM NEW.user_id AND e.chain = NEW.chain
    AND e.target_account = NEW.target_account AND e.token_mint = NEW.token_mint
    AND e.execution_mode = NEW.execution_mode) THEN RAISE EXCEPTION 'captured policy execution scope mismatch'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER worker_policy_snapshot_guard BEFORE INSERT OR UPDATE OR DELETE ON public.copy_execution_policy_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.guard_worker_policy_snapshot();
CREATE FUNCTION public.guard_worker_attempt() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'worker fence cannot be deleted'; END IF;
  IF TG_OP = 'UPDATE' AND (NEW.execution_id IS DISTINCT FROM OLD.execution_id
    OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.policy_revision IS DISTINCT FROM OLD.policy_revision
    OR NEW.risk_epoch IS DISTINCT FROM OLD.risk_epoch OR NEW.fence IS DISTINCT FROM OLD.fence
    OR NEW.prepared_at IS DISTINCT FROM OLD.prepared_at OR OLD.state IN ('settled','unknown')
    OR (OLD.state = 'dispatched' AND NEW.state NOT IN ('settled','unknown'))) THEN
    RAISE EXCEPTION 'worker immutable identity/fence/terminal state violated';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.copy_executions e WHERE e.id = NEW.execution_id
    AND e.user_id IS NOT DISTINCT FROM NEW.user_id) THEN RAISE EXCEPTION 'worker attempt tenant mismatch'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER worker_attempt_guard BEFORE INSERT OR UPDATE OR DELETE ON public.copy_execution_worker_attempts
  FOR EACH ROW EXECUTE FUNCTION public.guard_worker_attempt();
ALTER TABLE public.copy_execution_policy_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.copy_execution_policy_snapshots FORCE ROW LEVEL SECURITY;
ALTER TABLE public.copy_execution_worker_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.copy_execution_worker_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY worker_policy_tenant ON public.copy_execution_policy_snapshots TO swat_app
  USING (user_id = public.current_app_user_id()) WITH CHECK (user_id = public.current_app_user_id());
CREATE POLICY worker_attempt_tenant ON public.copy_execution_worker_attempts TO swat_app
  USING (user_id = public.current_app_user_id()) WITH CHECK (user_id = public.current_app_user_id());
CREATE POLICY worker_policy_migration ON public.copy_execution_policy_snapshots TO swat_migrator
  USING (public.is_rls_bypassed()) WITH CHECK (public.is_rls_bypassed());
CREATE POLICY worker_attempt_migration ON public.copy_execution_worker_attempts TO swat_migrator
  USING (public.is_rls_bypassed()) WITH CHECK (public.is_rls_bypassed());
REVOKE ALL ON public.copy_execution_policy_snapshots,public.copy_execution_worker_attempts FROM PUBLIC,swat_app;
GRANT SELECT ON public.copy_execution_policy_snapshots TO swat_app;
GRANT SELECT,INSERT ON public.copy_execution_worker_attempts TO swat_app;
-- SELECT FOR SHARE requires UPDATE; the snapshot trigger denies actual changes.
GRANT UPDATE (snapshot) ON public.copy_execution_policy_snapshots TO swat_app;
GRANT UPDATE (state,dispatched_at,settled_at) ON public.copy_execution_worker_attempts TO swat_app;
REVOKE ALL ON FUNCTION public.guard_worker_policy_snapshot(),public.guard_worker_attempt() FROM PUBLIC,swat_app;
-- Receipt/history/source/trading-control/master-capacity roles remain separately
-- blocked under 070. Do not use a migrator session to run the worker.
