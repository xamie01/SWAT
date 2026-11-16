-- 072: forward package19 risk contract. UNAPPLIED; no enabled/ready seed,
-- liability backfill, price authority or approval of an epoch writer is implied.
DO $$ BEGIN
  IF current_user <> 'swat_migrator' OR session_user <> 'swat_migrator' THEN RAISE EXCEPTION 'risk migration requires separate migrator'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = 'swat_risk_writer'
    AND NOT (r.rolcanlogin OR r.rolsuper OR r.rolbypassrls OR r.rolinherit OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication)
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid OR m.roleid = r.oid)
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE relowner = r.oid)
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc WHERE proowner = r.oid)
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspowner = r.oid)
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datdba = r.oid)) THEN
    RAISE EXCEPTION 'provision isolated non-owning swat_risk_writer capability before migration';
  END IF;
END $$;
CREATE TABLE public.risk_policy_control (
  account varchar(128) NOT NULL CHECK (account = 'operator' OR account ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'),
  chain varchar(64) NOT NULL CHECK (chain IN ('solana','polygon','robinhood-chain')),
  execution_mode varchar(16) NOT NULL CHECK (execution_mode IN ('paper','live','shadow')),
  epoch bigint NOT NULL CHECK (epoch > 0),
  enabled boolean NOT NULL DEFAULT false,
  cap_usd numeric(38,18) NOT NULL CHECK (cap_usd > 0 AND cap_usd <> 'NaN'::numeric),
  accounting_ready boolean NOT NULL DEFAULT false,
  PRIMARY KEY (account,chain,execution_mode)
);
CREATE TABLE public.risk_spend_reservations (
  account varchar(128) NOT NULL,
  chain varchar(64) NOT NULL,
  execution_mode varchar(16) NOT NULL,
  execution_id uuid NOT NULL REFERENCES public.copy_executions(id) ON DELETE RESTRICT,
  policy_epoch bigint NOT NULL CHECK (policy_epoch > 0),
  requested_usd numeric(38,18) NOT NULL CHECK (requested_usd > 0 AND requested_usd <> 'NaN'::numeric),
  confirmed_usd numeric(38,18) NOT NULL DEFAULT 0 CHECK (confirmed_usd >= 0 AND confirmed_usd <> 'NaN'::numeric),
  liability_usd numeric(38,18) NOT NULL CHECK (liability_usd >= confirmed_usd AND liability_usd <> 'NaN'::numeric),
  state varchar(16) NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','submitted','unknown','partial','confirmed','released')),
  reserved_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  PRIMARY KEY (account,chain,execution_mode,execution_id),
  UNIQUE (execution_id),
  FOREIGN KEY (account,chain,execution_mode) REFERENCES public.risk_policy_control ON DELETE RESTRICT,
  CHECK ((state IN ('confirmed','released')) = (settled_at IS NOT NULL)),
  CHECK (state IN ('confirmed','released') OR liability_usd >= requested_usd),
  CHECK (state <> 'released' OR (confirmed_usd = 0 AND liability_usd = 0)),
  CHECK (state <> 'confirmed' OR liability_usd = confirmed_usd)
);
CREATE INDEX package19_risk_spend_open ON public.risk_spend_reservations(account,chain,execution_mode,settled_at);
CREATE INDEX risk_spend_recent_terminal ON public.risk_spend_reservations(settled_at) WHERE settled_at IS NOT NULL;

CREATE FUNCTION public.guard_risk_policy_control() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF current_user <> 'swat_risk_writer' AND NOT public.is_rls_bypassed() THEN
    RAISE EXCEPTION 'only separately authenticated risk writer may change control';
  END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'risk control history anchor cannot be deleted'; END IF;
  IF NEW.account IS DISTINCT FROM OLD.account OR NEW.chain IS DISTINCT FROM OLD.chain
    OR NEW.execution_mode IS DISTINCT FROM OLD.execution_mode OR NEW.epoch < OLD.epoch
    OR ((NEW.enabled IS DISTINCT FROM OLD.enabled OR NEW.cap_usd IS DISTINCT FROM OLD.cap_usd
      OR NEW.accounting_ready IS DISTINCT FROM OLD.accounting_ready) AND NEW.epoch <= OLD.epoch) THEN
    RAISE EXCEPTION 'risk control identity immutable; policy changes require advancing durable epoch';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER risk_policy_control_guard BEFORE UPDATE OR DELETE ON public.risk_policy_control FOR EACH ROW EXECUTE FUNCTION public.guard_risk_policy_control();
CREATE FUNCTION public.guard_risk_reservation() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'risk liability cannot be deleted'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.account IS DISTINCT FROM OLD.account OR NEW.chain IS DISTINCT FROM OLD.chain
      OR NEW.execution_mode IS DISTINCT FROM OLD.execution_mode OR NEW.execution_id IS DISTINCT FROM OLD.execution_id
      OR NEW.policy_epoch IS DISTINCT FROM OLD.policy_epoch OR NEW.requested_usd IS DISTINCT FROM OLD.requested_usd
      OR NEW.reserved_at IS DISTINCT FROM OLD.reserved_at OR NEW.confirmed_usd < OLD.confirmed_usd
      OR (OLD.state IN ('confirmed','released') AND NEW IS DISTINCT FROM OLD)
      OR (OLD.state <> 'reserved' AND NEW.state IN ('reserved','released'))
      OR (NEW.state NOT IN ('confirmed','released') AND NEW.liability_usd < OLD.liability_usd) THEN
      RAISE EXCEPTION 'risk immutable terms/terminal state/retained liability violated';
    END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.copy_executions e WHERE e.id = NEW.execution_id
    AND COALESCE(e.user_id::text,'operator') = NEW.account AND e.chain = NEW.chain
    AND e.execution_mode = NEW.execution_mode AND e.direction = 'buy') THEN
    RAISE EXCEPTION 'risk reservation canonical execution scope mismatch';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER risk_reservation_guard BEFORE INSERT OR UPDATE OR DELETE ON public.risk_spend_reservations FOR EACH ROW EXECUTE FUNCTION public.guard_risk_reservation();
REVOKE ALL ON FUNCTION public.guard_risk_policy_control(),public.guard_risk_reservation() FROM PUBLIC,swat_app,swat_risk_writer;

ALTER TABLE public.risk_policy_control ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.risk_policy_control FORCE ROW LEVEL SECURITY;
ALTER TABLE public.risk_spend_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.risk_spend_reservations FORCE ROW LEVEL SECURITY;
CREATE POLICY risk_writer ON public.risk_policy_control TO swat_risk_writer
  USING (current_user = 'swat_risk_writer' AND session_user = 'swat_risk_writer')
  WITH CHECK (current_user = 'swat_risk_writer' AND session_user = 'swat_risk_writer');
CREATE POLICY risk_control_tenant ON public.risk_policy_control TO swat_app
  USING (account = public.current_app_user_id()::text) WITH CHECK (account = public.current_app_user_id()::text);
CREATE POLICY risk_reservation_tenant ON public.risk_spend_reservations TO swat_app
  USING (account = public.current_app_user_id()::text) WITH CHECK (account = public.current_app_user_id()::text);
CREATE POLICY risk_control_migration ON public.risk_policy_control TO swat_migrator USING (public.is_rls_bypassed()) WITH CHECK (public.is_rls_bypassed());
CREATE POLICY risk_reservation_migration ON public.risk_spend_reservations TO swat_migrator USING (public.is_rls_bypassed()) WITH CHECK (public.is_rls_bypassed());
REVOKE ALL ON public.risk_policy_control,public.risk_spend_reservations FROM PUBLIC,swat_app,swat_risk_writer;
GRANT USAGE ON SCHEMA public TO swat_risk_writer;
GRANT SELECT,INSERT ON public.risk_policy_control TO swat_risk_writer;
GRANT UPDATE (epoch,enabled,cap_usd,accounting_ready) ON public.risk_policy_control TO swat_risk_writer;
GRANT SELECT ON public.risk_policy_control,public.risk_spend_reservations TO swat_app;
-- SELECT FOR UPDATE requires UPDATE privilege/policy. The trigger above denies
-- actual tenant UPDATE, including epoch-only/no-op updates, without writer identity.
GRANT UPDATE (epoch) ON public.risk_policy_control TO swat_app;
GRANT INSERT ON public.risk_spend_reservations TO swat_app;
GRANT UPDATE (state,confirmed_usd,liability_usd,settled_at) ON public.risk_spend_reservations TO swat_app;
-- Operator/global risk, authorized writer adapter, accounting coverage and valued
-- receipt reconciliation remain separate review/runtime prerequisites.
