-- SOURCE ONLY, EXTERNAL DBA PROVISIONING. Never imported/applied by migrate.ts.
-- Default disabled even for previously active roles; passwords erased. Sessions must
-- be drained externally. Direct LOGIN requires separate expiring lifecycle approval.
BEGIN;
DO $$ DECLARE role_name text; membership record; owner_row record;
 roles text[]:=ARRAY['swat_app','swat_migrator','swat_custody_writer','swat_financial_receipt_writer',
  'swat_lp_admitter','swat_auth_service','swat_system_observer','swat_source_provider_writer',
  'swat_risk_writer','swat_capability_writer','swat_valuation_writer','swat_runtime_lookup','swat_financial_settler'];
BEGIN
 FOREACH role_name IN ARRAY roles LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN EXECUTE format('CREATE ROLE %I NOLOGIN',role_name); END IF;
  EXECUTE format('ALTER ROLE %I NOLOGIN PASSWORD NULL NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION',role_name);
  EXECUTE format('ALTER ROLE %I SET row_security=on',role_name);
  EXECUTE format('ALTER ROLE %I SET search_path=pg_catalog,public',role_name);
 END LOOP;
 FOR membership IN SELECT granted.rolname AS granted_role, member.rolname AS member_role
  FROM pg_auth_members m JOIN pg_roles granted ON granted.oid=m.roleid JOIN pg_roles member ON member.oid=m.member
  WHERE granted.rolname=ANY(roles) OR member.rolname=ANY(roles) LOOP
  EXECUTE format('REVOKE %I FROM %I CASCADE',membership.granted_role,membership.member_role);
 END LOOP;
 -- Default ACLs are NOT runtime authority. Existing relation grants are tightened by
 -- reviewed migrations; no blanket SELECT/DML/EXECUTE and no auth tenant grant here.
 FOR owner_row IN SELECT DISTINCT r.rolname FROM pg_default_acl a JOIN pg_roles r ON r.oid=a.defaclrole LOOP
  FOREACH role_name IN ARRAY roles LOOP
   IF role_name='swat_migrator' THEN CONTINUE; END IF;
   EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE ALL ON TABLES FROM %I',owner_row.rolname,role_name);
   EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE ALL ON SEQUENCES FROM %I',owner_row.rolname,role_name);
   EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON TABLES FROM %I',owner_row.rolname,role_name);
   EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I',owner_row.rolname,role_name);
  END LOOP;
 END LOOP;
 REVOKE CREATE ON SCHEMA public FROM PUBLIC;
 FOREACH role_name IN ARRAY roles LOOP
  IF role_name='swat_migrator' THEN CONTINUE; END IF;
  EXECUTE format('REVOKE CREATE ON DATABASE %I FROM %I',current_database(),role_name);
  -- Revoke direct CREATE on every extant schema; inherited PUBLIC access is checked below.
  FOR owner_row IN SELECT nspname FROM pg_namespace LOOP
   EXECUTE format('REVOKE CREATE ON SCHEMA %I FROM %I',owner_row.nspname,role_name);
  END LOOP;
 END LOOP;
 EXECUTE format('REVOKE CREATE ON DATABASE %I FROM PUBLIC',current_database());
 FOREACH role_name IN ARRAY roles LOOP
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I',current_database(),role_name);
 END LOOP;
 EXECUTE format('GRANT CREATE ON DATABASE %I TO swat_migrator',current_database());
END $$;
-- Historical objects are unqualified. DBA must audit/explicitly assign public,
-- application relations, migrator-owned functions and journal; NEVER REASSIGN OWNED blindly.
ALTER ROLE swat_migrator SET search_path=public,pg_catalog;
GRANT USAGE,CREATE ON SCHEMA public TO swat_migrator;
GRANT USAGE ON SCHEMA public TO swat_app,swat_custody_writer,swat_financial_receipt_writer,
 swat_lp_admitter,swat_auth_service,swat_system_observer,swat_source_provider_writer,
 swat_risk_writer,swat_capability_writer,swat_valuation_writer,swat_runtime_lookup,swat_financial_settler;
REVOKE ALL ON FUNCTION pg_catalog.pg_control_system() FROM PUBLIC,swat_app,swat_custody_writer,
 swat_financial_receipt_writer,swat_lp_admitter,swat_auth_service,swat_source_provider_writer,
 swat_risk_writer,swat_capability_writer,swat_valuation_writer,swat_runtime_lookup,swat_financial_settler;
GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO swat_system_observer,swat_migrator;
DO $$ DECLARE r record; BEGIN
 FOR r IN SELECT * FROM pg_roles WHERE rolname IN('swat_app','swat_custody_writer','swat_financial_receipt_writer',
  'swat_lp_admitter','swat_auth_service','swat_system_observer','swat_source_provider_writer','swat_risk_writer',
  'swat_capability_writer','swat_valuation_writer','swat_runtime_lookup','swat_financial_settler') LOOP
  IF has_database_privilege(r.oid,current_database(),'CREATE')
   OR EXISTS(SELECT 1 FROM pg_namespace WHERE has_schema_privilege(r.oid,oid,'CREATE'))
   OR EXISTS(SELECT 1 FROM pg_class WHERE relowner=r.oid)
   OR EXISTS(SELECT 1 FROM pg_namespace WHERE nspowner=r.oid)
   OR EXISTS(SELECT 1 FROM pg_database WHERE datdba=r.oid)
   OR (r.rolname NOT IN('swat_runtime_lookup','swat_financial_settler') AND EXISTS(SELECT 1 FROM pg_proc WHERE proowner=r.oid))
  THEN RAISE EXCEPTION 'restricted role retains ownership/effective CREATE: %',r.rolname; END IF;
  IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.proowner=r.oid AND (
   (r.rolname='swat_runtime_lookup' AND p.oid IN(to_regprocedure('public.swat_claim_runtime_capability(uuid)'),
     to_regprocedure('public.has_worker_execution_capability(uuid)')))
   OR (r.rolname='swat_financial_settler' AND p.oid IN(to_regprocedure('public.swat_apply_perps_reducing_receipt(uuid,text)'),
     to_regprocedure('public.w3_apply_financial_receipt()'),to_regprocedure('public.w3_perps_accounting_requires_application()'),
     to_regprocedure('public.swat_cancel_expired_financial_intent(uuid)'),to_regprocedure('public.w3_guard_perps_position_mutation()')))
  ) IS DISTINCT FROM true) THEN RAISE EXCEPTION 'function owner has nonallowlisted routine: %',r.rolname; END IF;
 END LOOP;
END $$;
-- Function owners NEVER LOGIN. Restricted owner functions must be allowlisted and
-- separately audited; broker owner/DBA are external infrastructure, not app roles.
COMMIT;
