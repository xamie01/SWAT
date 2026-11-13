-- PACKAGE09 MANUAL DBA PROVISIONING ONLY. Not imported by migrate.ts; NOT APPLIED.
-- Run only in an approved quiesced window with existing schema/role ownership audited.
-- Both fresh and existing identities are disabled and credentials removed. Provision
-- independent random credentials out of band AFTER ownership, grants and RLS validation.
BEGIN;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'swat_app') THEN
    CREATE ROLE swat_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'swat_migrator') THEN
    CREATE ROLE swat_migrator NOLOGIN;
  END IF;
END $$;
ALTER ROLE swat_app NOLOGIN PASSWORD NULL NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER ROLE swat_migrator NOLOGIN PASSWORD NULL NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER ROLE swat_app SET row_security = on;
ALTER ROLE swat_migrator SET row_security = on;
ALTER ROLE swat_app SET search_path = pg_catalog, public;
-- Migrations create unqualified historical objects in public, never pg_catalog.
ALTER ROLE swat_migrator SET search_path = public, pg_catalog;

-- Remove inherited/SET ROLE authority in BOTH directions, including legacy swat membership.
DO $$
DECLARE grant_row record;
BEGIN
  FOR grant_row IN
    SELECT granted.rolname AS granted_role, member.rolname AS member_role
    FROM pg_auth_members m JOIN pg_roles granted ON granted.oid = m.roleid
    JOIN pg_roles member ON member.oid = m.member
    WHERE granted.rolname IN ('swat_app', 'swat_migrator') OR member.rolname IN ('swat_app', 'swat_migrator')
  LOOP
    EXECUTE format('REVOKE %I FROM %I CASCADE', grant_row.granted_role, grant_row.member_role);
  END LOOP;
END $$;
REVOKE CREATE ON SCHEMA public FROM PUBLIC, swat_app;
GRANT USAGE ON SCHEMA public TO swat_app;
GRANT USAGE, CREATE ON SCHEMA public TO swat_migrator;
DO $$
DECLARE owner_row record;
BEGIN
  EXECUTE format('REVOKE CREATE ON DATABASE %I FROM PUBLIC, swat_app', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO swat_app, swat_migrator', current_database());
  -- Allows trusted extensions on a clean DB, not CREATE DATABASE or role administration.
  EXECUTE format('GRANT CREATE ON DATABASE %I TO swat_migrator', current_database());
  -- Historical 064 may have installed defaults owned by a bootstrap identity.
  FOR owner_row IN SELECT DISTINCT r.rolname FROM pg_default_acl a JOIN pg_roles r ON r.oid = a.defaclrole LOOP
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE ALL ON TABLES FROM swat_app', owner_row.rolname);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE ALL ON SEQUENCES FROM swat_app', owner_row.rolname);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON TABLES FROM swat_app', owner_row.rolname);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON SEQUENCES FROM swat_app', owner_row.rolname);
  END LOOP;
END $$;
-- Do not blindly REASSIGN OWNED. DBA must explicitly transfer the reviewed application
-- tables/functions/schema and any existing journal to swat_migrator, never swat_app.
-- Existing sessions survive NOLOGIN/password removal: drain/terminate them separately.
COMMIT;
