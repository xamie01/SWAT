-- 073: forward notification/discovery obligations. UNAPPLIED.
-- Transport containment only; no historical repair or external exactly-once proof.
DO $$ DECLARE name text;
BEGIN
  IF current_user <> 'swat_migrator' OR session_user <> 'swat_migrator' THEN RAISE EXCEPTION 'delivery migration requires separate migrator'; END IF;
  FOREACH name IN ARRAY ARRAY['swat_notification','swat_discovery'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = name
      AND NOT (r.rolcanlogin OR r.rolsuper OR r.rolbypassrls OR r.rolinherit OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication)
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid OR m.roleid = r.oid)
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE relowner = r.oid)
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc WHERE proowner = r.oid)
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspowner = r.oid)
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datdba = r.oid)) THEN
      RAISE EXCEPTION 'provision isolated non-owning % capability before migration',name;
    END IF;
  END LOOP;
END $$;
CREATE TABLE public.signal_notification_deliveries (
  signal_id uuid PRIMARY KEY REFERENCES public.signals(id) ON DELETE RESTRICT,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','preparing','sending','delivered','uncertain')),
  owner_token text CHECK (length(owner_token) BETWEEN 1 AND 128 AND owner_token = btrim(owner_token)),
  lease_expires_at timestamptz,
  delivered_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (state NOT IN ('preparing','sending','uncertain') OR (owner_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK (state <> 'pending' OR (owner_token IS NULL AND lease_expires_at IS NULL)),
  CHECK (state <> 'delivered' OR lease_expires_at IS NULL),
  CHECK (delivered_at IS NULL OR state = 'delivered')
  -- A historical alerted_at withholds sends but does not invent delivered_at.
);
CREATE INDEX signal_notification_recovery ON public.signal_notification_deliveries(updated_at,signal_id) WHERE state IN ('pending','preparing');
CREATE INDEX signal_notification_uncertain ON public.signal_notification_deliveries(lease_expires_at,signal_id) WHERE state IN ('sending','uncertain');
CREATE TABLE public.discovery_backfill_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_address text NOT NULL UNIQUE REFERENCES public.wallets(address) ON DELETE RESTRICT,
  chain text NOT NULL CHECK (chain IN ('solana','polygon','robinhood-chain')),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','enqueued')),
  created_at timestamptz NOT NULL DEFAULT now(),
  enqueued_at timestamptz,
  owner_token text CHECK (length(owner_token) BETWEEN 1 AND 128 AND owner_token = btrim(owner_token)),
  lease_expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (wallet_address ~ ('^' || chain || ':[^[:space:]:]+$')),
  CHECK ((owner_token IS NULL) = (lease_expires_at IS NULL)),
  CHECK ((state = 'pending' AND enqueued_at IS NULL) OR
    (state = 'enqueued' AND enqueued_at IS NOT NULL))
  -- Both pending/enqueued may hold a repair lease. Owner-fenced ack clears it;
  -- release only clears the same owner, never deletes/resets queue acceptance.
);
CREATE INDEX discovery_backfill_pending ON public.discovery_backfill_intents(created_at,id) WHERE state = 'pending';
CREATE INDEX discovery_backfill_lease_repair ON public.discovery_backfill_intents(state,lease_expires_at,created_at,id);
CREATE INDEX discovery_backfill_due_repair ON public.discovery_backfill_intents(updated_at,created_at,id);
CREATE FUNCTION public.guard_notification_obligation() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'notification obligation cannot be deleted'; END IF;
  IF NEW.signal_id IS DISTINCT FROM OLD.signal_id
    OR (OLD.state = 'delivered' AND NEW IS DISTINCT FROM OLD)
    OR (OLD.state IN ('sending','uncertain') AND (NEW.state NOT IN ('sending','uncertain','delivered') OR NEW.owner_token IS DISTINCT FROM OLD.owner_token))
    OR (OLD.state = 'uncertain' AND NEW.state = 'sending') THEN
    RAISE EXCEPTION 'notification identity/uncertain send cannot be reset';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER notification_obligation_guard BEFORE UPDATE OR DELETE ON public.signal_notification_deliveries FOR EACH ROW EXECUTE FUNCTION public.guard_notification_obligation();
CREATE FUNCTION public.guard_discovery_obligation() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'discovery obligation cannot be deleted'; END IF;
  IF TG_OP = 'UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.wallet_address IS DISTINCT FROM OLD.wallet_address
    OR NEW.chain IS DISTINCT FROM OLD.chain OR NEW.created_at IS DISTINCT FROM OLD.created_at) THEN
    RAISE EXCEPTION 'discovery immutable wallet/chain identity';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.wallets w WHERE w.address = NEW.wallet_address AND w.chain = NEW.chain) THEN
    RAISE EXCEPTION 'discovery wallet chain mismatch';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER discovery_obligation_guard BEFORE INSERT OR UPDATE OR DELETE ON public.discovery_backfill_intents FOR EACH ROW EXECUTE FUNCTION public.guard_discovery_obligation();
REVOKE ALL ON FUNCTION public.guard_notification_obligation(),public.guard_discovery_obligation() FROM PUBLIC,swat_app,swat_notification,swat_discovery;
ALTER TABLE public.signal_notification_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.signal_notification_deliveries FORCE ROW LEVEL SECURITY;
ALTER TABLE public.discovery_backfill_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.discovery_backfill_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY notification_service ON public.signal_notification_deliveries TO swat_notification
  USING (current_user = 'swat_notification' AND session_user = 'swat_notification')
  WITH CHECK (current_user = 'swat_notification' AND session_user = 'swat_notification');
CREATE POLICY discovery_service ON public.discovery_backfill_intents TO swat_discovery
  USING (current_user = 'swat_discovery' AND session_user = 'swat_discovery')
  WITH CHECK (current_user = 'swat_discovery' AND session_user = 'swat_discovery');
CREATE POLICY notification_migration ON public.signal_notification_deliveries TO swat_migrator USING (public.is_rls_bypassed()) WITH CHECK (public.is_rls_bypassed());
CREATE POLICY discovery_migration ON public.discovery_backfill_intents TO swat_migrator USING (public.is_rls_bypassed()) WITH CHECK (public.is_rls_bypassed());
REVOKE ALL ON public.signal_notification_deliveries,public.discovery_backfill_intents FROM PUBLIC,swat_app,swat_notification,swat_discovery;
GRANT USAGE ON SCHEMA public TO swat_notification,swat_discovery;
GRANT SELECT,INSERT,UPDATE ON public.signal_notification_deliveries TO swat_notification;
GRANT SELECT,INSERT,UPDATE ON public.discovery_backfill_intents TO swat_discovery;
-- Narrow existing non-tenant resources needed by the two transport capabilities.
GRANT SELECT (id,alerted_at,status) ON public.signals TO swat_notification;
GRANT UPDATE (alerted_at,status) ON public.signals TO swat_notification;
GRANT SELECT (address,chain) ON public.wallets TO swat_discovery;
GRANT INSERT (address,chain,source,discovery_method) ON public.wallets TO swat_discovery;
-- No tenant tables, DELETE, sequences, SECURITY DEFINER, role memberships or
-- global swat_app grants. Dedicated checked service pools/provisioning remain
-- required; enqueued is queue acceptance, never historical indexing completion.
