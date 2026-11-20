-- SOURCE ONLY086. Explicit reviewed selection excludes preserved refusal084.
-- Execute only after exact installed085 in the same migrator-owned apply transaction.
-- No LOGIN, credentials, memberships, ownership transfers, global auth grants or permissive new RLS.
DO $guard$
DECLARE migrator oid; r record; f record; t record; relation_oid oid; policy_row record;
 prior_search_path text:=current_setting('search_path');
BEGIN
 IF current_user<>'swat_migrator' OR session_user<>'swat_migrator' OR current_setting('role')<>'none'
  OR current_setting('row_security')<>'on' THEN RAISE EXCEPTION '086 requires direct restricted migrator'; END IF;
 SELECT oid INTO migrator FROM pg_roles WHERE rolname='swat_migrator'
  AND NOT(rolsuper OR rolbypassrls OR rolinherit OR rolcreaterole OR rolcreatedb OR rolreplication);
 IF migrator IS NULL OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=migrator OR roleid=migrator)
  OR NOT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='public' AND nspowner=migrator)
 THEN RAISE EXCEPTION '086 canonical migrator flags/membership/public owner drift'; END IF;
 FOR r IN SELECT * FROM pg_roles WHERE rolname IN('swat_app','swat_lp_admitter') LOOP
  IF (r.rolname='swat_app' AND r.rolcanlogin) OR r.rolsuper OR r.rolbypassrls OR r.rolinherit OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication
   OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid)
   OR EXISTS(SELECT 1 FROM pg_class WHERE relowner=r.oid) OR EXISTS(SELECT 1 FROM pg_proc WHERE proowner=r.oid)
   OR EXISTS(SELECT 1 FROM pg_namespace WHERE nspowner=r.oid) OR EXISTS(SELECT 1 FROM pg_database WHERE datdba=r.oid)
   OR has_database_privilege(r.oid,current_database(),'CREATE')
   OR EXISTS(SELECT 1 FROM pg_namespace WHERE has_schema_privilege(r.oid,oid,'CREATE'))
  THEN RAISE EXCEPTION '086 runtime/admitter restricted nonowning role drift'; END IF;
 END LOOP;
 IF (SELECT count(*) FROM pg_roles WHERE rolname IN('swat_app','swat_lp_admitter'))<>2
 THEN RAISE EXCEPTION '086 runtime/admitter missing'; END IF;
 -- Actual catalog bodies, not a fabricated migration journal. All085 functions pinned,
 -- including pure validators and every caller/trigger guard, SECURITY INVOKER and options.
 FOR f IN SELECT * FROM (VALUES
  ('lp085_fields(jsonb,text[])','b965deb7b060080ddfbb3449da46f99ee93566a6bcc7fcef54a9f190c70691a4','plpgsql','bool'),
  ('lp085_texts(jsonb,text[])','2327d73bf43b769ba836b22cbb5bdd7bfcce282e91ac1fe31385dec2adbe8345','plpgsql','bool'),
  ('lp085_micro(jsonb,boolean)','28c86d7e3e917352d1d2c4f9174c5a3b6b095f155b89d83bd24c978d2f69bdc7','plpgsql','numeric'),
  ('lp085_amount(jsonb,boolean)','719266164aa23bc1a7f56dc7607988eb3680b69bf3a6d5285634b0e9d52393af','plpgsql','numeric'),
  ('lp085_time(jsonb)','55f2a14e18ba578c2dd5aba0b35c8aa17b240225bd10b7e26993b965c8c96cae','plpgsql','timestamptz'),
  ('lp085_quote_valid(jsonb,jsonb,timestamptz)','04d9b340d9505dcd33edfa0e730a5d9cfb46d26d16a5e1d2cf02ee2e58b21897','plpgsql','bool'),
  ('lp085_project_position(jsonb,text,boolean)','d2f2234ef1b95753ddaa9bb62609fa59ed6428072c0de25c8c8960c61fafb443','plpgsql','jsonb'),
  ('lp085_current_position(uuid,uuid)','6ea418e223e6c447a5f5393dd0d106ab6b2ca3933d7e116d57d5566e44f1ad61','sql','jsonb'),
  ('lp085_legacy_rungs(jsonb,jsonb)','6062bc6b040702f3c0e48c3af549c404b2bab79cebfe5202817b106d3509de13','plpgsql','jsonb'),
  ('lp085_admission_guard()','8cd4aba6d5c4f240d5307e2f0ca993c23501af79feb84db4538b821b49f26cc8','plpgsql','trigger'),
  ('lp085_receipt_valid(jsonb,public.lp_protected_quote_admissions,jsonb,jsonb,timestamptz,timestamptz)','2cbb947de25be54874ec238b7c55ec17b8dbbcda36d3cee046e1fbe230fcd5d0','plpgsql','bool'),
  ('lp085_runtime_quote_guard()','d3fce8ab0a858930af0f1d25093def80f948b8e20630c822b3f0018411741f3a','plpgsql','trigger'),
  ('lp085_runtime_settlement_guard()','b689dbf5726a23101f2e58ea4e4f40a5ab28899f72b1fa7de439e6b102ba58af','plpgsql','trigger'),
  ('lp085_legacy_update_guard()','0cd75750790d4fa5714b77b1169728a77569c34918cb2410642ae411ef99dbe8','plpgsql','trigger')
 ) AS pins(signature,body_hash,language,result_type) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
   WHERE p.oid=to_regprocedure('public.'||f.signature) AND p.proowner=migrator
    AND p.prokind='f' AND NOT p.prosecdef AND NOT p.proisstrict AND NOT p.proleakproof
    AND NOT p.proretset AND p.prosupport=0 AND p.provariadic=0 AND p.procost=100 AND p.prorows=0
    AND p.proallargtypes IS NULL AND p.proargmodes IS NULL
    AND p.pronargs=CASE WHEN f.signature LIKE '%()' THEN 0 ELSE
      array_length(string_to_array(split_part(split_part(f.signature,'(',2),')',1),','),1) END
    AND p.proargtypes::text=(SELECT COALESCE(string_agg(to_regtype(CASE WHEN type_name LIKE 'public.%' THEN type_name WHEN type_name='boolean' THEN 'pg_catalog.bool' ELSE 'pg_catalog.'||type_name END)::oid::text,' ' ORDER BY ord),'')
      FROM unnest(CASE WHEN f.signature LIKE '%()' THEN ARRAY[]::text[] ELSE
        string_to_array(split_part(split_part(f.signature,'(',2),')',1),',') END) WITH ORDINALITY types(type_name,ord))
    AND p.proargnames IS NOT DISTINCT FROM CASE f.signature
      WHEN 'lp085_fields(jsonb,text[])' THEN ARRAY['j','keys']
      WHEN 'lp085_texts(jsonb,text[])' THEN ARRAY['j','keys']
      WHEN 'lp085_micro(jsonb,boolean)' THEN ARRAY['j','signed']
      WHEN 'lp085_amount(jsonb,boolean)' THEN ARRAY['j','positive']
      WHEN 'lp085_time(jsonb)' THEN ARRAY['j']
      WHEN 'lp085_quote_valid(jsonb,jsonb,timestamptz)' THEN ARRAY['i','q','at_time']
      WHEN 'lp085_project_position(jsonb,text,boolean)' THEN ARRAY['d','legacy_state','consent']
      WHEN 'lp085_current_position(uuid,uuid)' THEN ARRAY['requested_tenant','requested_position']
      WHEN 'lp085_legacy_rungs(jsonb,jsonb)' THEN ARRAY['plan','amount']
      WHEN 'lp085_receipt_valid(jsonb,public.lp_protected_quote_admissions,jsonb,jsonb,timestamptz,timestamptz)' THEN ARRAY['r','q','o','p','created','at_time']
      ELSE NULL::text[] END
    AND p.provolatile='v' AND p.proparallel='u' AND p.proconfig=ARRAY['search_path=pg_catalog']::text[]
    AND ((f.signature IN('lp085_micro(jsonb,boolean)','lp085_amount(jsonb,boolean)')
       AND p.pronargdefaults=1 AND pg_get_expr(p.proargdefaults,0)='false')
      OR (f.signature NOT IN('lp085_micro(jsonb,boolean)','lp085_amount(jsonb,boolean)') AND p.pronargdefaults=0 AND p.proargdefaults IS NULL))
    AND l.lanname=f.language AND p.prorettype=to_regtype('pg_catalog.'||f.result_type)
    AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=f.body_hash
    AND NOT EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
      WHERE a.grantor<>migrator OR a.is_grantable OR a.privilege_type<>'EXECUTE'
       OR (a.grantee=migrator OR (f.signature NOT IN('lp085_admission_guard()','lp085_runtime_quote_guard()',
         'lp085_runtime_settlement_guard()','lp085_legacy_update_guard()')
        AND a.grantee IN((SELECT oid FROM pg_roles WHERE rolname='swat_app'),(SELECT oid FROM pg_roles WHERE rolname='swat_lp_admitter')))) IS DISTINCT FROM true)
    AND (SELECT count(*) FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))))=
      CASE WHEN f.signature IN('lp085_admission_guard()','lp085_runtime_quote_guard()',
        'lp085_runtime_settlement_guard()','lp085_legacy_update_guard()') THEN 1 ELSE 3 END)
  THEN RAISE EXCEPTION '086 installed085 exact function/body/options/owner/ACL drift: %',f.signature; END IF;
 END LOOP;
 FOR t IN SELECT * FROM (VALUES
  ('lp_protected_quote_admissions','lp085_quote_admission','lp085_admission_guard()',31),
  ('lp_protected_settlement_admissions','lp085_settlement_admission','lp085_admission_guard()',31),
  ('lp_positions','lp085_base_acquisition','lp085_runtime_quote_guard()',7),
  ('lp_exact_positions','lp085_exact_acquisition','lp085_runtime_quote_guard()',7),
  ('lp_exact_operations','lp085_operation','lp085_runtime_quote_guard()',7),
  ('lp_exact_receipts','lp085_receipt','lp085_runtime_settlement_guard()',7),
  ('lp_exact_operations','lp085_completion','lp085_runtime_settlement_guard()',19),
  ('lp_exact_positions','lp085_exact_position','lp085_runtime_settlement_guard()',19),
  ('lp_positions','lp085_legacy_update','lp085_legacy_update_guard()',19)
 ) AS pins(relation_name,trigger_name,function_name,trigger_type) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.'||t.relation_name)
    AND tgname=t.trigger_name AND tgfoid=to_regprocedure('public.'||t.function_name)
    AND tgtype=t.trigger_type AND tgenabled='O' AND NOT tgisinternal
    AND NOT tgdeferrable AND NOT tginitdeferred AND tgqual IS NULL AND tgnargs=0
    AND tgconstraint=0 AND tgoldtable IS NULL AND tgnewtable IS NULL
    AND tgargs=''::bytea AND tgattr=''::int2vector)
  THEN RAISE EXCEPTION '086 installed085 full trigger drift: %',t.trigger_name; END IF;
 END LOOP;
 -- Sealed083/066 invoker guards remain mandatory alongside085, not merely present by name.
 FOR t IN SELECT * FROM (VALUES
  ('lp_exact_positions','trg_lp_exact_acquisition_snapshot','lp_exact_acquisition_snapshot_guard',7,'ae966fa3f9fe5bcb853c5fa6456d62301f5f71b46b8e048f845da0bc1cdcdfc0'),
  ('lp_exact_positions','trg_lp_exact_position_guard','lp_exact_position_guard',27,'d7caa0aebfc273500b38e7e921d1f2f29239a041844a81b324bf88aa16d9d806'),
  ('lp_exact_operations','trg_lp_exact_operation_guard','lp_exact_operation_guard',31,'8a2dc93db913beeb51599be43baa1288f0129d0b48dd24beb2543be4b2a668cc'),
  ('lp_exact_receipts','trg_lp_exact_receipt_immutable','lp_exact_immutable_receipt',27,'53ec3dc4cce7460358cddc5fc2f0f36cfaf9d1ea990ad55e1a7067c9e71dcda1'),
  ('lp_positions','trg_lp_exact_legacy_guard','lp_exact_legacy_financial_guard',19,'88dd478095f94eb172e64a900342dc5bbcae1ae78c989388973dd006111fa145'),
  ('lp_positions','trg_lp_acquisition_immutable','enforce_lp_acquisition_immutable',19,'eadc7ce25888d29f7cd1ef634e03780f0600808e99d8f53967cecaa952f6710e'),
  ('lp_positions','trg_lp_position_state_transition','enforce_lp_position_state_transition',19,'ef25dd4e3f6f2148187b4cefefd6c25855664f5f14d4054bdadb4da26c29509f')
 ) AS pins(relation_name,trigger_name,function_name,trigger_type,body_hash) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger g JOIN pg_proc p ON p.oid=g.tgfoid
   JOIN pg_language l ON l.oid=p.prolang WHERE g.tgrelid=to_regclass('public.'||t.relation_name)
    AND g.tgname=t.trigger_name AND g.tgfoid=to_regprocedure('public.'||t.function_name||'()')
    AND g.tgtype=t.trigger_type AND g.tgenabled='O' AND NOT g.tgisinternal AND g.tgqual IS NULL
    AND g.tgnargs=0 AND g.tgargs=''::bytea AND g.tgconstraint=0 AND NOT g.tgdeferrable AND NOT g.tginitdeferred
    AND g.tgoldtable IS NULL AND g.tgnewtable IS NULL
    AND g.tgattr::text=CASE WHEN t.trigger_name='trg_lp_position_state_transition' THEN
      (SELECT attnum::text FROM pg_attribute WHERE attrelid=g.tgrelid AND attname='state' AND NOT attisdropped) ELSE '' END
    AND p.proowner=migrator AND NOT p.prosecdef AND NOT p.proisstrict AND NOT p.proleakproof
    AND p.prokind='f' AND p.provolatile='v' AND p.proparallel='u' AND p.proconfig IS NULL AND p.prosupport=0
    AND NOT p.proretset AND p.pronargs=0 AND p.proargtypes=''::oidvector AND p.provariadic=0
    AND p.proargnames IS NULL AND p.proallargtypes IS NULL AND p.proargmodes IS NULL
    AND p.pronargdefaults=0 AND p.proargdefaults IS NULL AND p.procost=100 AND p.prorows=0
    AND p.prorettype='pg_catalog.trigger'::regtype AND l.lanname='plpgsql'
    AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=t.body_hash)
  THEN RAISE EXCEPTION '086 sealed receipt/state full guard drift: %',t.trigger_name; END IF;
 END LOOP;
 -- Full noninternal inventories, including legitimate066/076/083 triggers.
 -- Presence checks above pin every field; two-way set equality also rejects extras.
 IF EXISTS(
  WITH expected(relation_name,trigger_name) AS (VALUES
   ('lp_protected_quote_admissions','lp085_quote_admission'),
   ('lp_protected_settlement_admissions','lp085_settlement_admission'),
   ('lp_positions','lp085_base_acquisition'),('lp_positions','lp085_legacy_update'),
   ('lp_positions','trg_lp_exact_legacy_guard'),('lp_positions','trg_lp_position_state_transition'),
   ('lp_positions','trg_lp_acquisition_immutable'),
   ('lp_exact_positions','lp085_exact_acquisition'),('lp_exact_positions','lp085_exact_position'),
   ('lp_exact_positions','trg_lp_exact_acquisition_snapshot'),('lp_exact_positions','trg_lp_exact_position_guard'),
   ('lp_exact_operations','lp085_operation'),('lp_exact_operations','lp085_completion'),
   ('lp_exact_operations','trg_lp_exact_operation_guard'),
   ('lp_exact_receipts','lp085_receipt'),('lp_exact_receipts','trg_lp_exact_receipt_immutable')),
  actual AS (SELECT c.relname AS relation_name,g.tgname AS trigger_name FROM pg_trigger g
   JOIN pg_class c ON c.oid=g.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND NOT g.tgisinternal AND c.relname IN(
    'lp_protected_quote_admissions','lp_protected_settlement_admissions','lp_positions',
    'lp_exact_positions','lp_exact_operations','lp_exact_receipts','lp_guardrail_configs',
    'lp_copy_subscriptions','lp_copy_executions','lp_position_state_history','lp_paper_operations'))
  SELECT * FROM ((SELECT * FROM actual EXCEPT SELECT * FROM expected)
   UNION ALL (SELECT * FROM expected EXCEPT SELECT * FROM actual)) drift)
 THEN RAISE EXCEPTION '086 full noninternal trigger inventory drift'; END IF;
 -- Reject all unexpected LP policies, not merely a named tenant policy while a
 -- second permissive PUBLIC policy grants unscoped access. Canonical expressions
 -- are rendered with pg_catalog-only search_path so public qualification is stable.
 PERFORM set_config('search_path','pg_catalog',true);
 FOR r IN SELECT unnest(ARRAY['lp_positions','lp_guardrail_configs','lp_copy_subscriptions','lp_copy_executions',
  'lp_paper_operations','lp_position_state_history','lp_exact_positions','lp_exact_operations','lp_exact_receipts',
  'lp_protected_quote_admissions','lp_protected_settlement_admissions']) AS relation_name LOOP
  relation_oid:=to_regclass('public.'||r.relation_name);
  IF relation_oid IS NULL OR NOT EXISTS(SELECT 1 FROM pg_class WHERE oid=relation_oid AND relowner=migrator
    AND relkind='r' AND NOT relispartition AND relrowsecurity AND relforcerowsecurity)
  THEN RAISE EXCEPTION '086 LP exact relation owner/kind/FORCE RLS drift: %',r.relation_name; END IF;
  -- Admissions and admitter context may not inherit third-party authority. Reject
  -- other grantees/grantors/options; known app/admitter remnants are normalized below.
  IF r.relation_name IN('lp_protected_quote_admissions','lp_protected_settlement_admissions','lp_positions','lp_exact_positions','lp_exact_operations')
   AND (EXISTS(SELECT 1 FROM aclexplode(COALESCE((SELECT relacl FROM pg_class WHERE oid=relation_oid),acldefault('r',migrator))) a
     WHERE a.grantee NOT IN(0,migrator,(SELECT oid FROM pg_roles WHERE rolname='swat_app'),(SELECT oid FROM pg_roles WHERE rolname='swat_lp_admitter'))
      OR a.grantor<>migrator OR a.is_grantable)
    OR EXISTS(SELECT 1 FROM pg_attribute col CROSS JOIN LATERAL aclexplode(col.attacl) a
     WHERE col.attrelid=relation_oid AND col.attnum>0 AND NOT col.attisdropped
      AND (a.grantee NOT IN(0,(SELECT oid FROM pg_roles WHERE rolname='swat_app'),(SELECT oid FROM pg_roles WHERE rolname='swat_lp_admitter'))
       OR a.grantor<>migrator OR a.is_grantable)))
  THEN RAISE EXCEPTION '086 admission/context unexpected table/column ACL grantee/grantor/options'; END IF;
  FOR policy_row IN SELECT polname,polcmd,polpermissive,polroles,
   regexp_replace(pg_get_expr(polqual,polrelid),'[[:space:]]','','g') AS using_expr,
   regexp_replace(pg_get_expr(polwithcheck,polrelid),'[[:space:]]','','g') AS check_expr
   FROM pg_policy WHERE polrelid=relation_oid LOOP
   IF NOT policy_row.polpermissive THEN RAISE EXCEPTION '086 unexpected restrictive policy (exact source required)'; END IF;
   IF r.relation_name='lp_position_state_history' THEN
    IF policy_row.polname<>'lp_history_tenant_083' OR policy_row.polcmd<>'*'
     OR policy_row.polroles<>ARRAY[(SELECT oid FROM pg_roles WHERE rolname='swat_app')]::oid[]
     OR policy_row.using_expr IS DISTINCT FROM '(EXISTS(SELECT1FROMpublic.lp_positionspWHERE((p.id=lp_position_state_history.position_id)AND(p.user_id=public.current_app_user_id()))))'
     OR policy_row.check_expr IS DISTINCT FROM policy_row.using_expr THEN RAISE EXCEPTION '086 history tenant policy drift'; END IF;
   ELSIF r.relation_name IN('lp_protected_quote_admissions','lp_protected_settlement_admissions') THEN
    IF ((policy_row.polname='lp085_read_tenant' AND policy_row.polcmd='r'
      AND ARRAY(SELECT unnest(policy_row.polroles) ORDER BY 1)=ARRAY(SELECT oid FROM pg_roles WHERE rolname IN('swat_app','swat_lp_admitter') ORDER BY oid)
      AND policy_row.using_expr='(user_id=public.current_app_user_id())' AND policy_row.check_expr IS NULL)
     OR (policy_row.polname='lp085_insert_admitter' AND policy_row.polcmd='a'
      AND policy_row.polroles=ARRAY[(SELECT oid FROM pg_roles WHERE rolname='swat_lp_admitter')]::oid[]
      AND policy_row.using_expr IS NULL AND policy_row.check_expr='(user_id=public.current_app_user_id())')) IS DISTINCT FROM true
    THEN RAISE EXCEPTION '086 protected admission exact policy drift'; END IF;
   ELSE
    IF ((policy_row.polname=CASE r.relation_name
      WHEN 'lp_positions' THEN 'lp_position_tenant_083' WHEN 'lp_guardrail_configs' THEN 'lp_guardrail_tenant_083'
      WHEN 'lp_copy_subscriptions' THEN 'lp_subscription_tenant_083' WHEN 'lp_copy_executions' THEN 'lp_copy_execution_tenant_083'
      WHEN 'lp_paper_operations' THEN 'lp_legacy_operation_tenant_083' WHEN 'lp_exact_positions' THEN 'lp_exact_position_tenant'
      WHEN 'lp_exact_operations' THEN 'lp_exact_operation_tenant' WHEN 'lp_exact_receipts' THEN 'lp_exact_receipt_tenant' END
      AND policy_row.polcmd='*' AND policy_row.polroles=ARRAY[(SELECT oid FROM pg_roles WHERE rolname='swat_app')]::oid[]
      AND policy_row.using_expr='(user_id=public.current_app_user_id())' AND policy_row.check_expr=policy_row.using_expr)
     OR (policy_row.polname=CASE r.relation_name WHEN 'lp_positions' THEN 'lp085_admitter_base_position_read'
       WHEN 'lp_exact_positions' THEN 'lp085_admitter_position_read' WHEN 'lp_exact_operations' THEN 'lp085_admitter_operation_read' END
      AND policy_row.polcmd='r' AND policy_row.polroles=ARRAY[(SELECT oid FROM pg_roles WHERE rolname='swat_lp_admitter')]::oid[]
      AND policy_row.using_expr='(user_id=public.current_app_user_id())' AND policy_row.check_expr IS NULL)) IS DISTINCT FROM true
    THEN RAISE EXCEPTION '086 LP exact tenant/admitter policy drift: %',policy_row.polname; END IF;
   END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_policy WHERE polrelid=relation_oid) <> CASE
   WHEN r.relation_name IN('lp_protected_quote_admissions','lp_protected_settlement_admissions','lp_positions','lp_exact_positions','lp_exact_operations') THEN 2 ELSE 1 END
  THEN RAISE EXCEPTION '086 LP missing/extra policy'; END IF;
 END LOOP;
 -- Exact serial history sequence identity/owner before its narrowly scoped USAGE.
 IF pg_get_serial_sequence('public.lp_position_state_history','id') IS DISTINCT FROM 'public.lp_position_state_history_id_seq'
  OR NOT EXISTS(SELECT 1 FROM pg_class WHERE oid=to_regclass('public.lp_position_state_history_id_seq') AND relkind='S' AND relowner=migrator)
 THEN RAISE EXCEPTION '086 history sequence identity/owner drift'; END IF;
 PERFORM set_config('search_path',prior_search_path,true);
END $guard$;
-- Remove table and column ACL remnants before exact operation grants. No blanket
-- INSERT/UPDATE grant; immutable/source guards above are prerequisites, not comments.
REVOKE ALL ON public.lp_positions,public.lp_exact_positions,public.lp_exact_operations,public.lp_exact_receipts,
 public.lp_guardrail_configs,public.lp_copy_subscriptions,public.lp_copy_executions,public.lp_position_state_history,
 public.lp_protected_quote_admissions,public.lp_protected_settlement_admissions FROM PUBLIC,swat_app,swat_lp_admitter;
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT n.nspname,t.relname,a.attname FROM pg_attribute a JOIN pg_class t ON t.oid=a.attrelid
  JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' AND t.relname IN('lp_positions',
   'lp_exact_positions','lp_exact_operations','lp_exact_receipts','lp_guardrail_configs','lp_copy_subscriptions',
   'lp_copy_executions','lp_position_state_history','lp_protected_quote_admissions','lp_protected_settlement_admissions') AND a.attnum>0 AND NOT a.attisdropped LOOP
  EXECUTE format('REVOKE ALL (%I) ON %I.%I FROM PUBLIC,swat_app,swat_lp_admitter',c.attname,c.nspname,c.relname);
 END LOOP;
END $$;
-- Explicit append-only admissions and SELECT-only independent context ACLs.
GRANT SELECT ON public.lp_protected_quote_admissions,public.lp_protected_settlement_admissions TO swat_app,swat_lp_admitter;
GRANT INSERT ON public.lp_protected_quote_admissions,public.lp_protected_settlement_admissions TO swat_lp_admitter;
GRANT SELECT(id,user_id,state,auto_rebalance) ON public.lp_positions TO swat_lp_admitter;
GRANT SELECT ON public.lp_exact_positions,public.lp_exact_operations TO swat_lp_admitter;
GRANT SELECT ON public.lp_positions,public.lp_exact_positions,public.lp_exact_operations,public.lp_exact_receipts,
 public.lp_guardrail_configs,public.lp_copy_subscriptions,public.lp_copy_executions,public.lp_position_state_history TO swat_app;
GRANT INSERT(user_id,chain,protocol,pool_address,strategy_type,range_lower,range_upper,rung_allocations,
 deposit_amount,deposit_asset,state,auto_rebalance,acquisition_mode,acquisition_provenance,deposit_value_usd,
 valuation_evidence,paper_plan,acquisition_key,acquisition_fingerprint) ON public.lp_positions TO swat_app;
GRANT UPDATE(state,paper_plan,range_lower,range_upper,rung_allocations,strategy_type,updated_at,closed_at,auto_rebalance) ON public.lp_positions TO swat_app;
GRANT INSERT(position_id,user_id,acquisition_key,subscription_id,master_event_id,data,acquisition_data) ON public.lp_exact_positions TO swat_app;
GRANT UPDATE(data) ON public.lp_exact_positions TO swat_app;
GRANT INSERT(id,user_id,position_id,operation_key,receipt_key,status,data) ON public.lp_exact_operations TO swat_app;
GRANT UPDATE(status,data,completed_at) ON public.lp_exact_operations TO swat_app;
GRANT INSERT(user_id,operation_id,position_id,receipt_key,provider_id,receipt_id,receipt_hash,data) ON public.lp_exact_receipts TO swat_app;
GRANT INSERT(subscription_id,user_id,master_position_id,follower_position_id,chain,action,master_deposit_usd,
 follower_deposit_usd,scale_ratio,status,error_message) ON public.lp_copy_executions TO swat_app;
GRANT INSERT(position_id,from_state,to_state,reason) ON public.lp_position_state_history TO swat_app;
REVOKE ALL ON SEQUENCE public.lp_position_state_history_id_seq FROM PUBLIC,swat_app;
GRANT USAGE ON SEQUENCE public.lp_position_state_history_id_seq TO swat_app;
-- Row locking requires UPDATE on one column. These are lock-only for runtime;
-- no-op guard excludes mutation. Existing policy/subscription maintenance needs a
-- later separately reviewed source capability, not a blanket grant here.
CREATE FUNCTION public.lp086_lock_only() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 IF current_user='swat_app' THEN RAISE EXCEPTION '086 runtime privilege is row-lock-only'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.lp086_lock_only() FROM PUBLIC,swat_app;
CREATE TRIGGER lp086_guardrail_lock_only BEFORE UPDATE ON public.lp_guardrail_configs FOR EACH ROW EXECUTE FUNCTION public.lp086_lock_only();
CREATE TRIGGER lp086_subscription_lock_only BEFORE UPDATE ON public.lp_copy_subscriptions FOR EACH ROW EXECUTE FUNCTION public.lp086_lock_only();
GRANT UPDATE(max_pool_allocation_pct) ON public.lp_guardrail_configs TO swat_app;
GRANT UPDATE(status) ON public.lp_copy_subscriptions TO swat_app;
-- Verify restored ACLs, including absence of column backdoors. FORCE RLS and
-- row triggers do not prevent TRUNCATE, so exact ACL equality is mandatory.
DO $$ DECLARE rel oid; owner_oid oid:=(SELECT oid FROM pg_roles WHERE rolname='swat_migrator');
 app_oid oid:=(SELECT oid FROM pg_roles WHERE rolname='swat_app');
 admitter_oid oid:=(SELECT oid FROM pg_roles WHERE rolname='swat_lp_admitter'); BEGIN
 FOR rel IN SELECT oid FROM pg_class WHERE oid IN('public.lp_protected_quote_admissions'::regclass,'public.lp_protected_settlement_admissions'::regclass) LOOP
  IF (SELECT array_agg(a.grantor::text||':'||a.grantee::text||':'||a.privilege_type||':'||a.is_grantable::text ORDER BY a.grantor,a.grantee,a.privilege_type,a.is_grantable)
      FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a WHERE c.oid=rel)
    IS DISTINCT FROM (SELECT array_agg(e.grantor::text||':'||e.grantee::text||':'||e.privilege_type||':'||e.is_grantable::text ORDER BY e.grantor,e.grantee,e.privilege_type,e.is_grantable)
      FROM (SELECT grantor,grantee,privilege_type,is_grantable FROM aclexplode(acldefault('r',owner_oid))
       UNION ALL SELECT owner_oid,app_oid,'SELECT',false
       UNION ALL SELECT owner_oid,admitter_oid,'SELECT',false
       UNION ALL SELECT owner_oid,admitter_oid,'INSERT',false) e)
   OR EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=rel AND attnum>0 AND NOT attisdropped AND COALESCE(cardinality(attacl),0)<>0)
  THEN RAISE EXCEPTION '086 protected admissions canonical ACL restoration drift'; END IF;
 END LOOP;
 -- All LP context access of the admitter is SELECT-only, not merely policy-scoped.
 IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  CROSS JOIN LATERAL aclexplode(c.relacl) a WHERE n.nspname='public' AND c.relname LIKE 'lp_%'
   AND c.oid NOT IN('public.lp_protected_quote_admissions'::regclass,'public.lp_protected_settlement_admissions'::regclass)
   AND a.grantee=admitter_oid AND (a.privilege_type<>'SELECT' OR a.is_grantable OR a.grantor<>owner_oid))
  OR EXISTS(SELECT 1 FROM pg_attribute col JOIN pg_class c ON c.oid=col.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
   CROSS JOIN LATERAL aclexplode(col.attacl) a WHERE n.nspname='public' AND c.relname LIKE 'lp_%' AND col.attnum>0 AND NOT col.attisdropped
    AND a.grantee=admitter_oid AND (a.privilege_type<>'SELECT' OR a.is_grantable OR a.grantor<>owner_oid))
 THEN RAISE EXCEPTION '086 admitter context SELECT-only ACL drift'; END IF;
END $$;
-- LP admitter has restored SELECT-only context joins; it obtains no
-- row lock or UPDATE on runtime objects. Observer/provider/auth/capability/valuation
-- roles receive NO tenant table grants in086. Existing custody/risk/financial exact
-- grants and guards remain sealed in072/081/082; no memberships or bypass shortcut.
