-- 070_runtime_role_boundary.sql — forward repair for already-deployed 064. NOT APPLIED.
-- Prerequisite: audited deploy/postgres/roles.sql provisioning, separate migrator
-- ownership, drained runtimes, and an explicit checksummed baseline for legacy DBs.
-- Fail rather than attempting cluster-wide ownership transfer or preserving privileges.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'swat_app' AND NOT rolcanlogin
      AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb
      AND NOT rolreplication AND NOT rolinherit
      AND NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member = pg_roles.oid)
  ) THEN
    RAISE EXCEPTION 'Provision/reconcile isolated swat_app with deploy/postgres/roles.sql first';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE r.rolname = 'swat_app')
    OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner WHERE r.rolname = 'swat_app')
    OR EXISTS (SELECT 1 FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner WHERE r.rolname = 'swat_app') THEN
    RAISE EXCEPTION 'Runtime must not own database objects; explicit ownership audit required';
  END IF;
END $$;

-- Flags are not authority. No unscoped, wildcard, bootstrap-name or app-flag bypass.
CREATE OR REPLACE FUNCTION public.is_rls_bypassed() RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
  SELECT current_user = 'swat_migrator' AND session_user = 'swat_migrator';
$$;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM swat_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM swat_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC, swat_app;
ALTER DEFAULT PRIVILEGES FOR ROLE swat_migrator REVOKE ALL ON TABLES FROM swat_app;
ALTER DEFAULT PRIVILEGES FOR ROLE swat_migrator REVOKE ALL ON SEQUENCES FROM swat_app;
ALTER DEFAULT PRIVILEGES FOR ROLE swat_migrator REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE swat_migrator REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE swat_migrator IN SCHEMA public REVOKE ALL ON TABLES FROM swat_app;
ALTER DEFAULT PRIVILEGES FOR ROLE swat_migrator IN SCHEMA public REVOKE ALL ON SEQUENCES FROM swat_app;

-- Runtime DML only on this reviewed set, with policy installed BEFORE grants.
-- Future/global/auth/admin resources are denied until separately reviewed.
DO $$
DECLARE
  tbl text;
  discriminator text;
  policy_row record;
  tables text[] := ARRAY[
    'users', 'user_sessions', 'user_auth_wallets', 'user_api_keys', 'user_balances',
    'user_wallet_subscriptions', 'user_token_watches', 'user_execution_grants',
    'user_execution_settings', 'user_chain_execution_settings', 'user_payment_intents',
    'crypto_payments', 'copy_positions', 'copy_executions', 'copy_position_master_lots',
    'copy_position_applications', 'copy_position_close_all_claims'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables LOOP
    IF to_regclass(format('public.%I', tbl)) IS NULL THEN
      RAISE EXCEPTION 'Missing reviewed tenant table: %', tbl;
    END IF;
    discriminator := CASE WHEN tbl = 'users' THEN 'id' ELSE 'user_id' END;
    -- An extra permissive policy is ORed by PostgreSQL; refuse unexpected policy drift.
    FOR policy_row IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = tbl LOOP
      IF policy_row.policyname <> 'tenant_isolation_policy' THEN
        RAISE EXCEPTION 'Unexpected tenant policy requires audit: %.%', tbl, policy_row.policyname;
      END IF;
    END LOOP;
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_policy ON public.%I', tbl);
    EXECUTE format(
      'CREATE POLICY tenant_isolation_policy ON public.%I FOR ALL USING (public.is_rls_bypassed() OR %I = public.current_app_user_id()) WITH CHECK (public.is_rls_bypassed() OR %I = public.current_app_user_id())',
      tbl, discriminator, discriminator);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC', tbl);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO swat_app', tbl);
  END LOOP;
END $$;

-- Fail closed on inherited PUBLIC grants outside that set, including SECURITY DEFINER
-- routines that could write as their owner. Regrant only audited capabilities in a
-- future migration, never turn the runtime into a migration/bootstrap identity.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, swat_app;
GRANT EXECUTE ON FUNCTION public.current_app_user_id(), public.is_rls_bypassed() TO swat_app;
-- Function EXECUTE is granted to PUBLIC globally by PostgreSQL by default;
-- IN SCHEMA alone cannot revoke that global grant. Remove both layers.
ALTER DEFAULT PRIVILEGES FOR ROLE swat_migrator REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE swat_migrator REVOKE EXECUTE ON FUNCTIONS FROM swat_app;
ALTER DEFAULT PRIVILEGES FOR ROLE swat_migrator IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, swat_app;
ALTER DEFAULT PRIVILEGES FOR ROLE swat_migrator IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE swat_migrator IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC;
