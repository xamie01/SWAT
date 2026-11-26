-- SOURCE-ONLY forward proposal089. NOT installed, enabled, seeded or qualified.
-- SQL088 is independently owned. No broker transfer, membership, LOGIN, owner
-- transfer or old routine/trigger replacement. All new routines are migrator-owned
-- SECURITY INVOKER. Separate direct DBA source provisions disabled nonowning roles.
DO $guard$
DECLARE m oid; r record;
BEGIN
 IF current_user<>'swat_migrator' OR session_user<>'swat_migrator'
  OR current_setting('role')<>'none' OR current_setting('row_security')<>'on'
 THEN RAISE EXCEPTION '089 direct migrator required'; END IF;
 SELECT oid INTO m FROM pg_catalog.pg_roles WHERE rolname=current_user
  AND NOT(rolsuper OR rolbypassrls OR rolinherit OR rolcreaterole OR rolcreatedb OR rolreplication);
 IF m IS NULL OR EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=m OR roleid=m)
  OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname='public' AND nspowner=m)
 THEN RAISE EXCEPTION '089 migrator catalog drift'; END IF;
 FOR r IN SELECT * FROM pg_catalog.pg_roles WHERE rolname IN
  ('swat_wave4_authority_writer','swat_wave4_financial_writer','swat_lp_initializer','swat_custody_reader','swat_custody_observer') LOOP
  IF r.rolcanlogin OR r.rolsuper OR r.rolbypassrls OR r.rolinherit OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication
   OR EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid)
   OR EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE relowner=r.oid)
   OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE proowner=r.oid)
   OR EXISTS(SELECT 1 FROM pg_catalog.pg_namespace WHERE nspowner=r.oid OR has_schema_privilege(r.oid,oid,'CREATE'))
   OR EXISTS(SELECT 1 FROM pg_catalog.pg_database WHERE datdba=r.oid)
   OR has_database_privilege(r.oid,current_database(),'CREATE')
  THEN RAISE EXCEPTION '089 disabled nonowning role drift'; END IF;
 END LOOP;
 IF (SELECT count(*) FROM pg_catalog.pg_roles WHERE rolname IN
  ('swat_wave4_authority_writer','swat_wave4_financial_writer','swat_lp_initializer','swat_custody_reader','swat_custody_observer'))<>5
 THEN RAISE EXCEPTION '089 independently provisioned disabled roles missing'; END IF;
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relname LIKE 'wave4_%089')
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname LIKE 'wave4_%089')
 THEN RAISE EXCEPTION '089 unexpected preexisting catalog'; END IF;
END $guard$;

-- The approving service, not the application, persists complete independently
-- authenticated authority. identity_id+revision is immutable; revocation appends.
-- No authority rows are provided here. External services have backend=NULL;
-- database identities bind an actual direct PostgreSQL backend AND its start time.
CREATE TABLE public.wave4_authorities089 (
 user_id uuid NOT NULL, identity_id uuid NOT NULL, revision bigint NOT NULL CHECK(revision>0),
 domain text NOT NULL CHECK(domain IN('custody','lp','spot')),
 service_identity text NOT NULL CHECK(length(service_identity) BETWEEN 1 AND 256 AND service_identity<>'*'),
 provider_id text NOT NULL CHECK(length(provider_id) BETWEEN 1 AND 256 AND provider_id<>'*'),
 identity_kind text NOT NULL CHECK(identity_kind IN('database','external')),
 database_role name, database_oid oid, backend_pid integer, backend_start timestamptz,
 account_id text NOT NULL CHECK(length(account_id) BETWEEN 1 AND 256 AND account_id<>'*'),
 chain text NOT NULL, network_id text NOT NULL, deployment_id text NOT NULL,
 grant_id uuid REFERENCES public.user_execution_grants(id) ON DELETE RESTRICT,
 capabilities text[] NOT NULL CHECK(cardinality(capabilities) BETWEEN 1 AND 8),
 authority jsonb NOT NULL, authority_canonical text NOT NULL, authority_hash text NOT NULL,
 authentication jsonb NOT NULL, authenticated_at timestamptz NOT NULL,
 admitted_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL,
 PRIMARY KEY(user_id,identity_id,revision),
 FOREIGN KEY(user_id) REFERENCES public.users(id) ON DELETE RESTRICT,
 CHECK(authority_canonical::jsonb=authority AND authority_hash=encode(sha256(convert_to(authority_canonical,'UTF8')),'hex')),
 CHECK((identity_kind='external' AND database_role IS NULL AND database_oid IS NULL AND backend_pid IS NULL AND backend_start IS NULL)
  OR(identity_kind='database' AND database_role=service_identity::name AND database_oid IS NOT NULL AND backend_pid>0 AND backend_start IS NOT NULL)),
 CHECK(expires_at>authenticated_at)
);
CREATE TABLE public.wave4_authority_revocations089 (
 user_id uuid NOT NULL, identity_id uuid NOT NULL, revision bigint NOT NULL,
 revoked_at timestamptz NOT NULL DEFAULT clock_timestamp(), reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 256),
 PRIMARY KEY(user_id,identity_id,revision),
 FOREIGN KEY(user_id,identity_id,revision) REFERENCES public.wave4_authorities089(user_id,identity_id,revision) ON DELETE RESTRICT
);
-- Payload requests are separately admitted, not inferred from grant ownership.
-- pre-enrollment grantId has no FK: it deliberately precedes the grant INSERT.
-- Execution approvals instead require the authority's real grant_id FK above.
CREATE TABLE public.wave4_custody_requests089 (
 id uuid PRIMARY KEY, user_id uuid NOT NULL, identity_id uuid NOT NULL, authority_revision bigint NOT NULL,
 request jsonb NOT NULL, request_canonical text NOT NULL, request_hash text NOT NULL,
 grant_id uuid NOT NULL, capability text NOT NULL, payload_digest text NOT NULL CHECK(payload_digest ~ '^[a-f0-9]{64}$'),
 admitted_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL,
 UNIQUE(user_id,id), UNIQUE(user_id,identity_id,authority_revision,request_hash),
 FOREIGN KEY(user_id,identity_id,authority_revision) REFERENCES public.wave4_authorities089(user_id,identity_id,revision) ON DELETE RESTRICT,
 CHECK(request_canonical::jsonb=request AND request_hash=encode(sha256(convert_to(request_canonical,'UTF8')),'hex'))
);
CREATE TABLE public.wave4_custody_revocations089 (
 user_id uuid NOT NULL, request_id uuid NOT NULL, revoked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 256), PRIMARY KEY(user_id,request_id),
 FOREIGN KEY(user_id,request_id) REFERENCES public.wave4_custody_requests089(user_id,id) ON DELETE RESTRICT
);
CREATE TABLE public.wave4_lp_records089 (
 id uuid NOT NULL, user_id uuid NOT NULL, identity_id uuid NOT NULL, authority_revision bigint NOT NULL,
 revision bigint NOT NULL CHECK(revision>0), purpose text NOT NULL CHECK(purpose IN
  ('initialization','secret','quote','receipt','master','risk','quote-context','settlement-context')),
 selector text NOT NULL CHECK(length(selector) BETWEEN 1 AND 256 AND selector<>'*'),
 account_id text NOT NULL, chain text NOT NULL, network_id text NOT NULL,
 actions text[] NOT NULL CHECK(cardinality(actions) BETWEEN 1 AND 5),
 payload jsonb NOT NULL, payload_canonical text NOT NULL, payload_hash text NOT NULL,
 observed_at timestamptz NOT NULL, admitted_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL,
 subscription_id uuid,
 PRIMARY KEY(user_id,id), UNIQUE(user_id,account_id,chain,network_id,purpose,selector,revision),
 FOREIGN KEY(user_id,identity_id,authority_revision) REFERENCES public.wave4_authorities089(user_id,identity_id,revision) ON DELETE RESTRICT,
 -- Deliberately no subscription FK here: independent approval commits BEFORE
 -- canonical initialization. The separately persisted closure below owns that FK.
 CHECK(payload_canonical::jsonb=payload AND payload_hash=encode(sha256(convert_to(payload_canonical,'UTF8')),'hex')),
 CHECK((purpose='initialization')=(subscription_id IS NOT NULL))
);
CREATE TABLE public.wave4_lp_revocations089 (
 user_id uuid NOT NULL, record_id uuid NOT NULL, revoked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 256), PRIMARY KEY(user_id,record_id),
 FOREIGN KEY(user_id,record_id) REFERENCES public.wave4_lp_records089(user_id,id) ON DELETE RESTRICT
);
CREATE TABLE public.wave4_lp_initializations089 (
 user_id uuid NOT NULL, record_id uuid NOT NULL, subscription_id uuid NOT NULL,
 initialized_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(user_id,record_id),
 FOREIGN KEY(user_id,record_id) REFERENCES public.wave4_lp_records089(user_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(subscription_id,user_id) REFERENCES public.lp_copy_subscriptions(id,user_id) ON DELETE RESTRICT
);
-- Exact immutable financial intent/attempt/receipt -> explicit lot-exit execution.
-- evidence_input is the COMPLETE canonical recordCopyExecutionEvidence input,
-- not merely an evidence ID. Evidence is written later on the app's SAME client.
CREATE TABLE public.wave4_spot_admissions089 (
 user_id uuid NOT NULL, receipt_id text PRIMARY KEY, intent_id uuid NOT NULL, attempt_id uuid NOT NULL,
 identity_id uuid NOT NULL, authority_revision bigint NOT NULL,
 execution_id uuid NOT NULL REFERENCES public.copy_executions(id) ON DELETE RESTRICT,
 lot_id uuid NOT NULL REFERENCES public.copy_position_master_lots(id) ON DELETE RESTRICT,
 position_id uuid NOT NULL REFERENCES public.copy_positions(id) ON DELETE RESTRICT,
 chain text NOT NULL, network_id text NOT NULL, mode text NOT NULL, account_id text NOT NULL,
 asset_id text NOT NULL, asset_scale integer NOT NULL CHECK(asset_scale BETWEEN 0 AND 36),
 fee_asset_id text NOT NULL, fee_asset_scale integer NOT NULL CHECK(fee_asset_scale BETWEEN 0 AND 36), fee_account_id text NOT NULL,
 delta_raw numeric(78,0) NOT NULL CHECK(delta_raw>0), delta_fee_raw numeric(78,0) NOT NULL CHECK(delta_fee_raw>=0),
 intent jsonb NOT NULL, intent_hash text NOT NULL, attempt_binding jsonb NOT NULL, receipt jsonb NOT NULL, receipt_hash text NOT NULL,
 evidence_input jsonb NOT NULL, evidence_canonical text NOT NULL, evidence_hash text NOT NULL,
 economics jsonb NOT NULL, economics_canonical text NOT NULL, economics_hash text NOT NULL,
 accounting_reference text NOT NULL UNIQUE, admitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(user_id,receipt_id),
 FOREIGN KEY(user_id,identity_id,authority_revision) REFERENCES public.wave4_authorities089(user_id,identity_id,revision) ON DELETE RESTRICT,
 FOREIGN KEY(intent_id,user_id) REFERENCES public.withdrawal_reducing_intents(id,user_id) ON DELETE RESTRICT,
 FOREIGN KEY(attempt_id,intent_id,user_id) REFERENCES public.withdrawal_reducing_attempts(id,intent_id,user_id) ON DELETE RESTRICT,
 FOREIGN KEY(receipt_id) REFERENCES public.withdrawal_reducing_receipts(receipt_id) ON DELETE RESTRICT,
 CHECK(evidence_canonical::jsonb=evidence_input AND evidence_hash=encode(sha256(convert_to(evidence_canonical,'UTF8')),'hex')),
 CHECK(economics_canonical::jsonb=economics AND economics_hash=encode(sha256(convert_to(economics_canonical,'UTF8')),'hex'))
);
CREATE TABLE public.wave4_spot_settlements089 (
 user_id uuid NOT NULL, receipt_id text PRIMARY KEY, evidence_id uuid NOT NULL UNIQUE REFERENCES public.copy_execution_evidence(id) ON DELETE RESTRICT,
 accounting_reference text NOT NULL UNIQUE, before_raw numeric(78,0) NOT NULL, after_raw numeric(78,0) NOT NULL,
 settled_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(user_id,receipt_id) REFERENCES public.wave4_spot_admissions089(user_id,receipt_id) ON DELETE RESTRICT,
 CHECK(before_raw>=after_raw AND after_raw>=0)
);

CREATE FUNCTION public.wave4_direct089(expected_role text,tenant uuid) RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE r record;
BEGIN
 IF current_user::text IS DISTINCT FROM expected_role OR session_user::text IS DISTINCT FROM expected_role
  OR current_setting('role')<>'none' OR current_setting('row_security')<>'on'
  OR public.current_app_user_id() IS DISTINCT FROM tenant
  OR COALESCE(current_setting('app.bypass_rls',true),'off')<>'off'
 THEN RAISE EXCEPTION '089 direct scoped identity required' USING ERRCODE='42501'; END IF;
 SELECT * INTO r FROM pg_catalog.pg_roles WHERE rolname=current_user;
 IF NOT r.rolcanlogin OR r.rolsuper OR r.rolbypassrls OR r.rolinherit OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid)
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE relowner=r.oid)
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE proowner=r.oid)
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_namespace WHERE nspowner=r.oid OR has_schema_privilege(r.oid,oid,'CREATE'))
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_database WHERE datdba=r.oid)
  OR has_database_privilege(r.oid,current_database(),'CREATE')
 THEN RAISE EXCEPTION '089 restricted direct role catalog drift'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(tenant::text||':financial089',0));
 RETURN true;
END $$;
CREATE FUNCTION public.wave4_authority_current089(tenant uuid,identity uuid,rev bigint) RETURNS boolean LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM public.wave4_authorities089 a
  WHERE a.user_id=tenant AND a.identity_id=identity AND a.revision=rev
   AND a.admitted_at<=clock_timestamp() AND a.expires_at>clock_timestamp()
   AND NOT EXISTS(SELECT 1 FROM public.wave4_authority_revocations089 v WHERE v.user_id=a.user_id AND v.identity_id=a.identity_id AND v.revision=a.revision)
   AND NOT EXISTS(SELECT 1 FROM public.wave4_authorities089 later WHERE later.user_id=a.user_id AND later.identity_id=a.identity_id AND later.revision>a.revision)
   -- No genuine cross-role backend observation seam: database rows fail closed.
   -- Foreign pg_stat_activity fields or pg_read_all_stats cannot authenticate them.
   AND a.identity_kind='external')
$$;
CREATE FUNCTION public.wave4_registry_guard089() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE a public.wave4_authorities089; t timestamptz:=date_trunc('milliseconds',clock_timestamp()); prior bigint;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION '089 protected revisions append only'; END IF;
  PERFORM public.wave4_direct089('swat_wave4_authority_writer',NEW.user_id);
 t:=date_trunc('milliseconds',clock_timestamp());
 IF TG_TABLE_NAME='wave4_authorities089' THEN
  IF NEW.identity_kind='database' THEN
   RAISE EXCEPTION '089 genuine protected cross-role backend observation strategy unavailable' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.user_id::text||':'||NEW.identity_id::text,0));
  SELECT COALESCE(max(revision),0) INTO prior FROM public.wave4_authorities089 WHERE user_id=NEW.user_id AND identity_id=NEW.identity_id;
  IF NEW.revision<>prior+1 OR NEW.authenticated_at>t OR NEW.expires_at<=t
   OR NEW.authority IS DISTINCT FROM jsonb_build_object('userId',NEW.user_id,'identityId',NEW.identity_id,'revision',NEW.revision::text,
    'domain',NEW.domain,'serviceIdentity',NEW.service_identity,'providerId',NEW.provider_id,'identityKind',NEW.identity_kind,
    'databaseRole',NEW.database_role,'databaseOid',NEW.database_oid::text,'backendPid',NEW.backend_pid,'backendStart',
    CASE WHEN NEW.backend_start IS NULL THEN NULL ELSE to_char(NEW.backend_start AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,
    'accountId',NEW.account_id,'chain',NEW.chain,'networkId',NEW.network_id,'deploymentId',NEW.deployment_id,'grantId',NEW.grant_id,
    'capabilities',to_jsonb(NEW.capabilities),'authenticatedAt',to_char(NEW.authenticated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'expiresAt',to_char(NEW.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
   OR (SELECT count(DISTINCT x) FROM unnest(NEW.capabilities) x)<>cardinality(NEW.capabilities)
  THEN RAISE EXCEPTION '089 complete sequential independently authenticated authority required'; END IF;
  PERFORM public.lp085_fields(NEW.authentication,ARRAY['issuer','receiptId','payloadHash','verifiedAt']);
  IF NEW.authentication->>'payloadHash' IS DISTINCT FROM NEW.authority_hash
   OR public.lp085_time(NEW.authentication->'verifiedAt') IS DISTINCT FROM NEW.authenticated_at
  THEN RAISE EXCEPTION '089 authority authentication payload mismatch'; END IF;
  IF NEW.domain='custody' THEN
   IF NEW.chain NOT IN('polygon','robinhood-chain') OR NEW.network_id IS DISTINCT FROM (CASE NEW.chain WHEN 'polygon' THEN '137' ELSE '4663' END)
    OR NEW.account_id !~ '^0x[0-9a-f]{40}$'
    OR NOT(NEW.capabilities<@ARRAY['wrap-only','secret-admission','grant-enrollment','grant-lifecycle','execution-secret-read','execution-unwrap','deployed-inspection','scoped-execution'])
    OR NOT(NEW.capabilities=ARRAY['wrap-only'] OR NEW.capabilities=ARRAY['secret-admission']
      OR NEW.capabilities=ARRAY['grant-enrollment','grant-lifecycle'] OR NEW.capabilities=ARRAY['execution-secret-read','scoped-execution']
      OR NEW.capabilities=ARRAY['execution-secret-read'] OR NEW.capabilities=ARRAY['execution-unwrap']
      OR NEW.capabilities=ARRAY['deployed-inspection','scoped-execution'])
    OR(NEW.identity_kind='database' AND NOT(
      (NEW.service_identity='swat_app' AND NEW.capabilities=ARRAY['grant-enrollment','grant-lifecycle'])
      OR(NEW.service_identity='swat_custody_writer' AND NEW.capabilities=ARRAY['secret-admission'])
      OR(NEW.service_identity='swat_custody_reader' AND NEW.capabilities=ARRAY['execution-secret-read','scoped-execution'])
      OR(NEW.service_identity='swat_custody_observer' AND NEW.capabilities=ARRAY['execution-secret-read'])))
    OR(NEW.capabilities && ARRAY['execution-secret-read','execution-unwrap','deployed-inspection','scoped-execution'] AND NEW.grant_id IS NULL)
    OR(NEW.grant_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.user_execution_grants g WHERE g.id=NEW.grant_id AND g.user_id=NEW.user_id
      AND g.chain=NEW.chain AND g.account_address=NEW.account_id))
   THEN RAISE EXCEPTION '089 custody least privilege/deployed scope mismatch'; END IF;
  ELSIF NEW.domain='lp' THEN
   IF left(NEW.account_id,length(NEW.chain)+1)<>NEW.chain||':' OR left(NEW.network_id,length(NEW.chain)+1)<>NEW.chain||':'
    OR NOT(NEW.capabilities<@ARRAY['initialization','secret','quote','receipt','master','risk','quote-context','settlement-context'])
    OR NEW.grant_id IS NOT NULL
   THEN RAISE EXCEPTION '089 exact LP action/network authority required'; END IF;
  ELSIF NEW.capabilities<>ARRAY['spot-settlement'] OR NEW.identity_kind<>'external' OR NEW.grant_id IS NOT NULL THEN
   RAISE EXCEPTION '089 independent spot settlement authority required';
  END IF;
  NEW.admitted_at:=t;
 ELSIF TG_TABLE_NAME='wave4_custody_requests089' THEN
  SELECT * INTO a FROM public.wave4_authorities089 WHERE user_id=NEW.user_id AND identity_id=NEW.identity_id AND revision=NEW.authority_revision;
  IF a.domain IS DISTINCT FROM 'custody' OR NOT public.wave4_authority_current089(a.user_id,a.identity_id,a.revision)
   OR NOT(NEW.capability=ANY(a.capabilities)) OR NEW.expires_at> a.expires_at OR NEW.expires_at<=t
   OR NEW.request IS DISTINCT FROM jsonb_build_object('capability',NEW.capability,'identity',a.service_identity,'userId',NEW.user_id,
      'grantId',NEW.grant_id,'deploymentId',a.deployment_id,'chain',a.chain,'chainId',a.network_id,'payloadDigest',NEW.payload_digest)
   OR(a.grant_id IS NOT NULL AND a.grant_id IS DISTINCT FROM NEW.grant_id)
  THEN RAISE EXCEPTION '089 exact authenticated custody request required'; END IF;
  NEW.admitted_at:=t;
 ELSE
  -- The same transaction lock serializes revocation with readers and writers.
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.user_id::text||':financial089',0));
  NEW.revoked_at:=clock_timestamp();
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION public.wave4_custody_lookup089(tenant uuid,requested jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE q public.wave4_custody_requests089; a public.wave4_authorities089;
BEGIN
 IF tenant IS DISTINCT FROM public.current_app_user_id() OR session_user<>current_user OR current_setting('role')<>'none'
  OR current_setting('row_security')<>'on' OR COALESCE(current_setting('app.bypass_rls',true),'off')<>'off' THEN
  RAISE EXCEPTION '089 custody lookup direct tenant required'; END IF;
 SELECT r.* INTO q FROM public.wave4_custody_requests089 r JOIN public.wave4_authorities089 x
  ON(x.user_id,x.identity_id,x.revision)=(r.user_id,r.identity_id,r.authority_revision)
  WHERE r.user_id=tenant AND r.request=requested AND r.admitted_at<=clock_timestamp() AND r.expires_at>clock_timestamp()
   AND public.wave4_authority_current089(x.user_id,x.identity_id,x.revision)
   AND NOT EXISTS(SELECT 1 FROM public.wave4_custody_revocations089 v WHERE v.user_id=r.user_id AND v.request_id=r.id);
 IF q.id IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO a FROM public.wave4_authorities089 WHERE user_id=q.user_id AND identity_id=q.identity_id AND revision=q.authority_revision;
 RETURN jsonb_build_object('request',q.request,'approved',true,'validUntil',to_char(LEAST(q.expires_at,a.expires_at) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'capabilities',to_jsonb(a.capabilities));
END $$;
CREATE FUNCTION public.wave4_custody_scope089(tenant uuid,requested_grant uuid) RETURNS boolean LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT tenant=public.current_app_user_id() AND session_user=current_user AND current_setting('role')='none'
  AND current_setting('row_security')='on' AND COALESCE(current_setting('app.bypass_rls',true),'off')='off'
  AND EXISTS(SELECT 1 FROM public.wave4_authorities089 a WHERE a.user_id=tenant AND a.grant_id=requested_grant
   AND a.database_role=current_user AND a.backend_pid=pg_backend_pid()
   AND a.domain='custody' AND 'execution-secret-read'=ANY(a.capabilities)
   AND public.wave4_authority_current089(a.user_id,a.identity_id,a.revision))
$$;
CREATE FUNCTION public.wave4_lp_guard089() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE a public.wave4_authorities089; t timestamptz:=date_trunc('milliseconds',clock_timestamp()); prior bigint; p jsonb:=NEW.payload;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION '089 LP provenance immutable'; END IF;
 PERFORM public.wave4_direct089(CASE WHEN NEW.purpose='initialization' THEN 'swat_wave4_authority_writer' ELSE 'swat_wave4_financial_writer' END,NEW.user_id);
 t:=date_trunc('milliseconds',clock_timestamp());
 SELECT * INTO a FROM public.wave4_authorities089 WHERE user_id=NEW.user_id AND identity_id=NEW.identity_id AND revision=NEW.authority_revision;
 IF a.domain IS DISTINCT FROM 'lp' OR NOT public.wave4_authority_current089(a.user_id,a.identity_id,a.revision)
  OR NOT(NEW.purpose=ANY(a.capabilities)) OR (a.account_id,a.chain,a.network_id) IS DISTINCT FROM (NEW.account_id,NEW.chain,NEW.network_id)
  OR NEW.observed_at>t OR NEW.expires_at<=t OR NEW.expires_at>a.expires_at
  OR(SELECT count(DISTINCT x) FROM unnest(NEW.actions) x)<>cardinality(NEW.actions)
  OR NOT(NEW.actions<@ARRAY['acquire','copy','rebalance','close','recover'])
 THEN RAISE EXCEPTION '089 current exact LP provenance authority required'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws(':',NEW.user_id,NEW.account_id,NEW.chain,NEW.network_id,NEW.purpose,NEW.selector),0));
 SELECT COALESCE(max(revision),0) INTO prior FROM public.wave4_lp_records089 WHERE user_id=NEW.user_id AND account_id=NEW.account_id
  AND chain=NEW.chain AND network_id=NEW.network_id AND purpose=NEW.purpose AND selector=NEW.selector;
 IF NEW.revision<>prior+1 OR jsonb_typeof(p) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION '089 complete sequential LP payload required'; END IF;
 IF NEW.purpose='initialization' THEN
  PERFORM public.lp085_fields(p,ARRAY['subscription','poolCapBps']);
  PERFORM public.lp085_fields(p->'subscription',ARRAY['id','userId','masterWalletAddress','chain','venue','budgetMicroUsd','capMicroUsd','status','createdAt','revision']);
  IF p->'subscription'->>'id' IS DISTINCT FROM NEW.subscription_id::text OR p->'subscription'->>'userId' IS DISTINCT FROM NEW.user_id::text
   OR p->'subscription'->>'chain' IS DISTINCT FROM NEW.chain OR p->'subscription'->>'status' IS DISTINCT FROM 'active'
   OR public.lp085_micro(p->'subscription'->'budgetMicroUsd')<=0 OR public.lp085_micro(p->'subscription'->'capMicroUsd')<=0
   OR (p->>'poolCapBps') !~ '^[1-9][0-9]{0,4}$' OR (p->>'poolCapBps')::integer>10000
   OR public.lp085_time(p->'subscription'->'createdAt')>t OR p->'subscription'->>'revision' !~ '^[a-f0-9]{64}$'
  THEN RAISE EXCEPTION '089 exact LP initialization payload required'; END IF;
 ELSIF NEW.purpose='secret' THEN
  PERFORM public.lp085_fields(p,ARRAY['secretAdmissionId','accountId','actions']); PERFORM(p->>'secretAdmissionId')::uuid;
  IF p->>'accountId' IS DISTINCT FROM NEW.account_id OR p->'actions' IS DISTINCT FROM '["acquire","copy","rebalance","close","recover"]'::jsonb
   OR NEW.actions<>ARRAY['acquire','copy','rebalance','close','recover'] OR (SELECT count(*) FROM jsonb_object_keys(p))<>3
  THEN RAISE EXCEPTION '089 LP secret is an admission reference only, never bytes'; END IF;
 ELSIF NEW.purpose='quote' THEN
  PERFORM public.lp085_fields(p,ARRAY['version','providerId','quoteId','userId','intentHash','action','mode','pool','deposit','unitPriceUsd','valueMicroUsd','amountAfter','proceedsMicroUsd','observedAt','expiresAt']);
  IF p->>'quoteId' IS DISTINCT FROM NEW.selector OR p->>'providerId' IS DISTINCT FROM a.provider_id OR p->>'userId' IS DISTINCT FROM NEW.user_id::text
   OR p->'pool'->>'chain' IS DISTINCT FROM NEW.chain OR p->'pool'->>'networkId' IS DISTINCT FROM NEW.network_id
   OR NOT(p->>'action'=ANY(NEW.actions)) OR p->>'mode' IS DISTINCT FROM 'paper'
   OR public.lp085_time(p->'observedAt') IS DISTINCT FROM NEW.observed_at OR public.lp085_time(p->'pool'->'observedAt')>t
   OR public.lp085_time(p->'expiresAt')<NEW.expires_at THEN RAISE EXCEPTION '089 quote provider/action/network chronology mismatch'; END IF;
 ELSIF NEW.purpose='receipt' THEN
  PERFORM public.lp085_fields(p,ARRAY['version','providerId','receiptId','receiptKey','userId','positionId','positionRevision','mode','action','networkId','chain','protocol','poolAddress','depositAsset','quoteId','quoteHash','amountBefore','amountAfter','proceedsMicroUsd','collectedFeesMicroUsd','executionCostsMicroUsd','settledAt','finality']);
  IF p->>'receiptId' IS DISTINCT FROM NEW.selector OR p->>'providerId' IS DISTINCT FROM a.provider_id OR p->>'userId' IS DISTINCT FROM NEW.user_id::text
   OR p->>'chain' IS DISTINCT FROM NEW.chain OR p->>'networkId' IS DISTINCT FROM NEW.network_id OR NOT(p->>'action'=ANY(NEW.actions))
   OR p->>'mode' IS DISTINCT FROM 'paper' OR p->>'finality' IS DISTINCT FROM 'paper-settled' OR public.lp085_time(p->'settledAt') IS DISTINCT FROM NEW.observed_at
  THEN RAISE EXCEPTION '089 receipt exact protocol chronology mismatch'; END IF;
 ELSIF NEW.purpose='master' THEN
  PERFORM public.lp085_fields(p,ARRAY['providerId','eventId','chain','networkId','protocol','masterWalletAddress','masterPositionId','poolAddress','depositAsset','action','finality','provenance','openedAt','observedAt','masterDepositMicroUsd','strategy']);
  IF p->>'eventId' IS DISTINCT FROM NEW.selector OR p->>'providerId' IS DISTINCT FROM a.provider_id OR p->>'chain' IS DISTINCT FROM NEW.chain
   OR p->>'networkId' IS DISTINCT FROM NEW.network_id OR p->>'action' IS DISTINCT FROM 'mint' OR p->>'finality' IS DISTINCT FROM 'finalized'
   OR public.lp085_time(p->'observedAt') IS DISTINCT FROM NEW.observed_at OR public.lp085_time(p->'openedAt')>NEW.observed_at
  THEN RAISE EXCEPTION '089 master exact event scope mismatch'; END IF;
 ELSIF NEW.purpose='risk' THEN
  PERFORM public.lp085_fields(p,ARRAY['providerId','userId','subscriptionId','subscriptionRevision','masterEvidenceHash','intentHash','poolEvidenceId','approved','observedAt']);
  IF p->>'providerId' IS DISTINCT FROM a.provider_id OR p->>'userId' IS DISTINCT FROM NEW.user_id::text
   OR p->>'intentHash' IS DISTINCT FROM NEW.selector OR public.lp085_time(p->'observedAt') IS DISTINCT FROM NEW.observed_at
   OR NOT('copy'=ANY(NEW.actions)) THEN RAISE EXCEPTION '089 risk provider chronology mismatch'; END IF;
 ELSIF NEW.purpose='quote-context' THEN
  PERFORM public.lp085_fields(p,ARRAY['kind','commit']);
  IF p->>'kind' NOT IN('acquisition','operation') OR p->'commit'->'quote'->>'userId' IS DISTINCT FROM NEW.user_id::text
   OR p->'commit'->'quote'->'pool'->>'chain' IS DISTINCT FROM NEW.chain OR p->'commit'->'quote'->'pool'->>'networkId' IS DISTINCT FROM NEW.network_id
   OR p->'commit'->'quote'->>'providerId' IS DISTINCT FROM a.provider_id OR NOT(p->'commit'->'quote'->>'action'=ANY(NEW.actions))
  THEN RAISE EXCEPTION '089 complete quote context scope mismatch'; END IF;
 ELSE
  PERFORM public.lp085_fields(p,ARRAY['operation','position','operationCreatedAt']);
  IF p->'operation'->>'id' IS DISTINCT FROM NEW.selector OR p->'operation'->>'userId' IS DISTINCT FROM NEW.user_id::text
   OR p->'position'->>'userId' IS DISTINCT FROM NEW.user_id::text OR p->'position'->>'chain' IS DISTINCT FROM NEW.chain
   OR p->'operation'->'quote'->'pool'->>'networkId' IS DISTINCT FROM NEW.network_id
   OR p->'operation'->'quote'->>'providerId' IS DISTINCT FROM a.provider_id OR NOT(p->'operation'->>'action'=ANY(NEW.actions))
   OR public.lp085_time(p->'operationCreatedAt')>t THEN RAISE EXCEPTION '089 complete settlement context mismatch'; END IF;
 END IF;
 NEW.admitted_at:=t; RETURN NEW;
END $$;
CREATE FUNCTION public.wave4_lp_lookup089(tenant uuid,account text,requested_chain text,network text,requested_purpose text,requested_selector text) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE p public.wave4_lp_records089; a public.wave4_authorities089;
BEGIN
 IF tenant IS DISTINCT FROM public.current_app_user_id() OR session_user<>current_user OR current_setting('role')<>'none'
  OR current_setting('row_security')<>'on' OR COALESCE(current_setting('app.bypass_rls',true),'off')<>'off'
 THEN RAISE EXCEPTION '089 LP lookup direct tenant required'; END IF;
 PERFORM public.wave4_direct089(current_user::text,tenant);
 SELECT * INTO p FROM public.wave4_lp_records089 WHERE user_id=tenant AND account_id=account AND chain=requested_chain AND network_id=network
  AND purpose=requested_purpose AND selector=requested_selector ORDER BY revision DESC LIMIT 1;
 IF p.id IS NULL OR p.admitted_at>clock_timestamp() OR p.observed_at>p.admitted_at OR p.expires_at<=clock_timestamp()
  OR EXISTS(SELECT 1 FROM public.wave4_lp_revocations089 v WHERE v.user_id=p.user_id AND v.record_id=p.id)
  OR NOT public.wave4_authority_current089(p.user_id,p.identity_id,p.authority_revision) THEN RETURN NULL; END IF;
 SELECT * INTO a FROM public.wave4_authorities089 WHERE user_id=p.user_id AND identity_id=p.identity_id AND revision=p.authority_revision;
 IF a.domain IS DISTINCT FROM 'lp' OR NOT(p.purpose=ANY(a.capabilities))
  OR(a.account_id,a.chain,a.network_id) IS DISTINCT FROM(p.account_id,p.chain,p.network_id)
  OR p.expires_at>a.expires_at THEN RETURN NULL; END IF;
 -- Runtime/admitter initialization reads require the real canonical closure; an
 -- approval alone cannot pretend that the initializer performed its writes.
 IF p.purpose='initialization' AND current_user IN('swat_app','swat_lp_admitter')
  AND NOT EXISTS(SELECT 1 FROM public.wave4_lp_initializations089 x WHERE x.user_id=p.user_id AND x.record_id=p.id AND x.subscription_id=p.subscription_id)
 THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('id',p.id,'identityId',p.identity_id,'providerId',a.provider_id,'binding',
  jsonb_build_object('userId',p.user_id,'accountId',p.account_id,'chain',p.chain,'networkId',p.network_id),
  'purpose',p.purpose,'selector',p.selector,'payload',p.payload,'payloadHash',p.payload_hash,
  'admittedAt',to_char(p.admitted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'expiresAt',to_char(LEAST(p.expires_at,a.expires_at) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'revokedAt',NULL);
END $$;
CREATE FUNCTION public.wave4_lp_initialize089(tenant uuid,record_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE p public.wave4_lp_records089; selected jsonb; s jsonb; budget text; cap text; canonical text; existing public.lp_copy_subscriptions; guardrail public.lp_guardrail_configs;
BEGIN
 PERFORM public.wave4_direct089('swat_lp_initializer',tenant);
 SELECT * INTO p FROM public.wave4_lp_records089 WHERE user_id=tenant AND id=record_id AND purpose='initialization';
 selected:=public.wave4_lp_lookup089(tenant,p.account_id,p.chain,p.network_id,p.purpose,p.selector);
 IF p.id IS NULL OR selected IS NULL OR selected->>'id' IS DISTINCT FROM p.id::text THEN
  RAISE EXCEPTION '089 separately approved initialization required'; END IF;
 s:=p.payload->'subscription';
 budget:=((s->>'budgetMicroUsd')::numeric/1000000)::numeric(78,6)::text;
 cap:=((s->>'capMicroUsd')::numeric/1000000)::numeric(78,6)::text;
 canonical:='{"budget":'||to_json(budget)::text||',"cap":'||to_json(cap)::text||',"status":"active","updatedAt":'||to_json(s->>'createdAt')::text||'}';
 IF s->>'revision' IS DISTINCT FROM encode(sha256(convert_to(canonical,'UTF8')),'hex') THEN RAISE EXCEPTION '089 canonical subscription revision mismatch'; END IF;
 INSERT INTO public.lp_copy_subscriptions(id,user_id,master_wallet_address,chain,venue,allocated_budget_usd,max_capital_per_position_usd,status,created_at,updated_at)
 VALUES((s->>'id')::uuid,tenant,s->>'masterWalletAddress',s->>'chain',s->>'venue',budget::numeric,cap::numeric,'active',
  public.lp085_time(s->'createdAt'),public.lp085_time(s->'createdAt')) ON CONFLICT DO NOTHING;
 SELECT * INTO existing FROM public.lp_copy_subscriptions WHERE id=(s->>'id')::uuid AND user_id=tenant;
 IF existing.id IS NULL OR(existing.master_wallet_address,existing.chain,existing.venue,existing.allocated_budget_usd::text,existing.max_capital_per_position_usd::text,
    existing.status,existing.created_at,existing.updated_at) IS DISTINCT FROM(s->>'masterWalletAddress',s->>'chain',s->>'venue',budget,cap,'active',
    public.lp085_time(s->'createdAt'),public.lp085_time(s->'createdAt')) THEN RAISE EXCEPTION '089 exact subscription initialization conflict'; END IF;
 -- Complete initial guardrail policy: cap, no profit sweep, no reserve. No UPDATE
 -- privilege or app initialization shortcut; existing nonidentical config refuses.
 INSERT INTO public.lp_guardrail_configs(user_id,max_pool_allocation_pct,profit_bank_pct,reserve_sub_vault_chain,reserve_sub_vault_address,updated_at)
 VALUES(tenant,(p.payload->>'poolCapBps')::numeric/100,0,NULL,NULL,public.lp085_time(s->'createdAt')) ON CONFLICT DO NOTHING;
 SELECT * INTO guardrail FROM public.lp_guardrail_configs WHERE user_id=tenant;
 IF(guardrail.max_pool_allocation_pct,guardrail.profit_bank_pct,guardrail.reserve_sub_vault_chain,guardrail.reserve_sub_vault_address,guardrail.updated_at)
  IS DISTINCT FROM((p.payload->>'poolCapBps')::numeric/100,0::numeric,NULL::varchar,NULL::varchar,public.lp085_time(s->'createdAt'))
 THEN RAISE EXCEPTION '089 complete guardrail initialization conflict'; END IF;
 INSERT INTO public.wave4_lp_initializations089(user_id,record_id,subscription_id) VALUES(tenant,p.id,p.subscription_id) ON CONFLICT DO NOTHING;
 RETURN p.payload;
END $$;
CREATE FUNCTION public.wave4_lp_initialization_guard089() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE p public.wave4_lp_records089; s public.lp_copy_subscriptions; g public.lp_guardrail_configs; selected jsonb;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION '089 initialization closure immutable'; END IF;
 PERFORM public.wave4_direct089('swat_lp_initializer',NEW.user_id);
 SELECT * INTO p FROM public.wave4_lp_records089 WHERE user_id=NEW.user_id AND id=NEW.record_id AND purpose='initialization';
 selected:=public.wave4_lp_lookup089(NEW.user_id,p.account_id,p.chain,p.network_id,p.purpose,p.selector);
 SELECT * INTO s FROM public.lp_copy_subscriptions WHERE id=NEW.subscription_id AND user_id=NEW.user_id;
 SELECT * INTO g FROM public.lp_guardrail_configs WHERE user_id=NEW.user_id;
 IF p.id IS NULL OR selected IS NULL OR selected->>'id' IS DISTINCT FROM p.id::text OR p.subscription_id IS DISTINCT FROM NEW.subscription_id
  OR s.id IS NULL OR g.user_id IS NULL
  OR(s.master_wallet_address,s.chain,s.venue,s.allocated_budget_usd,s.max_capital_per_position_usd,s.status,s.created_at,s.updated_at)
   IS DISTINCT FROM(p.payload->'subscription'->>'masterWalletAddress',p.chain,p.payload->'subscription'->>'venue',
    (p.payload->'subscription'->>'budgetMicroUsd')::numeric/1000000,(p.payload->'subscription'->>'capMicroUsd')::numeric/1000000,'active',
    public.lp085_time(p.payload->'subscription'->'createdAt'),public.lp085_time(p.payload->'subscription'->'createdAt'))
  OR(g.max_pool_allocation_pct,g.profit_bank_pct,g.reserve_sub_vault_chain,g.reserve_sub_vault_address,g.updated_at)
   IS DISTINCT FROM((p.payload->>'poolCapBps')::numeric/100,0::numeric,NULL::varchar,NULL::varchar,s.created_at)
 THEN RAISE EXCEPTION '089 exact independently approved canonical initialization closure required'; END IF;
 NEW.initialized_at:=clock_timestamp(); RETURN NEW;
END $$;

CREATE FUNCTION public.wave4_spot_guard089() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE i public.withdrawal_reducing_intents; a public.withdrawal_reducing_attempts; r public.withdrawal_reducing_receipts;
 e public.copy_executions; lot public.copy_position_master_lots; authority public.wave4_authorities089; t timestamptz:=date_trunc('milliseconds',clock_timestamp());
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION '089 exact spot admission immutable'; END IF;
 PERFORM public.wave4_direct089('swat_financial_receipt_writer',NEW.user_id);
 t:=date_trunc('milliseconds',clock_timestamp());
 -- Read immutable real chains. The tenant lock serializes 089 admission/revocation;
 -- canonical financial settlement independently locks its parent/attempt.
 PERFORM public.lp085_fields(NEW.intent,ARRAY['version','kind','userId','requestKey','chain','network','venue','positionId','accountId','assetId','assetScale','mode','positionSide','side','quantityRaw','maxFeeRaw','limitPriceExact','expectedRevision','expiresAt']);
 PERFORM public.lp085_fields(NEW.receipt,ARRAY['receiptId','providerIdentity','proof','intentId','intentHash','attemptId','clientOrderId','cumulativeRaw','feeRaw','feeAssetId','feeAssetScale','feeFundingAccountId','terminal','outcome','observedAt']);
 SELECT * INTO i FROM public.withdrawal_reducing_intents WHERE id=NEW.intent_id AND user_id=NEW.user_id;
 SELECT * INTO a FROM public.withdrawal_reducing_attempts WHERE id=NEW.attempt_id AND intent_id=i.id AND user_id=i.user_id;
 SELECT * INTO r FROM public.withdrawal_reducing_receipts WHERE receipt_id=NEW.receipt_id AND attempt_id=a.id AND intent_id=i.id AND user_id=i.user_id;
 SELECT * INTO e FROM public.copy_executions WHERE id=NEW.execution_id AND user_id=NEW.user_id;
 SELECT * INTO lot FROM public.copy_position_master_lots WHERE id=NEW.lot_id AND user_id=NEW.user_id AND position_id=NEW.position_id;
 SELECT * INTO authority FROM public.wave4_authorities089 WHERE user_id=NEW.user_id AND identity_id=NEW.identity_id AND revision=NEW.authority_revision;
 IF i.id IS NULL OR a.id IS NULL OR r.receipt_id IS NULL OR e.id IS NULL OR lot.id IS NULL
  OR authority.domain IS DISTINCT FROM 'spot' OR NOT public.wave4_authority_current089(authority.user_id,authority.identity_id,authority.revision)
  OR(authority.account_id,authority.chain,authority.network_id) IS DISTINCT FROM(NEW.account_id,NEW.chain,NEW.network_id)
  OR i.kind IS DISTINCT FROM 'reducing' OR i.intent->>'venue' IS DISTINCT FROM 'spot'
  OR i.intent IS DISTINCT FROM NEW.intent OR i.intent_hash IS DISTINCT FROM NEW.intent_hash OR a.intent_hash IS DISTINCT FROM NEW.intent_hash
  OR NEW.attempt_binding IS DISTINCT FROM jsonb_build_object('id',a.id,'intentId',a.intent_id,'userId',a.user_id,'clientOrderId',a.client_order_id,'intentHash',a.intent_hash)
  OR r.receipt IS DISTINCT FROM NEW.receipt OR r.receipt_hash IS DISTINCT FROM NEW.receipt_hash
  OR authority.provider_id IS DISTINCT FROM r.provider_identity OR r.outcome IS DISTINCT FROM 'fill'
  OR r.observed_at>t OR r.admitted_at>t OR r.observed_at<a.created_at
  OR NEW.receipt->>'intentId' IS DISTINCT FROM i.id::text OR NEW.receipt->>'intentHash' IS DISTINCT FROM i.intent_hash
  OR NEW.receipt->>'attemptId' IS DISTINCT FROM a.id::text OR NEW.receipt->>'clientOrderId' IS DISTINCT FROM a.client_order_id
  OR NEW.receipt->>'receiptId' IS DISTINCT FROM r.receipt_id
  OR a.terminal OR r.cumulative_raw-a.completed_raw<>NEW.delta_raw OR r.fee_raw-a.completed_fee_raw<>NEW.delta_fee_raw
  OR i.intent->>'positionSide' IS DISTINCT FROM 'LONG' OR i.intent->>'side' IS DISTINCT FROM 'SELL'
  OR(NEW.chain,NEW.network_id,NEW.mode,NEW.account_id,NEW.asset_id,NEW.asset_scale,NEW.fee_asset_id,NEW.fee_asset_scale,NEW.fee_account_id)
    IS DISTINCT FROM(i.intent->>'chain',i.intent->>'network',i.intent->>'mode',i.intent->>'accountId',i.intent->>'assetId',(i.intent->>'assetScale')::integer,
      i.intent->>'feeAssetId',(i.intent->>'feeAssetScale')::integer,i.intent->>'feeFundingAccountId')
  OR i.intent->>'positionId' IS DISTINCT FROM NEW.position_id::text
  OR(e.chain,e.target_account,e.execution_mode,e.token_mint,e.direction,e.execution_origin,e.exit_lot_id)
   IS DISTINCT FROM(NEW.chain,NEW.account_id,NEW.mode,NEW.asset_id,'sell','lot_exit',NEW.lot_id)
  OR(lot.chain,lot.token_mint) IS DISTINCT FROM(NEW.chain,NEW.asset_id)
  OR NOT EXISTS(SELECT 1 FROM public.copy_positions pos WHERE pos.id=lot.position_id AND pos.user_id=NEW.user_id
    AND(pos.chain,pos.target_account,pos.token_mint)=(NEW.chain,NEW.account_id,NEW.asset_id))
  OR NOT EXISTS(SELECT 1 FROM public.copy_executions buy JOIN public.copy_execution_evidence fill ON fill.id=lot.acquisition_evidence_id AND fill.execution_id=buy.id
    JOIN public.copy_position_applications app ON app.evidence_id=fill.id AND app.execution_id=buy.id
    WHERE buy.id=lot.acquisition_execution_id AND buy.user_id=NEW.user_id AND buy.direction='buy'
     AND(buy.chain,buy.target_account,buy.token_mint,buy.execution_mode)=(NEW.chain,NEW.account_id,NEW.asset_id,NEW.mode)
     AND app.user_id=NEW.user_id AND app.position_id=NEW.position_id AND app.active AND fill.confirmation_state IN('confirmed','finalized'))
  OR NEW.evidence_input->>'executionId' IS DISTINCT FROM NEW.execution_id::text
  OR jsonb_typeof(NEW.evidence_input->'baseQuantity') IS DISTINCT FROM 'string'
  OR(NEW.evidence_input->>'baseQuantity')::numeric*power(10::numeric,NEW.asset_scale) IS DISTINCT FROM NEW.delta_raw
  OR NEW.evidence_input->>'confirmationState' IS DISTINCT FROM 'finalized'
  OR NEW.evidence_input->>'evidenceType' IS DISTINCT FROM (CASE WHEN NEW.mode='paper' THEN 'paper_simulation' ELSE 'chain_receipt' END)
  OR public.lp085_time(NEW.evidence_input->'observedAt')>t OR public.lp085_time(NEW.evidence_input->'occurredAt')>public.lp085_time(NEW.evidence_input->'observedAt')
  OR public.lp085_time(NEW.evidence_input->'observedAt') IS DISTINCT FROM r.observed_at
  OR NEW.evidence_input->'completesExecution' IS DISTINCT FROM to_jsonb(r.terminal)
  OR NEW.accounting_reference IS DISTINCT FROM 'spot:'||NEW.execution_id::text||':'||NEW.receipt_id
 THEN RAISE EXCEPTION '089 canonical spot exact persisted scope/delta/evidence required'; END IF;
 PERFORM public.lp085_fields(NEW.evidence_input,ARRAY['executionId','evidenceType','evidenceId','baseQuantity','quoteLeg','priceUsd','feeUsd','confirmationState','completesExecution','occurredAt','observedAt']);
 PERFORM public.lp085_fields(NEW.evidence_input->'quoteLeg',ARRAY['amount','currency']);
 PERFORM public.lp085_fields(NEW.economics,ARRAY['feeAssetId','feeAssetScale','feeFundingAccountId','feeRaw','feeUnitUsd','feeUsd','quoteAssetId','quoteAssetScale','quoteAccountId','quoteRaw','quoteCurrency']);
 IF jsonb_typeof(NEW.evidence_input->'priceUsd') IS DISTINCT FROM 'string' OR (NEW.evidence_input->>'priceUsd') !~ '^[0-9]+(\.[0-9]+)?$'
  OR (NEW.evidence_input->>'priceUsd')::numeric<=0
  OR jsonb_typeof(NEW.evidence_input->'feeUsd') IS DISTINCT FROM 'string' OR (NEW.evidence_input->>'feeUsd') !~ '^[0-9]+(\.[0-9]+)?$'
  OR (NEW.evidence_input->>'feeUsd')::numeric<0
  OR (NEW.economics->>'feeUnitUsd') !~ '^[0-9]+(\.[0-9]+)?$' OR (NEW.economics->>'feeUnitUsd')::numeric<0
  OR public.lp085_micro(NEW.economics->'feeRaw') IS DISTINCT FROM NEW.delta_fee_raw
  OR public.lp085_micro(NEW.economics->'quoteRaw')<=0 OR (NEW.economics->>'quoteAssetScale')::integer NOT BETWEEN 0 AND 36
  OR NEW.economics->>'quoteAccountId' IS DISTINCT FROM NEW.account_id
  OR COALESCE(NEW.economics->>'quoteCurrency','') NOT IN('USD','SOL','ETH','BNB')
  OR (NEW.economics->>'quoteCurrency' IS DISTINCT FROM 'USD' AND (jsonb_typeof(NEW.evidence_input->'quoteLeg'->'nativeUsdPrice') IS DISTINCT FROM 'string'
    OR COALESCE(NEW.evidence_input->'quoteLeg'->>'nativeUsdPrice','') !~ '^[0-9]+(\.[0-9]+)?$'
    OR (NEW.evidence_input->'quoteLeg'->>'nativeUsdPrice')::numeric<=0))
  OR NEW.economics->>'feeAssetId' IS DISTINCT FROM NEW.fee_asset_id OR (NEW.economics->>'feeAssetScale')::integer IS DISTINCT FROM NEW.fee_asset_scale
  OR NEW.economics->>'feeFundingAccountId' IS DISTINCT FROM NEW.fee_account_id OR (NEW.economics->>'feeRaw')::numeric IS DISTINCT FROM NEW.delta_fee_raw
  OR(NEW.economics->>'feeUsd')::numeric IS DISTINCT FROM (NEW.evidence_input->>'feeUsd')::numeric
  OR(NEW.evidence_input->>'feeUsd')::numeric IS DISTINCT FROM NEW.delta_fee_raw/power(10::numeric,NEW.fee_asset_scale)*(NEW.economics->>'feeUnitUsd')::numeric
  OR(NEW.evidence_input->'quoteLeg'->>'amount')::numeric IS DISTINCT FROM (NEW.economics->>'quoteRaw')::numeric/power(10::numeric,(NEW.economics->>'quoteAssetScale')::integer)
  OR NEW.evidence_input->'quoteLeg'->>'currency' IS DISTINCT FROM NEW.economics->>'quoteCurrency'
 THEN RAISE EXCEPTION '089 exact fees/quote denomination valuation required'; END IF;
 NEW.admitted_at:=t; RETURN NEW;
END $$;
CREATE FUNCTION public.wave4_accounting_guard089() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP<>'INSERT' OR NOT EXISTS(SELECT 1 FROM public.wave4_spot_admissions089 p WHERE p.user_id=NEW.user_id AND p.intent_id=NEW.intent_id
   AND p.receipt_id=NEW.receipt_id AND p.delta_raw=NEW.delta_raw AND p.delta_fee_raw=NEW.delta_fee_raw AND p.accounting_reference=NEW.accounting_reference)
 THEN RAISE EXCEPTION '089 canonical backing required; withdrawal and fee-only spot ledger remain unavailable'; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION public.wave4_spot_settlement_guard089() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE p public.wave4_spot_admissions089; e public.copy_execution_evidence;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION '089 canonical settlement closure immutable'; END IF;
 PERFORM public.wave4_direct089('swat_app',NEW.user_id);
 SELECT * INTO p FROM public.wave4_spot_admissions089 WHERE user_id=NEW.user_id AND receipt_id=NEW.receipt_id;
 SELECT * INTO e FROM public.copy_execution_evidence WHERE id=NEW.evidence_id AND execution_id=p.execution_id;
 IF p.receipt_id IS NULL OR e.id IS NULL OR NEW.accounting_reference IS DISTINCT FROM p.accounting_reference
  OR NEW.before_raw-NEW.after_raw IS DISTINCT FROM p.delta_raw OR e.evidence_type IS DISTINCT FROM p.evidence_input->>'evidenceType'
  OR e.evidence_id IS DISTINCT FROM p.evidence_input->>'evidenceId' OR e.base_quantity*power(10::numeric,p.asset_scale) IS DISTINCT FROM p.delta_raw
  OR NOT public.wave4_authority_current089(p.user_id,p.identity_id,p.authority_revision)
  OR e.price_usd IS DISTINCT FROM(p.evidence_input->>'priceUsd')::numeric
  OR e.quote_currency IS DISTINCT FROM p.evidence_input->'quoteLeg'->>'currency'
  OR e.quote_native_quantity IS DISTINCT FROM(p.evidence_input->'quoteLeg'->>'amount')::numeric
  OR e.quote_native_usd_price IS DISTINCT FROM (CASE WHEN p.evidence_input->'quoteLeg'->>'currency'='USD' THEN 1::numeric ELSE (p.evidence_input->'quoteLeg'->>'nativeUsdPrice')::numeric END)
  OR e.quote_quantity IS DISTINCT FROM e.quote_native_quantity*e.quote_native_usd_price
  OR e.completes_execution IS DISTINCT FROM(p.evidence_input->>'completesExecution')::boolean
  OR e.fee_usd IS DISTINCT FROM(p.evidence_input->>'feeUsd')::numeric OR e.confirmation_state IS DISTINCT FROM 'finalized'
  OR e.occurred_at IS DISTINCT FROM public.lp085_time(p.evidence_input->'occurredAt')
  OR NOT EXISTS(SELECT 1 FROM public.copy_position_applications a WHERE a.evidence_id=e.id AND a.execution_id=p.execution_id
    AND a.user_id=p.user_id AND a.position_id=p.position_id AND a.target_account=p.account_id AND a.chain=p.chain AND a.token_mint=p.asset_id AND a.active)
  OR NOT EXISTS(SELECT 1 FROM public.copy_position_master_lot_reductions l WHERE l.lot_id=p.lot_id AND l.sell_execution_id=p.execution_id
    AND l.sell_evidence_id=e.id AND l.quantity*power(10::numeric,p.asset_scale)=p.delta_raw)
 THEN RAISE EXCEPTION '089 actual canonical lot/evidence/application closure required'; END IF;
 NEW.settled_at:=clock_timestamp(); RETURN NEW;
END $$;
CREATE FUNCTION public.wave4_spot_atomic089() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.withdrawal_reducing_applications a JOIN public.wave4_spot_admissions089 p
  ON p.user_id=a.user_id AND p.receipt_id=a.receipt_id WHERE a.user_id=NEW.user_id AND a.receipt_id=NEW.receipt_id
   AND a.intent_id=p.intent_id AND a.attempt_id=p.attempt_id AND a.delta_raw=p.delta_raw AND a.accounting_reference=NEW.accounting_reference)
 THEN RAISE EXCEPTION '089 canonical settlement requires same-transaction financial application'; END IF;
 RETURN NULL;
END $$;
CREATE FUNCTION public.wave4_custody_readonly089() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 IF current_user IN('swat_custody_reader','swat_custody_observer') THEN RAISE EXCEPTION '089 execution reader cannot mutate grants'; END IF;
 RETURN NEW;
END $$;

-- Exact role-specific policies. Registry SELECT is non-secret, tenant-scoped;
-- reader grant/admission visibility is additionally bound to approved backend.
DO $policies$
DECLARE tab text;
BEGIN
 FOREACH tab IN ARRAY ARRAY['wave4_authorities089','wave4_authority_revocations089','wave4_custody_requests089','wave4_custody_revocations089',
  'wave4_lp_records089','wave4_lp_revocations089','wave4_lp_initializations089','wave4_spot_admissions089','wave4_spot_settlements089'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,swat_app,swat_lp_admitter,swat_custody_writer,swat_financial_receipt_writer,swat_wave4_authority_writer,swat_wave4_financial_writer,swat_lp_initializer,swat_custody_reader,swat_custody_observer',tab);
  EXECUTE format('CREATE POLICY wave4_tenant089 ON public.%I AS RESTRICTIVE USING(user_id=public.current_app_user_id() AND session_user=current_user AND current_setting(''role'')=''none'' AND current_setting(''row_security'')=''on'' AND COALESCE(current_setting(''app.bypass_rls'',true),''off'')=''off'') WITH CHECK(user_id=public.current_app_user_id() AND session_user=current_user AND current_setting(''role'')=''none'' AND current_setting(''row_security'')=''on'' AND COALESCE(current_setting(''app.bypass_rls'',true),''off'')=''off'')',tab);
 END LOOP;
 FOREACH tab IN ARRAY ARRAY['wave4_authorities089','wave4_authority_revocations089','wave4_custody_requests089','wave4_custody_revocations089'] LOOP
  EXECUTE format('CREATE POLICY wave4_read089 ON public.%I FOR SELECT TO swat_app,swat_lp_admitter,swat_custody_writer,swat_financial_receipt_writer,swat_wave4_authority_writer,swat_wave4_financial_writer,swat_lp_initializer,swat_custody_reader,swat_custody_observer USING(user_id=public.current_app_user_id())',tab);
  EXECUTE format('CREATE POLICY wave4_insert089 ON public.%I FOR INSERT TO swat_wave4_authority_writer WITH CHECK(user_id=public.current_app_user_id())',tab);
  EXECUTE format('GRANT SELECT ON public.%I TO swat_app,swat_lp_admitter,swat_custody_writer,swat_financial_receipt_writer,swat_wave4_authority_writer,swat_wave4_financial_writer,swat_lp_initializer,swat_custody_reader,swat_custody_observer',tab);
  EXECUTE format('GRANT INSERT ON public.%I TO swat_wave4_authority_writer',tab);
  EXECUTE format('CREATE TRIGGER wave4_registry089 BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.wave4_registry_guard089()',tab);
 END LOOP;
END $policies$;
CREATE POLICY wave4_read089 ON public.wave4_lp_records089 FOR SELECT TO swat_app,swat_lp_admitter,swat_wave4_financial_writer,swat_lp_initializer
 USING(user_id=public.current_app_user_id());
CREATE POLICY wave4_insert089 ON public.wave4_lp_records089 FOR INSERT TO swat_wave4_financial_writer,swat_wave4_authority_writer
 WITH CHECK(user_id=public.current_app_user_id() AND ((current_user='swat_wave4_authority_writer' AND purpose='initialization') OR(current_user='swat_wave4_financial_writer' AND purpose<>'initialization')));
CREATE POLICY wave4_read089 ON public.wave4_lp_revocations089 FOR SELECT TO swat_app,swat_lp_admitter,swat_wave4_financial_writer,swat_lp_initializer,swat_wave4_authority_writer USING(user_id=public.current_app_user_id());
CREATE POLICY wave4_insert089 ON public.wave4_lp_revocations089 FOR INSERT TO swat_wave4_authority_writer WITH CHECK(user_id=public.current_app_user_id());
GRANT SELECT ON public.wave4_lp_records089 TO swat_app,swat_lp_admitter,swat_wave4_financial_writer,swat_lp_initializer,swat_wave4_authority_writer;
-- Approver reads LP records only for exact revocation FK target; not mutation.
CREATE POLICY wave4_approver_read089 ON public.wave4_lp_records089 FOR SELECT TO swat_wave4_authority_writer USING(user_id=public.current_app_user_id());
GRANT INSERT ON public.wave4_lp_records089 TO swat_wave4_financial_writer,swat_wave4_authority_writer;
CREATE POLICY wave4_read089 ON public.wave4_lp_initializations089 FOR SELECT TO swat_app,swat_lp_admitter,swat_lp_initializer USING(user_id=public.current_app_user_id());
CREATE POLICY wave4_insert089 ON public.wave4_lp_initializations089 FOR INSERT TO swat_lp_initializer WITH CHECK(user_id=public.current_app_user_id());
GRANT SELECT ON public.wave4_lp_initializations089 TO swat_app,swat_lp_admitter,swat_lp_initializer;
GRANT INSERT(user_id,record_id,subscription_id) ON public.wave4_lp_initializations089 TO swat_lp_initializer;
CREATE TRIGGER wave4_lp_initialization089 BEFORE INSERT OR UPDATE OR DELETE ON public.wave4_lp_initializations089 FOR EACH ROW EXECUTE FUNCTION public.wave4_lp_initialization_guard089();
GRANT SELECT ON public.wave4_lp_revocations089 TO swat_app,swat_lp_admitter,swat_wave4_financial_writer,swat_lp_initializer,swat_wave4_authority_writer;
GRANT INSERT ON public.wave4_lp_revocations089 TO swat_wave4_authority_writer;
CREATE TRIGGER wave4_lp089 BEFORE INSERT OR UPDATE OR DELETE ON public.wave4_lp_records089 FOR EACH ROW EXECUTE FUNCTION public.wave4_lp_guard089();
CREATE TRIGGER wave4_lp_revoke089 BEFORE INSERT OR UPDATE OR DELETE ON public.wave4_lp_revocations089 FOR EACH ROW EXECUTE FUNCTION public.wave4_registry_guard089();
CREATE POLICY wave4_initializer089 ON public.lp_copy_subscriptions FOR SELECT TO swat_lp_initializer USING(user_id=public.current_app_user_id());
CREATE POLICY wave4_initializer_insert089 ON public.lp_copy_subscriptions FOR INSERT TO swat_lp_initializer WITH CHECK(user_id=public.current_app_user_id());
CREATE POLICY wave4_initializer089 ON public.lp_guardrail_configs FOR SELECT TO swat_lp_initializer USING(user_id=public.current_app_user_id());
CREATE POLICY wave4_initializer_insert089 ON public.lp_guardrail_configs FOR INSERT TO swat_lp_initializer WITH CHECK(user_id=public.current_app_user_id());
GRANT SELECT ON public.lp_copy_subscriptions,public.lp_guardrail_configs TO swat_lp_initializer;
GRANT INSERT(id,user_id,master_wallet_address,chain,venue,allocated_budget_usd,max_capital_per_position_usd,status,created_at,updated_at) ON public.lp_copy_subscriptions TO swat_lp_initializer;
GRANT INSERT(user_id,max_pool_allocation_pct,profit_bank_pct,reserve_sub_vault_chain,reserve_sub_vault_address,updated_at) ON public.lp_guardrail_configs TO swat_lp_initializer;
-- App lock-only UPDATEs installed086 are untouched and STILL refuse mutation.
CREATE POLICY wave4_read089 ON public.wave4_spot_admissions089 FOR SELECT TO swat_app,swat_financial_receipt_writer USING(user_id=public.current_app_user_id());
CREATE POLICY wave4_insert089 ON public.wave4_spot_admissions089 FOR INSERT TO swat_financial_receipt_writer WITH CHECK(user_id=public.current_app_user_id());
CREATE POLICY wave4_read089 ON public.wave4_spot_settlements089 FOR SELECT TO swat_app,swat_financial_receipt_writer USING(user_id=public.current_app_user_id());
CREATE POLICY wave4_insert089 ON public.wave4_spot_settlements089 FOR INSERT TO swat_app WITH CHECK(user_id=public.current_app_user_id());
GRANT SELECT ON public.wave4_spot_admissions089,public.wave4_spot_settlements089 TO swat_app,swat_financial_receipt_writer;
GRANT INSERT ON public.wave4_spot_admissions089 TO swat_financial_receipt_writer;
GRANT INSERT ON public.wave4_spot_settlements089 TO swat_app;
GRANT SELECT ON public.copy_executions,public.copy_positions,public.copy_position_master_lots,public.copy_execution_evidence,public.copy_position_applications TO swat_financial_receipt_writer;
CREATE POLICY wave4_receipt_writer089 ON public.copy_execution_evidence FOR SELECT TO swat_financial_receipt_writer
 USING(EXISTS(SELECT 1 FROM public.copy_executions e WHERE e.id=execution_id AND e.user_id=public.current_app_user_id()));
CREATE POLICY wave4_receipt_writer089 ON public.copy_position_applications FOR SELECT TO swat_financial_receipt_writer USING(user_id=public.current_app_user_id());
CREATE POLICY wave4_receipt_writer089 ON public.copy_executions FOR SELECT TO swat_financial_receipt_writer USING(user_id=public.current_app_user_id());
CREATE POLICY wave4_receipt_writer089 ON public.copy_positions FOR SELECT TO swat_financial_receipt_writer USING(user_id=public.current_app_user_id());
CREATE POLICY wave4_receipt_writer089 ON public.copy_position_master_lots FOR SELECT TO swat_financial_receipt_writer USING(user_id=public.current_app_user_id());
CREATE TRIGGER wave4_spot089 BEFORE INSERT OR UPDATE OR DELETE ON public.wave4_spot_admissions089 FOR EACH ROW EXECUTE FUNCTION public.wave4_spot_guard089();
CREATE TRIGGER wave4_spot_settlement089 BEFORE INSERT OR UPDATE OR DELETE ON public.wave4_spot_settlements089 FOR EACH ROW EXECUTE FUNCTION public.wave4_spot_settlement_guard089();
CREATE CONSTRAINT TRIGGER wave4_spot_atomic089 AFTER INSERT ON public.wave4_spot_settlements089 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.wave4_spot_atomic089();
-- Supplemental guard, NOT an old082 trigger rewrite. Perps accepted path untouched.
CREATE TRIGGER wave4_accounting089 BEFORE INSERT ON public.withdrawal_reducing_accounting_admissions FOR EACH ROW EXECUTE FUNCTION public.wave4_accounting_guard089();

-- Reader permissions cannot enroll, decrypt, admit or change lifecycle. Row locking
-- is possible only for execution reader; actual UPDATE is refused by supplement.
GRANT SELECT ON public.user_execution_grants,public.custody_secret_admissions TO swat_custody_reader,swat_custody_observer;
GRANT UPDATE(lifecycle_revision) ON public.user_execution_grants TO swat_custody_reader;
CREATE POLICY wave4_execution_scope089 ON public.user_execution_grants AS RESTRICTIVE TO swat_custody_reader,swat_custody_observer
 USING(public.wave4_custody_scope089(user_id,id)) WITH CHECK(false);
CREATE POLICY wave4_execution_scope089 ON public.custody_secret_admissions AS RESTRICTIVE TO swat_custody_reader,swat_custody_observer
 USING(public.wave4_custody_scope089(user_id,grant_id)) WITH CHECK(false);
CREATE TRIGGER wave4_custody_readonly089 BEFORE INSERT OR UPDATE OR DELETE ON public.user_execution_grants FOR EACH ROW EXECUTE FUNCTION public.wave4_custody_readonly089();
-- Approver can verify execution authority tenant/account without ciphertext.
GRANT SELECT(id,user_id,chain,account_address) ON public.user_execution_grants TO swat_wave4_authority_writer;
CREATE POLICY wave4_approver089 ON public.user_execution_grants FOR SELECT TO swat_wave4_authority_writer USING(user_id=public.current_app_user_id());
-- Metadata only for app. This deliberately blocks old081 invoker SELECT * and old
-- enrollment PUBLIC_COLUMNS ciphertext expression until coordinator fixes the
-- public projection + exact protected enrollment guard. Never grant app secrets.
REVOKE SELECT ON public.user_execution_grants,public.custody_secret_admissions FROM swat_app;
DO $columns$ DECLARE c record; BEGIN
 FOR c IN SELECT t.relname,a.attname FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class t ON t.oid=a.attrelid
  WHERE t.oid IN('public.user_execution_grants'::regclass,'public.custody_secret_admissions'::regclass) AND a.attnum>0 AND NOT a.attisdropped LOOP
  EXECUTE format('REVOKE SELECT (%I) ON public.%I FROM swat_app',c.attname,c.relname);
  IF c.attname<>'sealed_secret' THEN EXECUTE format('GRANT SELECT (%I) ON public.%I TO swat_app',c.attname,c.relname); END IF;
 END LOOP;
END $columns$;
-- SECURITY INVOKER + barrier: neither owner authority nor nested definer RLS.
-- No underlying audit_log SELECT is granted. Its canonical unscoped/no-RLS store
-- needs a separately reviewed exact invoker ACL/RLS source strategy; this view and
-- its adapter remain refused until then. Never broaden global audit architecture.
CREATE VIEW public.wave4_custody_audit089 WITH(security_invoker=true,security_barrier=true) AS
 SELECT h.id,h.actor_type,h.actor_id,h.event,h.target_type,h.target_id,h.metadata,h.occurred_at
 FROM public.audit_log h WHERE h.target_type='execution_grant'
  AND h.actor_type='user' AND h.actor_id=public.current_app_user_id()
  AND h.event IN('grant.locally_retired','grant.locally_revoked','grant.locally_compromised','grant.locally_replaced')
  AND EXISTS(SELECT 1 FROM public.wave4_authorities089 a WHERE a.user_id=public.current_app_user_id()
   AND a.grant_id::text=h.target_id AND a.database_role=current_user AND a.backend_pid=pg_backend_pid()
   AND a.service_identity='swat_custody_observer' AND a.capabilities=ARRAY['execution-secret-read']
   AND public.wave4_authority_current089(a.user_id,a.identity_id,a.revision));
REVOKE ALL ON public.wave4_custody_audit089 FROM PUBLIC,swat_app,swat_custody_reader,swat_custody_observer;
GRANT SELECT ON public.wave4_custody_audit089 TO swat_custody_observer;

GRANT USAGE ON SCHEMA public TO swat_wave4_authority_writer,swat_wave4_financial_writer,swat_lp_initializer,swat_custody_reader,swat_custody_observer;
GRANT EXECUTE ON FUNCTION public.current_app_user_id() TO swat_wave4_authority_writer,swat_wave4_financial_writer,swat_lp_initializer,swat_custody_reader,swat_custody_observer;
GRANT EXECUTE ON FUNCTION public.lp085_fields(jsonb,text[]),public.lp085_micro(jsonb,boolean),public.lp085_time(jsonb)
 TO swat_wave4_authority_writer,swat_wave4_financial_writer,swat_lp_initializer,swat_financial_receipt_writer;
DO $acl$ DECLARE f record; BEGIN
 FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname LIKE 'wave4_%089' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,swat_app,swat_lp_admitter,swat_custody_writer,swat_financial_receipt_writer,swat_wave4_authority_writer,swat_wave4_financial_writer,swat_lp_initializer,swat_custody_reader,swat_custody_observer',f.signature);
 END LOOP;
END $acl$;
GRANT EXECUTE ON FUNCTION public.wave4_direct089(text,uuid),public.wave4_authority_current089(uuid,uuid,bigint)
 TO swat_app,swat_lp_admitter,swat_custody_writer,swat_financial_receipt_writer,swat_wave4_authority_writer,swat_wave4_financial_writer,swat_lp_initializer,swat_custody_reader,swat_custody_observer;
GRANT EXECUTE ON FUNCTION public.wave4_custody_lookup089(uuid,jsonb)
 TO swat_app,swat_custody_writer,swat_custody_reader,swat_custody_observer;
GRANT EXECUTE ON FUNCTION public.wave4_custody_scope089(uuid,uuid) TO swat_custody_reader,swat_custody_observer;
GRANT EXECUTE ON FUNCTION public.wave4_lp_lookup089(uuid,text,text,text,text,text) TO swat_app,swat_lp_admitter,swat_wave4_financial_writer,swat_lp_initializer;
GRANT EXECUTE ON FUNCTION public.wave4_lp_initialize089(uuid,uuid) TO swat_lp_initializer;
-- Trigger-only functions have owner EXECUTE only. No trigger/DDL/REFERENCES/TRUNCATE grants.
-- No authority seed or enabling operation occurs in this proposal.
