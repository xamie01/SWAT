-- 064_row_level_security.sql
--
-- Row-Level Security (RLS) for tenant isolation across all user-scoped tables.
--
-- Defense-in-depth security model:
--   1. Functions:
--      - current_app_user_id(): Extracts 'app.current_user_id' setting as UUID (returns NULL if unset/invalid).
--      - is_rls_bypassed(): Checks 'app.bypass_rls' = 'on' OR 'app.current_user_id' = '*'.
--        Crucially, untrusted/app role 'swat_app' is forbidden from bypassing RLS under any condition.
--   2. Policies:
--      - 'tenant_isolation_policy' on all 17 user-scoped tables.
--      - Evaluates USING and WITH CHECK to guarantee no cross-tenant reads, updates, deletes, or inserts.
--   3. FORCE ROW LEVEL SECURITY:
--      - Ensures table owners are bound by RLS policies.
--   4. Role 'swat_app':
--      - Least-privilege application role with NOSUPERUSER NOBYPASSRLS for production application pools.
--
-- Idempotent: Replays cleanly on migrate.ts.

-- 1. Helper Functions
CREATE OR REPLACE FUNCTION current_app_user_id() RETURNS uuid STABLE AS $$
BEGIN
  RETURN NULLIF(current_setting('app.current_user_id', true), '')::uuid;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION is_rls_bypassed() RETURNS boolean STABLE AS $$
BEGIN
  -- An unprivileged app role can NEVER bypass RLS even if it attempts to set session flags
  IF CURRENT_USER = 'swat_app' THEN
    RETURN false;
  END IF;

  RETURN (
    current_setting('app.bypass_rls', true) = 'on'
    OR current_setting('app.current_user_id', true) = '*'
  );
END;
$$ LANGUAGE plpgsql;

-- 2. Create swat_app role if it doesn't already exist
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'swat_app') THEN
    CREATE ROLE swat_app WITH LOGIN PASSWORD 'swat_app' NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;

GRANT swat_app TO swat WITH SET TRUE;
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO swat_app', current_database());
END $$;
GRANT USAGE ON SCHEMA public TO swat_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO swat_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO swat_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO swat_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO swat_app;

-- 3. Configure RLS Policies on all 17 User-Scoped Tables
DO $$
DECLARE
  tbl text;
  tables text[] := ARRAY[
    'user_sessions',
    'user_auth_wallets',
    'user_api_keys',
    'user_balances',
    'user_wallet_subscriptions',
    'user_token_watches',
    'user_execution_grants',
    'user_execution_settings',
    'user_chain_execution_settings',
    'user_payment_intents',
    'crypto_payments',
    'copy_positions',
    'copy_executions',
    'copy_position_master_lots',
    'copy_position_applications',
    'copy_position_close_all_claims'
  ];
BEGIN
  -- 3a. Table 'users' (identity column is 'id')
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users') THEN
    EXECUTE 'ALTER TABLE users ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE users FORCE ROW LEVEL SECURITY';
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies 
      WHERE schemaname = 'public' AND tablename = 'users' AND policyname = 'tenant_isolation_policy'
    ) THEN
      EXECUTE 'CREATE POLICY tenant_isolation_policy ON users FOR ALL USING (is_rls_bypassed() OR id = current_app_user_id()) WITH CHECK (is_rls_bypassed() OR id = current_app_user_id())';
    END IF;
  END IF;

  -- 3b. Tables where tenant discriminator column is 'user_id'
  FOREACH tbl IN ARRAY tables LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = tbl) THEN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
      EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies 
        WHERE schemaname = 'public' AND tablename = tbl AND policyname = 'tenant_isolation_policy'
      ) THEN
        EXECUTE format(
          'CREATE POLICY tenant_isolation_policy ON %I FOR ALL USING (is_rls_bypassed() OR user_id = current_app_user_id()) WITH CHECK (is_rls_bypassed() OR user_id = current_app_user_id())',
          tbl
        );
      END IF;
    END IF;
  END LOOP;
END $$;
