-- S2 / WAVE4 LP PRIVILEGES: SOURCE-ONLY PROPOSAL. NOT APPLIED.
-- Requires independent review, canonical 070/083, and separately approved quiesced
-- migration execution. This file cannot authorize runtime or enable credentials.
-- NOLOGIN/auth/global-read remain separate unresolved decisions.
-- No policy, receipt trigger, authority registry, ownership or role is changed.
DO $$
DECLARE
  app_oid oid;
  migrator_oid oid;
  relation_row record;
  policy_row record;
  trigger_row record;
  expected_expression text;
  reviewed_tables text[] := ARRAY[
    'lp_guardrail_configs', 'lp_positions', 'lp_position_state_history',
    'lp_copy_subscriptions', 'lp_copy_executions',
    'lp_exact_positions', 'lp_exact_operations', 'lp_exact_receipts'
  ];
  reviewed_policies text[] := ARRAY[
    'lp_guardrail_tenant_083', 'lp_position_tenant_083', 'lp_history_tenant_083',
    'lp_subscription_tenant_083', 'lp_copy_execution_tenant_083',
    'lp_exact_position_tenant', 'lp_exact_operation_tenant', 'lp_exact_receipt_tenant'
  ];
BEGIN
  RAISE EXCEPTION '084 application refused: protected LP receipt admission and full installed catalog qualification remain unavailable';

  IF current_user <> 'swat_migrator' OR session_user <> 'swat_migrator'
     OR current_setting('row_security') <> 'on' THEN
    RAISE EXCEPTION '084 requires direct canonical migrator with row_security on';
  END IF;
  SELECT oid INTO migrator_oid FROM pg_catalog.pg_roles WHERE rolname = 'swat_migrator';
  SELECT oid INTO app_oid FROM pg_catalog.pg_roles
    WHERE rolname = 'swat_app' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls
      AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication AND NOT rolinherit;
  IF app_oid IS NULL OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members WHERE member = app_oid OR roleid = app_oid
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE oid = migrator_oid
      AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication OR rolinherit)
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members WHERE member = migrator_oid OR roleid = migrator_oid
  ) THEN
    RAISE EXCEPTION '084 requires isolated nonprivileged roles; swat_app must remain NOLOGIN';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE relowner = app_oid)
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspowner = app_oid)
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc WHERE proowner = app_oid)
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datdba = app_oid)
     OR pg_catalog.has_schema_privilege('swat_app', 'public', 'CREATE')
     OR pg_catalog.has_database_privilege('swat_app', current_database(), 'CREATE') THEN
    RAISE EXCEPTION '084 refuses runtime ownership or object creation authority';
  END IF;

  -- Refuse permissive-policy drift rather than OR another policy into the boundary.
  FOR relation_row IN
    SELECT name, reviewed_policies[ordinality::integer] AS policy_name
    FROM unnest(reviewed_tables) WITH ORDINALITY AS reviewed(name, ordinality)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = relation_row.name AND c.relkind = 'r'
        AND c.relowner = migrator_oid AND c.relrowsecurity AND c.relforcerowsecurity
    ) THEN
      RAISE EXCEPTION '084 requires migrator-owned forced tenant RLS: %', relation_row.name;
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_policy
        WHERE polrelid = pg_catalog.to_regclass('public.' || relation_row.name)) <> 1 THEN
      RAISE EXCEPTION '084 refuses missing or additional tenant policies: %', relation_row.name;
    END IF;
    SELECT * INTO policy_row FROM pg_catalog.pg_policy
      WHERE polrelid = pg_catalog.to_regclass('public.' || relation_row.name);
    expected_expression := CASE WHEN relation_row.name = 'lp_position_state_history' THEN
      'existsselect1fromlp_positionspwherep.id=lp_position_state_history.position_idandp.user_id=current_app_user_id'
      ELSE 'user_id=current_app_user_id' END;
    IF policy_row.polname <> relation_row.policy_name OR policy_row.polcmd <> '*'
       OR NOT policy_row.polpermissive OR policy_row.polroles <> ARRAY[app_oid]::oid[]
       OR lower(regexp_replace(replace(pg_catalog.pg_get_expr(policy_row.polqual, policy_row.polrelid), 'public.', ''), '[[:space:]()]', '', 'g'))
          IS DISTINCT FROM expected_expression
       OR lower(regexp_replace(replace(pg_catalog.pg_get_expr(policy_row.polwithcheck, policy_row.polrelid), 'public.', ''), '[[:space:]()]', '', 'g'))
          IS DISTINCT FROM expected_expression THEN
      RAISE EXCEPTION '084 requires unchanged exact tenant USING/WITH CHECK: %', relation_row.name;
    END IF;
  END LOOP;

  -- Canonical 070 leaves these base tables denied. Refuse stale table/column ACLs;
  -- do not silently preserve a broader grant or rewrite an installed boundary.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
    WHERE n.nspname = 'public' AND c.relname = ANY(reviewed_tables[1:5])
      AND a.grantee IN (0, app_oid)
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute att JOIN pg_catalog.pg_class c ON c.oid = att.attrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(att.attacl) a
    WHERE n.nspname = 'public' AND c.relname = ANY(reviewed_tables[1:5])
      AND a.grantee IN (0, app_oid)
  ) THEN
    RAISE EXCEPTION '084 base LP ACL drift requires independent audit';
  END IF;

  -- Preserve exact trigger coverage, including the canonical legacy UPDATE OF state.
  -- Body pins compare the literal sealed source, without normalizing SQL tokens.
  FOR trigger_row IN SELECT * FROM (VALUES
    ('lp_exact_positions', 'trg_lp_exact_acquisition_snapshot', 'lp_exact_acquisition_snapshot_guard', 7, 'ae966fa3f9fe5bcb853c5fa6456d62301f5f71b46b8e048f845da0bc1cdcdfc0'),
    ('lp_exact_positions', 'trg_lp_exact_position_guard', 'lp_exact_position_guard', 27, 'd7caa0aebfc273500b38e7e921d1f2f29239a041844a81b324bf88aa16d9d806'),
    ('lp_exact_operations', 'trg_lp_exact_operation_guard', 'lp_exact_operation_guard', 31, '8a2dc93db913beeb51599be43baa1288f0129d0b48dd24beb2543be4b2a668cc'),
    ('lp_exact_receipts', 'trg_lp_exact_receipt_immutable', 'lp_exact_immutable_receipt', 27, '53ec3dc4cce7460358cddc5fc2f0f36cfaf9d1ea990ad55e1a7067c9e71dcda1'),
    ('lp_positions', 'trg_lp_exact_legacy_guard', 'lp_exact_legacy_financial_guard', 19, '88dd478095f94eb172e64a900342dc5bbcae1ae78c989388973dd006111fa145'),
    ('lp_positions', 'trg_lp_position_state_transition', 'enforce_lp_position_state_transition', 19, 'ef25dd4e3f6f2148187b4cefefd6c25855664f5f14d4054bdadb4da26c29509f')
  ) AS required(table_name, trigger_name, function_name, trigger_type, body_sha256)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE t.tgrelid = pg_catalog.to_regclass('public.' || trigger_row.table_name)
        AND t.tgname = trigger_row.trigger_name AND NOT t.tgisinternal AND t.tgenabled = 'O'
        AND t.tgtype = trigger_row.trigger_type AND n.nspname = 'public'
        AND t.tgqual IS NULL AND t.tgnargs = 0 AND t.tgargs = ''::bytea
        AND t.tgconstraint = 0 AND NOT t.tgdeferrable AND NOT t.tginitdeferred
        AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL
        AND t.tgattr::text = CASE WHEN trigger_row.trigger_name = 'trg_lp_position_state_transition' THEN
          (SELECT attnum::text FROM pg_catalog.pg_attribute
            WHERE attrelid = t.tgrelid AND attname = 'state' AND NOT attisdropped)
          ELSE '' END
        AND p.proname = trigger_row.function_name AND p.proowner = migrator_oid AND NOT p.prosecdef
        AND p.pronargs = 0 AND p.prorettype = 'pg_catalog.trigger'::regtype
        AND p.prokind = 'f' AND p.provolatile = 'v' AND NOT p.proisstrict AND NOT p.proleakproof
        AND p.proparallel = 'u' AND p.proconfig IS NULL AND p.prosupport = 0
        AND p.prolang = (SELECT oid FROM pg_catalog.pg_language WHERE lanname = 'plpgsql')
        AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc, 'UTF8')), 'hex') = trigger_row.body_sha256
    ) THEN
      RAISE EXCEPTION '084 requires canonical enabled invoker receipt/state guard: %', trigger_row.trigger_name;
    END IF;
  END LOOP;
  IF pg_catalog.pg_get_serial_sequence('public.lp_position_state_history', 'id')
       IS DISTINCT FROM 'public.lp_position_state_history_id_seq'
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_class WHERE oid = pg_catalog.to_regclass('public.lp_position_state_history_id_seq')
         AND relkind = 'S' AND relowner = migrator_oid
     ) THEN
    RAISE EXCEPTION '084 requires canonical migrator-owned history sequence';
  END IF;

-- Exact-store cap read + FOR UPDATE: one nonfinancial column suffices for locking.
-- No guardrail INSERT: seedOwners-only initialization is not a store capability.
GRANT SELECT (user_id, max_pool_allocation_pct) ON public.lp_guardrail_configs TO swat_app;
GRANT UPDATE (updated_at) ON public.lp_guardrail_configs TO swat_app;

-- Exposure reads, tenant joins, RETURNING id and locked compatibility snapshots.
GRANT SELECT (id, user_id, chain, pool_address, state, auto_rebalance,
  acquisition_mode, acquisition_provenance, deposit_value_usd) ON public.lp_positions TO swat_app;
GRANT INSERT (user_id, chain, protocol, pool_address, strategy_type, range_lower, range_upper,
  rung_allocations, deposit_amount, deposit_asset, state, auto_rebalance, acquisition_mode,
  acquisition_provenance, deposit_value_usd, valuation_evidence, paper_plan,
  acquisition_key, acquisition_fingerprint) ON public.lp_positions TO swat_app;
GRANT UPDATE (state, updated_at, paper_plan, range_lower, range_upper, closed_at)
  ON public.lp_positions TO swat_app;

-- Append journal only; default BIGSERIAL nextval needs USAGE, not SELECT/UPDATE.
GRANT INSERT (position_id, from_state, to_state, reason) ON public.lp_position_state_history TO swat_app;
GRANT USAGE ON SEQUENCE public.lp_position_state_history_id_seq TO swat_app;

-- Actual exact-store copy branches only: no subscription creation/budget mutation.
GRANT SELECT (id, user_id, master_wallet_address, chain, venue, allocated_budget_usd,
  max_capital_per_position_usd, status, created_at, updated_at) ON public.lp_copy_subscriptions TO swat_app;
GRANT UPDATE (updated_at) ON public.lp_copy_subscriptions TO swat_app;
GRANT SELECT (user_id, subscription_id, status, follower_position_id) ON public.lp_copy_executions TO swat_app;
GRANT INSERT (subscription_id, user_id, master_position_id, follower_position_id, chain, action,
  master_deposit_usd, follower_deposit_usd, scale_ratio, status, error_message)
  ON public.lp_copy_executions TO swat_app;

-- The proposed grants stay inside the refused block: continue-on-error SQL
-- clients must not reach them as independent statements.
END $$;

-- 083 retains tenant-writable receipts; independent admitted quote/economic
-- binding is unresolved. This refusal does not repair 083 or undo installed ACLs.
-- Runtime CLI/pipeline remain refused; runtimeAccepted=false,
-- liveCapabilityAccepted=false, productionReady=false. Source is not acceptance.
