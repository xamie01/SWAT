-- SOURCE ONLY088. Bounded unselected forward proposal; sourceComplete/runtimeAccepted/
-- liveCapabilityAccepted/productionReady are false. No provisioning executes here.
-- Read/repair existing partial security, not an append-only privilege workaround.
-- Commit inert lookup routines as direct restricted swat_migrator; AFTER COMMIT,
-- independently authenticated direct external DBA may install the exact disabled
-- lookup handoff in deploy/postgres/wave4-pipeline-provisioning.ts. NO broker change.
-- NO approvals/providers/policies/credentials/LOGIN are seeded by this source.
DO $$ BEGIN
 IF current_user IS DISTINCT FROM 'swat_migrator' OR session_user IS DISTINCT FROM 'swat_migrator'
 OR current_setting('role') IS DISTINCT FROM 'none' OR current_setting('row_security') IS DISTINCT FROM 'on'
 OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND NOT(rolsuper OR rolbypassrls OR rolinherit OR rolcreaterole OR rolcreatedb OR rolreplication))
 OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user) OR roleid=(SELECT oid FROM pg_roles WHERE rolname=current_user))
 THEN RAISE EXCEPTION '088 direct restricted migrator required'; END IF;
 IF (SELECT count(*) FROM pg_roles WHERE rolname IN('swat_source_provider_writer','swat_fanout','swat_capability_writer','swat_risk_writer','swat_valuation_writer')) IS DISTINCT FROM 5
 OR EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname IN('swat_source_provider_writer','swat_fanout','swat_capability_writer','swat_risk_writer','swat_valuation_writer') AND
 (r.rolcanlogin OR r.rolsuper OR r.rolbypassrls OR r.rolinherit OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication
 OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid)
 OR EXISTS(SELECT 1 FROM pg_shdepend WHERE refclassid='pg_authid'::regclass AND refobjid=r.oid AND deptype='o')
 OR has_database_privilege(r.oid,current_database(),'CREATE') OR EXISTS(SELECT 1 FROM pg_namespace WHERE has_schema_privilege(r.oid,oid,'CREATE'))))
 THEN RAISE EXCEPTION '088 externally provisioned disabled nonowning writer prerequisites absent'; END IF;
END $$;

-- The direct external DBA authenticates enrollment, not a hash, label, DTO,
-- caller boolean, queue descriptor, callback, migrator or role membership.
-- Exact immutable canonical bytes commit all approved terms. No wildcard selector.
CREATE TABLE public.pipeline_backend_approvals (
 capability_id uuid PRIMARY KEY, revision text NOT NULL CHECK(length(revision) BETWEEN 1 AND 128),
 system_identifier text NOT NULL CHECK(system_identifier ~ '^[1-9][0-9]*$'),
 database_name text NOT NULL, database_oid oid NOT NULL,
 server_address text NOT NULL, server_port integer NOT NULL CHECK(server_port BETWEEN 0 AND 65535),
 runtime_role name NOT NULL, purpose text NOT NULL, authority_id text NOT NULL,
 backend_identity text NOT NULL CHECK(length(backend_identity) BETWEEN 1 AND 512),
 approved_terms jsonb NOT NULL CHECK(jsonb_typeof(approved_terms)='object'),
 approved_terms_canonical text NOT NULL, approved_terms_digest text NOT NULL,
 provider_id text, chain text, network text, verifier_version text, identity_digest text, provider_valid_until timestamptz,
 valid_from timestamptz NOT NULL, expires_at timestamptz NOT NULL,
 enrolled_by name NOT NULL, enrolled_at timestamptz NOT NULL,
 revoked_at timestamptz, revoked_by name,
 CONSTRAINT pipeline_backend_approval_scope UNIQUE(system_identifier,database_oid,server_address,server_port,runtime_role,purpose,authority_id),
 CHECK(expires_at>valid_from AND isfinite(valid_from) AND isfinite(expires_at)),
 CHECK((revoked_at IS NULL)=(revoked_by IS NULL)),
 CHECK(revoked_at IS NULL OR revoked_at>=enrolled_at),
 CHECK(approved_terms_canonical::jsonb=approved_terms AND approved_terms_digest=encode(sha256(convert_to(approved_terms_canonical,'UTF8')),'hex')),
 CHECK((purpose='fanout' AND runtime_role='swat_fanout' AND authority_id='')
 OR (purpose IN('source-register','source-intake','source-verify') AND runtime_role='swat_source_provider_writer' AND length(authority_id) BETWEEN 1 AND 256)
 OR (purpose='worker-register' AND runtime_role='swat_capability_writer' AND authority_id ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$')
 OR (purpose='risk-write' AND runtime_role='swat_risk_writer' AND authority_id ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$')
 OR (purpose IN('valuation-register','valuation-write') AND runtime_role='swat_valuation_writer' AND length(authority_id) BETWEEN 1 AND 256)
 OR (purpose='paper-valuation' AND runtime_role='swat_valuation_writer' AND authority_id ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$')
 OR (purpose='paper-receipt' AND runtime_role='swat_worker_receipt_writer' AND authority_id ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$')),
 CHECK(CASE WHEN purpose IN('source-register','source-intake','source-verify') THEN
 provider_id IS NOT NULL AND chain IN('solana','polygon','robinhood-chain') AND network IS NOT NULL
 AND verifier_version IS NOT NULL AND identity_digest ~ '^[0-9a-f]{64}$' AND provider_valid_until IS NOT NULL
 AND provider_valid_until<=expires_at ELSE
 provider_id IS NULL AND chain IS NULL AND network IS NULL AND verifier_version IS NULL AND identity_digest IS NULL AND provider_valid_until IS NULL END)
);
ALTER TABLE public.pipeline_backend_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pipeline_backend_approvals FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.pipeline_backend_approvals FROM PUBLIC,swat_app,swat_fanout,swat_source_provider_writer,swat_capability_writer,swat_risk_writer,swat_valuation_writer,swat_runtime_lookup;
-- No migrator RLS policy and no runtime/writer table access. External DBA insert
-- and one-way revocation are the sole enrollment route; lookup read comes AFTER commit.

CREATE FUNCTION public.swat_pipeline_external_dba() RETURNS boolean LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT (current_user IS NOT DISTINCT FROM session_user
 AND session_user <> ALL(ARRAY['swat_app','swat_migrator','swat_fanout','swat_source_provider_writer','swat_capability_writer',
 'swat_risk_writer','swat_valuation_writer','swat_worker_receipt_writer','swat_runtime_lookup','swat_financial_settler',
 'swat_auth_owner','swat_auth_service','swat_custody_writer','swat_financial_receipt_writer','swat_lp_admitter',
 'swat_system_observer','swat_handoff_dba','swat_handoff_broker']::name[])
 AND current_setting('role',true) IS NOT DISTINCT FROM 'none'
 AND current_setting('row_security',true) IS NOT DISTINCT FROM 'on'
 AND EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname=session_user AND r.rolsuper AND r.rolcanlogin
 AND NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid))) IS TRUE
$$;
REVOKE ALL ON FUNCTION public.swat_pipeline_external_dba() FROM PUBLIC;

CREATE FUNCTION public.swat_pipeline_external_enrollment() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE follower record; canonical text;
BEGIN
 IF public.swat_pipeline_external_dba() IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'independently authenticated direct external DBA enrollment required' USING ERRCODE='42501'; END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'protected enrollment cannot be deleted'; END IF;
 IF TG_TABLE_NAME='pipeline_backend_approvals' THEN
  IF TG_OP='INSERT' THEN
   IF NEW.revoked_at IS NOT NULL OR NEW.revoked_by IS NOT NULL OR NEW.valid_from>statement_timestamp() OR NEW.expires_at<=statement_timestamp()
   OR NEW.database_name IS DISTINCT FROM current_database() OR NEW.database_oid IS DISTINCT FROM (SELECT oid FROM pg_database WHERE datname=current_database())
   OR NEW.system_identifier IS DISTINCT FROM (SELECT system_identifier::text FROM pg_control_system())
   OR NEW.server_address IS DISTINCT FROM COALESCE(inet_server_addr()::text,'unix') OR NEW.server_port IS DISTINCT FROM COALESCE(inet_server_port(),0)
   OR NEW.backend_identity IS DISTINCT FROM concat(current_database(),'|',NEW.server_address,'|',NEW.server_port,'|',NEW.runtime_role)
   OR (NEW.purpose LIKE 'source-%' AND NEW.approved_terms->'provider' IS DISTINCT FROM jsonb_build_object(
    'providerId',NEW.provider_id,'authorityId',NEW.authority_id,'chain',NEW.chain,'network',NEW.network,
    'verifierVersion',NEW.verifier_version,'identityDigest',NEW.identity_digest,
    'validUntil',to_char(NEW.provider_valid_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
   THEN RAISE EXCEPTION 'exact database/system/backend/provider enrollment terms required'; END IF;
   NEW.enrolled_by:=session_user; NEW.enrolled_at:=clock_timestamp();
  ELSE
   IF (to_jsonb(NEW)-ARRAY['revoked_at','revoked_by']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['revoked_at','revoked_by'])
   OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL OR NEW.revoked_at<OLD.enrolled_at
   THEN RAISE EXCEPTION 'backend approval immutable; only permanent revocation permitted'; END IF;
   NEW.revoked_by:=session_user;
  END IF;
 ELSE
  IF TG_OP='UPDATE' AND ((to_jsonb(NEW)-ARRAY['revoked_at','revoked_by','enabled']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['revoked_at','revoked_by','enabled'])
   OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL OR NEW.enabled IS DISTINCT FROM false
   OR NEW.revoked_at<OLD.enrolled_at OR NEW.revoked_at>clock_timestamp())
  THEN RAISE EXCEPTION 'follower enrollment immutable; only permanent revocation permitted'; END IF;
  IF TG_OP='INSERT' THEN
   IF NEW.revoked_at IS NOT NULL OR NEW.revoked_by IS NOT NULL OR NEW.enabled IS DISTINCT FROM true
   THEN RAISE EXCEPTION 'fresh enabled follower enrollment required'; END IF;
   IF TG_TABLE_NAME='pipeline_follower_authorities' THEN
    IF NOT isfinite(NEW.valid_until) OR NEW.valid_until<=clock_timestamp()
     OR NEW.authority_id IS NULL OR length(NEW.authority_id) NOT BETWEEN 1 AND 256 OR btrim(NEW.authority_id) IS DISTINCT FROM NEW.authority_id
     OR NEW.provider_id IS NULL OR length(NEW.provider_id) NOT BETWEEN 1 AND 256 OR btrim(NEW.provider_id) IS DISTINCT FROM NEW.provider_id
     OR NEW.network IS NULL OR length(NEW.network) NOT BETWEEN 1 AND 128 OR btrim(NEW.network) IS DISTINCT FROM NEW.network
    THEN RAISE EXCEPTION 'fresh exact follower authority required'; END IF;
   ELSIF TG_TABLE_NAME='pipeline_exact_follower_evidence' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('pipeline-follower',NEW.user_id,NEW.chain,NEW.target_account,NEW.token_mint,NEW.execution_mode)::text,88088));
    SELECT * INTO STRICT follower FROM public.pipeline_follower_authorities WHERE authority_id=NEW.authority_id FOR SHARE;
    IF follower.enabled IS DISTINCT FROM true OR follower.revoked_at IS NOT NULL
     OR follower.chain IS DISTINCT FROM NEW.chain OR follower.network IS DISTINCT FROM NEW.network
     OR follower.valid_until<=clock_timestamp() OR NEW.expires_at>follower.valid_until
     OR NOT isfinite(NEW.observed_at) OR NOT isfinite(NEW.expires_at)
     OR NEW.observed_at>clock_timestamp() OR NEW.observed_at<clock_timestamp()-interval '60 seconds'
     OR NEW.expires_at<=clock_timestamp() OR NEW.expires_at<=NEW.observed_at OR NEW.expires_at>NEW.observed_at+interval '60 seconds'
     OR date_trunc('milliseconds',NEW.observed_at) IS DISTINCT FROM NEW.observed_at
     OR date_trunc('milliseconds',NEW.expires_at) IS DISTINCT FROM NEW.expires_at
     OR NEW.available_usd IS DISTINCT FROM trim_scale(NEW.raw_available_usd::numeric/power(10::numeric,NEW.usd_scale))::text
     OR NEW.target_account IS NULL OR length(NEW.target_account) NOT BETWEEN 1 AND 512
     OR left(NEW.target_account,length(NEW.chain)+1) IS DISTINCT FROM NEW.chain||':' OR length(NEW.target_account)<=length(NEW.chain)+1
     OR NEW.token_mint IS NULL OR length(NEW.token_mint) NOT BETWEEN 1 AND 512
     OR left(NEW.token_mint,length(NEW.chain)+1) IS DISTINCT FROM NEW.chain||':' OR length(NEW.token_mint)<=length(NEW.chain)+1
     OR NEW.evidence_id IS NULL OR length(NEW.evidence_id) NOT BETWEEN 1 AND 256 OR btrim(NEW.evidence_id) IS DISTINCT FROM NEW.evidence_id
     OR NOT EXISTS(SELECT 1 FROM public.users WHERE id=NEW.user_id AND status='active')
    THEN RAISE EXCEPTION 'exact follower evidence authority/scope/raw-scale/freshness required'; END IF;
    canonical:=public.swat_pipeline_ordered_json(jsonb_build_object(
     'authorityId',follower.authority_id,'providerId',follower.provider_id,'providerIdentity',follower.provider_identity,
     'evidenceId',NEW.evidence_id,'userId',NEW.user_id,'chain',NEW.chain,'network',NEW.network,
     'targetAccount',NEW.target_account,'tokenMint',NEW.token_mint,'executionMode',NEW.execution_mode,
     'rawAvailableUsd',NEW.raw_available_usd,'usdScale',NEW.usd_scale,'availableUsd',NEW.available_usd,
     'observedAt',to_char(NEW.observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
     'expiresAt',to_char(NEW.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
     ARRAY['authorityId','providerId','providerIdentity','evidenceId','userId','chain','network','targetAccount','tokenMint','executionMode',
      'rawAvailableUsd','usdScale','availableUsd','observedAt','expiresAt']);
    IF NEW.evidence_canonical IS DISTINCT FROM canonical
     OR NEW.evidence_digest IS DISTINCT FROM encode(sha256(convert_to(canonical,'UTF8')),'hex')
    THEN RAISE EXCEPTION 'exact fixed-order follower evidence digest required'; END IF;
   ELSE RAISE EXCEPTION 'unexpected protected follower enrollment relation'; END IF;
   NEW.enrolled_by:=session_user; NEW.enrolled_at:=clock_timestamp();
  ELSE NEW.revoked_by:=session_user; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pipeline_backend_enrollment BEFORE INSERT OR UPDATE OR DELETE ON public.pipeline_backend_approvals FOR EACH ROW EXECUTE FUNCTION public.swat_pipeline_external_enrollment();
REVOKE ALL ON FUNCTION public.swat_pipeline_external_enrollment() FROM PUBLIC;

-- New lookup is intentionally NOT transferred by the sealed seven079082 broker.
-- Current_user check makes the migrator-owned inert definition unusable.
CREATE FUNCTION public.swat_pipeline_backend_capability(requested_purpose text,requested_authority text) RETURNS TABLE(
 capability_id uuid,revision text,purpose text,authority_id text,runtime_role text,database_oid oid,
 system_identifier text,server_address text,server_port integer,backend_identity text,
 approved_terms jsonb,approved_terms_digest text,valid_from timestamptz,expires_at timestamptz,revoked_at timestamptz,
 provider_id text,chain text,network text,verifier_version text,identity_digest text,provider_valid_until timestamptz)
-- AFTER lock acquisition, authorization time is sampled with clock_timestamp().
-- FOR SHARE conflicts with external one-way UPDATE revocation until transaction end.
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM a.capability_id FROM public.pipeline_backend_approvals a
 WHERE a.runtime_role=session_user AND a.purpose=requested_purpose AND a.authority_id=requested_authority FOR SHARE;
 RETURN QUERY SELECT a.capability_id,a.revision,a.purpose,a.authority_id,a.runtime_role::text,a.database_oid,a.system_identifier,
 a.server_address,a.server_port,a.backend_identity,a.approved_terms,a.approved_terms_digest,a.valid_from,a.expires_at,a.revoked_at,
 a.provider_id,a.chain,a.network,a.verifier_version,a.identity_digest,a.provider_valid_until
 FROM public.pipeline_backend_approvals a JOIN pg_roles r ON r.rolname=session_user
 WHERE current_user='swat_runtime_lookup' AND current_setting('role')='none' AND current_setting('row_security')='on'
 AND COALESCE(current_setting('app.bypass_rls',true),'off')='off'
 AND COALESCE(current_setting('app.current_user_id',true),'')='' AND COALESCE(current_setting('app.worker_execution_id',true),'')=''
 AND r.rolcanlogin AND NOT(r.rolsuper OR r.rolbypassrls OR r.rolinherit OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication)
 AND NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid)
 AND NOT EXISTS(SELECT 1 FROM pg_shdepend WHERE refclassid='pg_authid'::regclass AND refobjid=r.oid AND deptype='o')
 AND NOT has_database_privilege(r.oid,current_database(),'CREATE') AND NOT EXISTS(SELECT 1 FROM pg_namespace WHERE has_schema_privilege(r.oid,oid,'CREATE'))
 AND a.runtime_role=session_user AND a.purpose=requested_purpose AND a.authority_id=requested_authority
 AND a.database_name=current_database() AND a.database_oid=(SELECT oid FROM pg_database WHERE datname=current_database())
 AND a.system_identifier=(SELECT control.system_identifier::text FROM pg_control_system() AS control)
 AND a.server_address=COALESCE(inet_server_addr()::text,'unix') AND a.server_port=COALESCE(inet_server_port(),0)
 AND a.backend_identity=concat(current_database(),'|',a.server_address,'|',a.server_port,'|',session_user)
 AND a.revoked_at IS NULL AND a.valid_from<=clock_timestamp() AND a.expires_at>clock_timestamp()
 AND a.approved_terms_canonical::jsonb IS NOT DISTINCT FROM a.approved_terms
 AND a.approved_terms_digest IS NOT DISTINCT FROM encode(sha256(convert_to(a.approved_terms_canonical,'UTF8')),'hex')
 AND (a.provider_valid_until IS NULL OR a.provider_valid_until>clock_timestamp());
END $$;
REVOKE ALL ON FUNCTION public.swat_pipeline_backend_capability(text,text) FROM PUBLIC,swat_app,swat_source_provider_writer,swat_fanout,swat_capability_writer,swat_risk_writer,swat_valuation_writer;

CREATE FUNCTION public.swat_pipeline_approved(requested_purpose text,requested_selector text) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE a record;
BEGIN
 IF current_user IS DISTINCT FROM session_user THEN RAISE EXCEPTION 'protected writer requires direct session'; END IF;
 SELECT * INTO STRICT a FROM public.swat_pipeline_backend_capability(requested_purpose,requested_selector);
 RETURN a.approved_terms;
END $$;
REVOKE ALL ON FUNCTION public.swat_pipeline_approved(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.swat_pipeline_approved(text,text) TO swat_source_provider_writer,swat_fanout,swat_capability_writer,swat_risk_writer,swat_valuation_writer;

-- Preserve JSON bytes for JS SHA256 without jsonb whitespace/key-order drift.
CREATE FUNCTION public.swat_pipeline_canonical_json(j jsonb) RETURNS text LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE answer text;
BEGIN
 CASE jsonb_typeof(j)
 WHEN 'object' THEN SELECT '{'||COALESCE(string_agg(to_jsonb(key)::text||':'||public.swat_pipeline_canonical_json(value),',' ORDER BY key COLLATE "C"),'')||'}' INTO answer FROM jsonb_each(j);
 WHEN 'array' THEN SELECT '['||COALESCE(string_agg(public.swat_pipeline_canonical_json(value),',' ORDER BY ord),'')||']' INTO answer FROM jsonb_array_elements(j) WITH ORDINALITY a(value,ord);
 ELSE answer:=j::text;
 END CASE;
 RETURN answer;
END $$;
REVOKE ALL ON FUNCTION public.swat_pipeline_canonical_json(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.swat_pipeline_canonical_json(jsonb) TO swat_source_provider_writer,swat_fanout,swat_capability_writer,swat_risk_writer,swat_valuation_writer;

-- Fixed-order JSON.stringify contract for follower and SQL077 source bytes.
CREATE FUNCTION public.swat_pipeline_ordered_json(j jsonb,keys text[]) RETURNS text LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE k text; result text:='';
BEGIN
 IF jsonb_typeof(j) IS DISTINCT FROM 'object' OR NOT(j ?& keys)
 OR (SELECT count(*) FROM jsonb_object_keys(j)) IS DISTINCT FROM cardinality(keys)
 THEN RAISE EXCEPTION 'exact fixed-order JSON fields required'; END IF;
 FOREACH k IN ARRAY keys LOOP
  result:=result||CASE WHEN result='' THEN '' ELSE ',' END||to_jsonb(k)::text||':'||public.swat_pipeline_canonical_json(j->k);
 END LOOP;
 RETURN '{'||result||'}';
END $$;
REVOKE ALL ON FUNCTION public.swat_pipeline_ordered_json(jsonb,text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.swat_pipeline_ordered_json(jsonb,text[]) TO swat_source_provider_writer,swat_fanout,swat_runtime_lookup;

CREATE TABLE public.pipeline_follower_authorities (
 authority_id text PRIMARY KEY,provider_id text NOT NULL,provider_identity text NOT NULL CHECK(provider_identity ~ '^[0-9a-f]{64}$'),
 chain text NOT NULL CHECK(chain IN('solana','polygon','robinhood-chain')),network text NOT NULL,
 enabled boolean NOT NULL DEFAULT false,valid_until timestamptz NOT NULL,
 enrolled_by name NOT NULL,enrolled_at timestamptz NOT NULL,revoked_at timestamptz,revoked_by name,
 CHECK((revoked_at IS NULL)=(revoked_by IS NULL)),CHECK(NOT enabled OR revoked_at IS NULL)
);
CREATE TABLE public.pipeline_exact_follower_evidence (
 evidence_id text PRIMARY KEY,authority_id text NOT NULL REFERENCES public.pipeline_follower_authorities(authority_id) ON DELETE RESTRICT,
 user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,chain text NOT NULL,network text NOT NULL,
 target_account text NOT NULL,token_mint text NOT NULL,execution_mode text NOT NULL CHECK(execution_mode IN('paper','live','shadow')),
 raw_available_usd text NOT NULL CHECK(raw_available_usd ~ '^(0|[1-9][0-9]{0,77})$'),usd_scale integer NOT NULL CHECK(usd_scale BETWEEN 0 AND 36),
 available_usd text NOT NULL CHECK(available_usd ~ '^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$'),
 observed_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,evidence_digest text NOT NULL CHECK(evidence_digest ~ '^[0-9a-f]{64}$'),
 evidence_canonical text NOT NULL,enrolled_by name NOT NULL,enrolled_at timestamptz NOT NULL,
 enabled boolean NOT NULL DEFAULT true,revoked_at timestamptz,revoked_by name,
 UNIQUE(user_id,chain,target_account,token_mint,execution_mode,observed_at),
 CHECK(available_usd::numeric=raw_available_usd::numeric/power(10::numeric,usd_scale)),
 CHECK(expires_at>observed_at AND expires_at<=observed_at+interval '60 seconds'),
 CHECK((revoked_at IS NULL)=(revoked_by IS NULL)),CHECK(NOT enabled OR revoked_at IS NULL),
 CHECK(evidence_digest=encode(sha256(convert_to(evidence_canonical,'UTF8')),'hex'))
);
CREATE TRIGGER pipeline_follower_authority_enrollment BEFORE INSERT OR UPDATE OR DELETE ON public.pipeline_follower_authorities FOR EACH ROW EXECUTE FUNCTION public.swat_pipeline_external_enrollment();
CREATE TRIGGER pipeline_follower_evidence_enrollment BEFORE INSERT OR UPDATE OR DELETE ON public.pipeline_exact_follower_evidence FOR EACH ROW EXECUTE FUNCTION public.swat_pipeline_external_enrollment();
ALTER TABLE public.pipeline_follower_authorities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pipeline_follower_authorities FORCE ROW LEVEL SECURITY;
ALTER TABLE public.pipeline_exact_follower_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pipeline_exact_follower_evidence FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.pipeline_follower_authorities,public.pipeline_exact_follower_evidence FROM PUBLIC,swat_app,swat_fanout,swat_source_provider_writer,swat_capability_writer,swat_risk_writer,swat_valuation_writer,swat_runtime_lookup;

CREATE FUNCTION public.swat_pipeline_exact_follower_balance(requested_user uuid,requested_chain text,requested_target text,requested_token text,requested_mode text) RETURNS TABLE(
 authority_id text,provider_id text,provider_identity text,enabled boolean,revoked_at timestamptz,user_id uuid,
 chain text,network text,target_account text,token_mint text,execution_mode text,evidence_id text,evidence_digest text,
 raw_available_usd text,usd_scale integer,available_usd text,observed_at timestamptz,expires_at timestamptz,provider_valid_until timestamptz,database_now timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE authorized_terms jsonb; checked_at timestamptz;
BEGIN
 IF current_user IS DISTINCT FROM 'swat_runtime_lookup' OR session_user IS DISTINCT FROM 'swat_fanout'
 THEN RAISE EXCEPTION 'direct protected follower lookup required' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('pipeline-follower',requested_user,requested_chain,requested_target,requested_token,requested_mode)::text,88088));
 PERFORM a.authority_id FROM public.pipeline_follower_authorities a
 WHERE EXISTS(SELECT 1 FROM public.pipeline_exact_follower_evidence e WHERE e.authority_id=a.authority_id
  AND e.user_id=requested_user AND e.chain=requested_chain AND e.target_account=requested_target
  AND e.token_mint=requested_token AND e.execution_mode=requested_mode) FOR SHARE;
 PERFORM e.evidence_id FROM public.pipeline_exact_follower_evidence e
 WHERE e.user_id=requested_user AND e.chain=requested_chain AND e.target_account=requested_target
  AND e.token_mint=requested_token AND e.execution_mode=requested_mode FOR SHARE;
 SELECT b.approved_terms INTO STRICT authorized_terms FROM public.swat_pipeline_backend_capability('fanout','') b;
 checked_at:=clock_timestamp();
 RETURN QUERY
 SELECT a.authority_id,a.provider_id,a.provider_identity,a.enabled,a.revoked_at,e.user_id,e.chain,e.network,e.target_account,
 e.token_mint,e.execution_mode,e.evidence_id,e.evidence_digest,e.raw_available_usd,e.usd_scale,e.available_usd,
 e.observed_at,e.expires_at,a.valid_until,checked_at
 FROM public.pipeline_exact_follower_evidence e JOIN public.pipeline_follower_authorities a ON a.authority_id=e.authority_id
 WHERE current_user='swat_runtime_lookup' AND session_user='swat_fanout'
 AND e.user_id=requested_user AND e.chain=requested_chain AND e.target_account=requested_target AND e.token_mint=requested_token AND e.execution_mode=requested_mode
 AND a.enabled AND a.revoked_at IS NULL AND e.enabled AND e.revoked_at IS NULL AND a.chain=e.chain AND a.network=e.network
 AND a.valid_until>checked_at AND e.observed_at<=checked_at AND e.observed_at>=checked_at-interval '60 seconds'
 AND e.expires_at>checked_at AND e.expires_at<=a.valid_until
 AND authorized_terms->'followerAuthority' = jsonb_build_object('authorityId',a.authority_id,'providerId',a.provider_id,'providerIdentity',a.provider_identity,'chain',a.chain,'network',a.network)
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(authorized_terms->'recipients') r WHERE r->>'userId'=e.user_id::text AND r->>'chain'=e.chain AND r->>'targetAccount'=e.target_account AND r->>'tokenMint'=e.token_mint AND r->>'executionMode'=e.execution_mode)
 AND e.evidence_canonical = public.swat_pipeline_ordered_json(jsonb_build_object('authorityId',a.authority_id,'providerId',a.provider_id,'providerIdentity',a.provider_identity,
 'evidenceId',e.evidence_id,'userId',e.user_id,'chain',e.chain,'network',e.network,'targetAccount',e.target_account,'tokenMint',e.token_mint,
 'executionMode',e.execution_mode,'rawAvailableUsd',e.raw_available_usd,'usdScale',e.usd_scale,'availableUsd',e.available_usd,
 'observedAt',to_char(e.observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'expiresAt',to_char(e.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
 ARRAY['authorityId','providerId','providerIdentity','evidenceId','userId','chain','network','targetAccount','tokenMint','executionMode',
  'rawAvailableUsd','usdScale','availableUsd','observedAt','expiresAt'])
 AND e.evidence_digest=encode(sha256(convert_to(e.evidence_canonical,'UTF8')),'hex')
 -- A newer observation denies fallback even when it is revoked or expired.
 AND NOT EXISTS(SELECT 1 FROM public.pipeline_exact_follower_evidence newer WHERE newer.user_id=e.user_id AND newer.chain=e.chain
 AND newer.target_account=e.target_account AND newer.token_mint=e.token_mint AND newer.execution_mode=e.execution_mode AND newer.observed_at>e.observed_at);
END;
$$;
REVOKE ALL ON FUNCTION public.swat_pipeline_exact_follower_balance(uuid,text,text,text,text) FROM PUBLIC,swat_app,swat_fanout;

-- Exact canonical comparison shared by INVOKER worker routines. No runtime grant;
-- the only runtime authority remains swat_claim_runtime_capability(uuid) from079.
CREATE FUNCTION public.swat_pipeline_worker_scope(requested_execution uuid,terms jsonb) RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE e public.copy_executions; p public.copy_execution_policy_snapshots; d public.source_fanout_deliveries;
 s public.source_trades; h public.source_verification_heads; v public.source_verified_evidence; a public.source_provider_authorities; b public.source_verification_bindings;
BEGIN
 SELECT * INTO STRICT e FROM public.copy_executions WHERE id=requested_execution FOR SHARE;
 SELECT * INTO STRICT p FROM public.copy_execution_policy_snapshots WHERE execution_id=e.id FOR SHARE;
 IF e.user_id IS NULL OR e.execution_mode IS DISTINCT FROM 'paper' OR terms->>'executionId' IS DISTINCT FROM e.id::text
 OR terms->>'userId' IS DISTINCT FROM e.user_id::text OR terms->>'chain' IS DISTINCT FROM e.chain
 OR (terms ? 'tokenMint' AND terms->>'tokenMint' IS DISTINCT FROM e.token_mint)
 OR (terms ? 'targetAccount' AND terms->>'targetAccount' IS DISTINCT FROM e.target_account)
 OR p.user_id IS DISTINCT FROM e.user_id OR p.chain IS DISTINCT FROM e.chain OR p.token_mint IS DISTINCT FROM e.token_mint OR p.target_account IS DISTINCT FROM e.target_account OR p.execution_mode IS DISTINCT FROM e.execution_mode
 OR p.snapshot->'scope' IS DISTINCT FROM jsonb_build_object('account',e.user_id,'chain',e.chain,'tokenMint',e.token_mint,'masterWalletAddress',p.master_wallet_address)
 OR (terms ? 'policyId' AND terms->>'policyId' IS DISTINCT FROM p.snapshot->>'policyId')
 OR (terms ? 'policyRevision' AND terms->>'policyRevision' IS DISTINCT FROM p.snapshot->>'revision')
 THEN RAISE EXCEPTION 'canonical paper execution/tenant/policy scope mismatch'; END IF;
 IF e.source_trade_id IS NOT NULL THEN
  SELECT * INTO STRICT d FROM public.source_fanout_deliveries WHERE execution_id=e.id;
  SELECT * INTO STRICT s FROM public.source_trades WHERE id=e.source_trade_id;
  SELECT * INTO STRICT b FROM public.source_verification_bindings WHERE source_trade_id=s.id;
  SELECT * INTO STRICT h FROM public.source_verification_heads WHERE source_trade_id=s.id;
  SELECT * INTO STRICT v FROM public.source_verified_evidence WHERE evidence_id=h.evidence_id;
  SELECT * INTO STRICT a FROM public.source_provider_authorities WHERE authority_id=v.authority_id;
  IF d.user_id IS DISTINCT FROM e.user_id OR d.execution_mode IS DISTINCT FROM e.execution_mode OR d.target_account IS DISTINCT FROM e.target_account
  OR d.signal_id IS DISTINCT FROM e.signal_id OR d.descriptor->'data'->>'copyExecutionId' IS DISTINCT FROM e.id::text
  OR d.descriptor->'data'->>'sourceTradeId' IS DISTINCT FROM s.id::text
  OR d.descriptor->'data'->>'requestedBaseQuantity' IS DISTINCT FROM e.requested_base_quantity::text
  OR d.descriptor->'data'->>'requestedQuoteQuantity' IS DISTINCT FROM e.requested_quote_quantity::text
  OR s.chain IS DISTINCT FROM e.chain OR s.token_mint IS DISTINCT FROM e.token_mint OR s.direction IS DISTINCT FROM e.direction OR s.wallet_address IS DISTINCT FROM p.master_wallet_address
  OR s.confirmation_state NOT IN('confirmed','finalized') OR h.confirmation_state IS DISTINCT FROM s.confirmation_state OR v.finality IS DISTINCT FROM s.confirmation_state
  OR v.source_trade_id IS DISTINCT FROM s.id OR v.binding_digest IS DISTINCT FROM b.binding_digest OR NOT a.enabled OR a.valid_until<=statement_timestamp()
  OR v.provider_valid_until<=statement_timestamp() OR a.provider_id IS DISTINCT FROM v.provider_id OR a.identity_digest IS DISTINCT FROM v.provider_identity_digest
  OR a.verifier_version IS DISTINCT FROM v.verifier_version OR a.chain IS DISTINCT FROM s.chain OR a.network IS DISTINCT FROM b.network
  OR NOT EXISTS(SELECT 1 FROM public.source_fanout_batches WHERE signal_id=e.signal_id AND source_trade_id=s.id AND state='complete')
  OR NOT EXISTS(SELECT 1 FROM public.signals WHERE id=e.signal_id AND source_trade_id=s.id)
  OR NOT EXISTS(SELECT 1 FROM public.source_position_applications WHERE source_trade_id=s.id AND wallet_address=s.wallet_address AND chain=s.chain AND token_mint=s.token_mint AND active)
  OR (terms ? 'obligationKind' AND (terms->>'obligationKind' IS DISTINCT FROM 'fanout' OR terms->>'obligationId' IS DISTINCT FROM d.job_id))
  THEN RAISE EXCEPTION 'canonical obligation/source/provider/evidence unavailable'; END IF;
 ELSE
  IF e.direction IS DISTINCT FROM 'sell' OR e.exit_lot_id IS NULL OR e.exit_trigger NOT IN('stop-loss','close-all')
  OR NOT EXISTS(SELECT 1 FROM public.copy_position_master_lots lot
   JOIN public.copy_positions pos ON pos.id=lot.position_id AND pos.user_id=e.user_id AND pos.target_account=e.target_account
   JOIN public.copy_executions buy ON buy.id=lot.acquisition_execution_id AND buy.user_id=e.user_id AND buy.direction='buy' AND buy.execution_mode=e.execution_mode
    AND buy.target_account=e.target_account AND buy.chain=e.chain AND buy.token_mint=e.token_mint AND buy.source_trade_id=lot.source_trade_id
   JOIN public.copy_execution_evidence fill ON fill.id=lot.acquisition_evidence_id AND fill.execution_id=buy.id AND fill.confirmation_state IN('confirmed','finalized')
   JOIN public.copy_position_applications applied ON applied.evidence_id=fill.id AND applied.execution_id=buy.id AND applied.position_id=pos.id AND applied.user_id=e.user_id AND applied.active
   WHERE lot.id=e.exit_lot_id AND lot.user_id=e.user_id AND lot.chain=e.chain AND lot.token_mint=e.token_mint AND lot.master_wallet_address=p.master_wallet_address)
  OR (e.exit_trigger='close-all' AND NOT EXISTS(SELECT 1 FROM public.copy_position_close_all_claims WHERE execution_id=e.id AND lot_id=e.exit_lot_id AND user_id=e.user_id AND requested_quantity=e.requested_base_quantity AND status IN('claimed','confirmed')))
  OR (terms ? 'obligationKind' AND (terms->>'obligationKind' IS DISTINCT FROM 'lot-exit' OR terms->>'obligationId' IS DISTINCT FROM e.exit_lot_id::text))
  THEN RAISE EXCEPTION 'canonical lot/acquisition/tenant/fill obligation unavailable'; END IF;
 END IF;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.swat_pipeline_worker_scope(uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.swat_pipeline_worker_scope(uuid,jsonb) TO swat_capability_writer,swat_risk_writer,swat_valuation_writer;

-- Immutable full registration persists alongside079's narrow runtime registry.
-- No second runtime claim and no callable authority registration for swat_app.
CREATE TABLE public.pipeline_worker_registrations (
 execution_id uuid PRIMARY KEY REFERENCES public.copy_executions(id) ON DELETE RESTRICT,
 capability_id uuid NOT NULL UNIQUE REFERENCES public.worker_runtime_capabilities(capability_id) ON DELETE RESTRICT,
 terms jsonb NOT NULL,registered_at timestamptz NOT NULL DEFAULT statement_timestamp()
);
ALTER TABLE public.pipeline_worker_registrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pipeline_worker_registrations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.pipeline_worker_registrations FROM PUBLIC,swat_app,swat_capability_writer;
CREATE FUNCTION public.swat_pipeline_register_worker_capability(requested_execution uuid,terms jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE a record; old public.worker_runtime_capabilities; recorded jsonb;
BEGIN
 IF current_user IS DISTINCT FROM 'swat_capability_writer' OR session_user IS DISTINCT FROM current_user THEN RAISE EXCEPTION 'direct independent capability writer required'; END IF;
 SELECT * INTO STRICT a FROM public.swat_pipeline_backend_capability('worker-register',requested_execution::text);
 IF a.approved_terms IS DISTINCT FROM terms THEN RAISE EXCEPTION 'worker registration differs from independent approved terms'; END IF;
 PERFORM public.swat_pipeline_worker_scope(requested_execution,terms);
 IF terms->>'runtimeRole' IS DISTINCT FROM 'swat_app' OR terms->>'executionMode' IS DISTINCT FROM 'paper'
 OR terms->>'databaseOid' IS DISTINCT FROM a.database_oid::text OR terms->>'serverAddress' IS DISTINCT FROM a.server_address
 OR (terms->>'serverPort')::integer IS DISTINCT FROM a.server_port
 OR terms->>'backendIdentity' IS DISTINCT FROM concat(current_database(),'|',a.server_address,'|',a.server_port,'|swat_app')
 OR (terms->>'validFrom')::timestamptz>statement_timestamp() OR (terms->>'expiresAt')::timestamptz<=statement_timestamp()
 OR (terms->>'expiresAt')::timestamptz>a.expires_at
 THEN RAISE EXCEPTION 'exact079 runtime backend/validity registration mismatch'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(requested_execution::text,88079));
 SELECT * INTO old FROM public.worker_runtime_capabilities WHERE execution_id=requested_execution;
 IF old.capability_id IS NOT NULL THEN
  SELECT r.terms INTO recorded FROM public.pipeline_worker_registrations r WHERE r.execution_id=requested_execution;
  IF recorded IS DISTINCT FROM terms OR old.revoked_at IS NOT NULL OR old.capability_id IS DISTINCT FROM (terms->>'capabilityId')::uuid
  OR old.revision IS DISTINCT FROM terms->>'revision' OR old.runtime_role IS DISTINCT FROM 'swat_app' OR old.database_oid IS DISTINCT FROM a.database_oid
  OR old.server_address IS DISTINCT FROM a.server_address OR old.server_port IS DISTINCT FROM a.server_port OR old.backend_identity IS DISTINCT FROM terms->>'backendIdentity'
  OR old.valid_from IS DISTINCT FROM (terms->>'validFrom')::timestamptz OR old.expires_at IS DISTINCT FROM (terms->>'expiresAt')::timestamptz
  THEN RAISE EXCEPTION 'immutable079 registry collision/revocation'; END IF;
  RETURN recorded;
 END IF;
 INSERT INTO public.worker_runtime_capabilities(capability_id,revision,execution_id,runtime_role,database_oid,server_address,server_port,backend_identity,valid_from,expires_at)
 VALUES((terms->>'capabilityId')::uuid,terms->>'revision',requested_execution,'swat_app',a.database_oid,a.server_address,a.server_port,terms->>'backendIdentity',(terms->>'validFrom')::timestamptz,(terms->>'expiresAt')::timestamptz);
 INSERT INTO public.pipeline_worker_registrations(execution_id,capability_id,terms) VALUES(requested_execution,(terms->>'capabilityId')::uuid,terms);
 RETURN terms;
END $$;
REVOKE ALL ON FUNCTION public.swat_pipeline_register_worker_capability(uuid,jsonb) FROM PUBLIC,swat_app;
GRANT EXECUTE ON FUNCTION public.swat_pipeline_register_worker_capability(uuid,jsonb) TO swat_capability_writer;

CREATE FUNCTION public.swat_pipeline_registry_guard() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE terms jsonb;
BEGIN
 IF TG_OP='UPDATE' AND TG_TABLE_NAME='worker_runtime_capabilities' AND public.swat_pipeline_external_dba() IS TRUE
 AND (to_jsonb(NEW)-'revoked_at') IS NOT DISTINCT FROM (to_jsonb(OLD)-'revoked_at') AND OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
 AND NEW.revoked_at>=OLD.valid_from AND NEW.revoked_at<=clock_timestamp()
 THEN RETURN NEW; END IF;
 IF TG_OP IS DISTINCT FROM 'INSERT' OR current_user IS DISTINCT FROM 'swat_capability_writer' OR session_user IS DISTINCT FROM current_user THEN RAISE EXCEPTION 'immutable registry/direct independent writer required'; END IF;
 terms:=public.swat_pipeline_approved('worker-register',NEW.execution_id::text);
 IF TG_TABLE_NAME='pipeline_worker_registrations' THEN
  IF NEW.terms IS DISTINCT FROM terms OR NEW.capability_id IS DISTINCT FROM (terms->>'capabilityId')::uuid THEN RAISE EXCEPTION 'registry full terms collision'; END IF;
 ELSE
  IF NEW.capability_id IS DISTINCT FROM (terms->>'capabilityId')::uuid OR NEW.runtime_role IS DISTINCT FROM 'swat_app'
  OR NEW.revision IS DISTINCT FROM terms->>'revision' OR NEW.database_oid::text IS DISTINCT FROM terms->>'databaseOid'
  OR NEW.server_address IS DISTINCT FROM terms->>'serverAddress' OR NEW.server_port IS DISTINCT FROM (terms->>'serverPort')::integer
  OR NEW.backend_identity IS DISTINCT FROM terms->>'backendIdentity' OR NEW.valid_from IS DISTINCT FROM (terms->>'validFrom')::timestamptz
  OR NEW.expires_at IS DISTINCT FROM (terms->>'expiresAt')::timestamptz OR NEW.revoked_at IS NOT NULL
  THEN RAISE EXCEPTION 'registry insert requires all precise independently approved079 terms'; END IF;
 END IF;
 PERFORM public.swat_pipeline_worker_scope(NEW.execution_id,terms);
 RETURN NEW;
END $$;

-- SQL072 readiness audits all retained liabilities for the whole precise account,
-- chain and paper mode. Unknown/incomplete economics are never released or zeroed.
CREATE FUNCTION public.swat_pipeline_write_risk_policy(requested_execution uuid,terms jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE old public.risk_policy_control; recorded jsonb;
BEGIN
 IF current_user IS DISTINCT FROM 'swat_risk_writer' OR session_user IS DISTINCT FROM current_user OR public.swat_pipeline_approved('risk-write',requested_execution::text) IS DISTINCT FROM terms
 THEN RAISE EXCEPTION 'direct independent risk approval required'; END IF;
 PERFORM public.swat_pipeline_worker_scope(requested_execution,terms);
 IF terms->>'account' IS DISTINCT FROM terms->>'userId' OR terms->>'executionMode' IS DISTINCT FROM 'paper'
 OR (terms->>'capUsd')::numeric<=0 OR ((terms->>'enabled')::boolean AND NOT (terms->>'accountingReady')::boolean)
 THEN RAISE EXCEPTION 'risk exact tenant/paper/ready terms required'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(concat(terms->>'account','|',terms->>'chain','|paper'),88072));
 SELECT * INTO old FROM public.risk_policy_control WHERE account=terms->>'account' AND chain=terms->>'chain' AND execution_mode='paper' FOR UPDATE;
 IF old.epoch IS NOT NULL AND old.epoch=(terms->>'epoch')::bigint THEN
  IF old.cap_usd IS DISTINCT FROM (terms->>'capUsd')::numeric OR old.enabled IS DISTINCT FROM (terms->>'enabled')::boolean OR old.accounting_ready IS DISTINCT FROM (terms->>'accountingReady')::boolean
  THEN RAISE EXCEPTION 'risk same-epoch immutable collision'; END IF; RETURN terms;
 END IF;
 IF old.epoch::text IS DISTINCT FROM terms->>'previousEpoch' OR (old.epoch IS NOT NULL AND old.epoch>=(terms->>'epoch')::bigint)
 THEN RAISE EXCEPTION 'risk epoch CAS conflict'; END IF;
 IF (terms->>'accountingReady')::boolean AND (
 EXISTS(SELECT 1 FROM public.risk_spend_reservations r WHERE r.account=terms->>'account' AND r.chain=terms->>'chain' AND r.execution_mode='paper'
  AND (r.state NOT IN('confirmed','released') OR (r.state='confirmed' AND NOT EXISTS(
   SELECT 1 FROM public.copy_execution_financial_receipts f JOIN public.copy_executions e ON e.id=f.execution_id
   WHERE f.execution_id=r.execution_id AND f.accounting_complete AND e.state='confirmed'
   AND (f.snapshot->'totals'->>'debit')::numeric=r.confirmed_usd AND r.liability_usd=r.confirmed_usd))))
 OR EXISTS(SELECT 1 FROM public.copy_executions e WHERE e.user_id::text=terms->>'account' AND e.chain=terms->>'chain' AND e.execution_mode='paper' AND e.direction='buy'
 AND EXISTS(SELECT 1 FROM public.copy_execution_evidence f WHERE f.execution_id=e.id AND f.confirmation_state IN('confirmed','finalized'))
 AND NOT EXISTS(SELECT 1 FROM public.risk_spend_reservations r WHERE r.execution_id=e.id))
 OR EXISTS(SELECT 1 FROM public.worker_effective_execution_evidence f JOIN public.copy_executions e ON e.id=f.execution_id
 WHERE e.user_id::text=terms->>'account' AND e.chain=terms->>'chain' AND e.execution_mode='paper' AND f.confirmation_state IN('confirmed','finalized')
 AND (f.effective_quote_usd IS NULL OR f.effective_fee_usd IS NULL OR (f.valuation_correction_id IS NOT NULL AND NOT public.worker_correction_authorized(f.valuation_correction_id)))))
 THEN RAISE EXCEPTION 'risk accounting coverage incomplete; retain liabilities'; END IF;
 INSERT INTO public.risk_policy_control(account,chain,execution_mode,epoch,enabled,cap_usd,accounting_ready)
 VALUES(terms->>'account',terms->>'chain','paper',(terms->>'epoch')::bigint,(terms->>'enabled')::boolean,(terms->>'capUsd')::numeric,(terms->>'accountingReady')::boolean)
 ON CONFLICT(account,chain,execution_mode) DO UPDATE SET epoch=EXCLUDED.epoch,enabled=EXCLUDED.enabled,cap_usd=EXCLUDED.cap_usd,accounting_ready=EXCLUDED.accounting_ready;
 RETURN terms;
END $$;
REVOKE ALL ON FUNCTION public.swat_pipeline_write_risk_policy(uuid,jsonb) FROM PUBLIC,swat_app;
GRANT EXECUTE ON FUNCTION public.swat_pipeline_write_risk_policy(uuid,jsonb) TO swat_risk_writer;

-- Validate EXACT080 old body, owner and invoker mode BEFORE forward replacement.
-- Literal old bodies avoid a checksum execution during the global authoring freeze.
DO $pin080$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.guard_worker_valuation_authority()')
 AND proowner=(SELECT oid FROM pg_roles WHERE rolname='swat_migrator') AND NOT prosecdef
 AND proconfig=ARRAY['search_path=pg_catalog'] AND prosrc=$old080authority$
BEGIN
 IF current_user <> 'swat_migrator' OR session_user <> 'swat_migrator' THEN
   RAISE EXCEPTION 'approved independent valuation provisioning unavailable';
 END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'valuation authority history anchor cannot be deleted'; END IF;
 IF TG_OP='UPDATE' AND ((to_jsonb(NEW)-'enabled') IS DISTINCT FROM (to_jsonb(OLD)-'enabled')
   OR NOT OLD.enabled OR NEW.enabled) THEN
   RAISE EXCEPTION 'authority update permits only one-way explicit revocation';
 END IF;
 RETURN NEW;
END $old080authority$)
 OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.guard_trusted_worker_valuation()')
 AND proowner=(SELECT oid FROM pg_roles WHERE rolname='swat_migrator') AND NOT prosecdef
 AND proconfig=ARRAY['search_path=pg_catalog'] AND prosrc=$old080trusted$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'independent trusted valuation immutable'; END IF;
 IF current_user <> 'swat_migrator' OR session_user <> 'swat_migrator' THEN
   RAISE EXCEPTION 'approved independent valuation writer unavailable';
 END IF;
 RETURN NEW;
END $old080trusted$)
 THEN RAISE EXCEPTION '088 exact old080 valuation guards unavailable'; END IF;
END $pin080$;
CREATE FUNCTION public.swat_pipeline_valuation_authority_terms(a public.worker_valuation_authorities) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('authorityId',a.authority_id,'userId',a.user_id,'chain',a.chain,'network',a.network,'providerId',a.provider_id,
 'identityDigest',a.identity_digest,'verifierVersion',a.verifier_version,'enabled',a.enabled,
 'validUntil',to_char(a.valid_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'maxQuoteUsd',trim_scale(a.max_quote_usd)::text,'maxFeeUsd',trim_scale(a.max_fee_usd)::text)
$$;
REVOKE ALL ON FUNCTION public.swat_pipeline_valuation_authority_terms(public.worker_valuation_authorities) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.swat_pipeline_valuation_authority_terms(public.worker_valuation_authorities) TO swat_valuation_writer;
CREATE OR REPLACE FUNCTION public.guard_worker_valuation_authority() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE terms jsonb; approved record;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'valuation authority retained'; END IF;
 IF TG_OP='UPDATE' THEN
  IF public.swat_pipeline_external_dba() IS DISTINCT FROM true
  OR (to_jsonb(NEW)-'enabled') IS DISTINCT FROM (to_jsonb(OLD)-'enabled') OR NOT OLD.enabled OR NEW.enabled
  THEN RAISE EXCEPTION 'only direct external DBA permanent valuation revocation'; END IF;
  RETURN NEW;
 END IF;
 IF current_user IS DISTINCT FROM 'swat_valuation_writer' OR session_user IS DISTINCT FROM current_user THEN RAISE EXCEPTION 'direct approved valuation writer required'; END IF;
 terms:=public.swat_pipeline_valuation_authority_terms(NEW);
 SELECT * INTO STRICT approved FROM public.swat_pipeline_backend_capability('valuation-register',NEW.authority_id);
 IF approved.approved_terms IS DISTINCT FROM terms OR NOT NEW.enabled OR NEW.valid_until<=statement_timestamp() OR NEW.valid_until>approved.expires_at
 OR NOT EXISTS(SELECT 1 FROM public.users WHERE id=NEW.user_id AND status='active')
 THEN RAISE EXCEPTION 'valuation authority exact enrollment/tenant/expiry mismatch'; END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION public.swat_pipeline_trusted_valuation_terms(v public.trusted_worker_valuations) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('valuationId',v.valuation_id,'authorityId',v.authority_id,'originalEvidenceId',v.original_evidence_id,
 'executionId',v.execution_id,'userId',v.user_id,'sourceEvidenceId',v.source_evidence_id,'lineageSourceTradeId',v.lineage_source_trade_id,
 'lineageAcquisitionEvidenceId',v.lineage_acquisition_evidence_id,'lineageMasterWalletAddress',v.lineage_master_wallet_address,
 'originalDigest',v.original_digest,'providerId',v.provider_id,'providerIdentityDigest',v.provider_identity_digest,'verifierVersion',v.verifier_version,
 'revision',v.revision::text,'quoteUsd',trim_scale(v.quote_usd)::text,'feeUsd',trim_scale(v.fee_usd)::text,
 'validUntil',to_char(v.valid_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
$$;
REVOKE ALL ON FUNCTION public.swat_pipeline_trusted_valuation_terms(public.trusted_worker_valuations) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.swat_pipeline_trusted_valuation_terms(public.trusted_worker_valuations) TO swat_valuation_writer;
CREATE OR REPLACE FUNCTION public.guard_trusted_worker_valuation() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE terms jsonb; approval record; a public.worker_valuation_authorities; e public.copy_executions; f public.copy_execution_evidence; lineage record; original text;
BEGIN
 IF TG_OP IS DISTINCT FROM 'INSERT' OR current_user IS DISTINCT FROM 'swat_valuation_writer' OR session_user IS DISTINCT FROM current_user THEN RAISE EXCEPTION 'immutable valuation/direct independent writer required'; END IF;
 terms:=public.swat_pipeline_trusted_valuation_terms(NEW);
 SELECT * INTO STRICT approval FROM public.swat_pipeline_backend_capability('valuation-write',NEW.valuation_id);
 IF approval.approved_terms IS DISTINCT FROM terms OR NEW.valid_until>approval.expires_at OR NEW.valid_until<=statement_timestamp()
 THEN RAISE EXCEPTION 'trusted valuation differs from exact independent approved terms'; END IF;
 SELECT * INTO STRICT e FROM public.copy_executions WHERE id=NEW.execution_id;
 SELECT * INTO STRICT a FROM public.worker_valuation_authorities WHERE authority_id=NEW.authority_id FOR SHARE;
 SELECT * INTO STRICT f FROM public.copy_execution_evidence WHERE id=NEW.original_evidence_id AND execution_id=e.id FOR SHARE;
 PERFORM public.swat_pipeline_worker_scope(e.id,terms||jsonb_build_object('chain',e.chain));
 SELECT * INTO STRICT lineage FROM public.worker_correction_lineage(e.id,f.id);
 IF a.user_id IS DISTINCT FROM e.user_id OR NEW.user_id IS DISTINCT FROM e.user_id OR a.chain IS DISTINCT FROM e.chain OR NOT a.enabled
 OR a.valid_until<=statement_timestamp() OR NEW.valid_until>a.valid_until OR NEW.provider_id IS DISTINCT FROM a.provider_id OR NEW.provider_identity_digest IS DISTINCT FROM a.identity_digest
 OR NEW.verifier_version IS DISTINCT FROM a.verifier_version OR (NEW.quote_usd IS NOT NULL AND NEW.quote_usd>a.max_quote_usd) OR (NEW.fee_usd IS NOT NULL AND NEW.fee_usd>a.max_fee_usd)
 OR f.confirmation_state NOT IN('confirmed','finalized') OR NEW.lineage_source_trade_id IS DISTINCT FROM lineage.source_trade_id
 OR NEW.lineage_acquisition_evidence_id IS DISTINCT FROM lineage.acquisition_evidence_id OR NEW.lineage_master_wallet_address IS DISTINCT FROM lineage.master_wallet_address
 OR NOT EXISTS(SELECT 1 FROM public.source_verification_heads h JOIN public.source_verification_bindings b ON b.source_trade_id=h.source_trade_id
 WHERE h.source_trade_id=lineage.source_trade_id AND h.evidence_id=NEW.source_evidence_id AND b.network=a.network)
 OR NOT EXISTS(SELECT 1 FROM public.copy_position_applications app WHERE app.evidence_id=f.id AND app.execution_id=e.id AND app.user_id=e.user_id AND app.active)
 THEN RAISE EXCEPTION 'trusted valuation canonical original/source/acquisition/authority mismatch'; END IF;
 -- Exact field order is workerOriginalEvidenceSnapshot, NOT sorted jsonb text.
 original:='{'||'"id":'||to_jsonb(f.id)::text||',"executionId":'||to_jsonb(e.id)::text||',"userId":'||to_jsonb(e.user_id)::text||
 ',"sourceTradeId":'||COALESCE(to_jsonb(e.source_trade_id)::text,'null')||',"evidenceType":'||to_jsonb(f.evidence_type)::text||',"evidenceId":'||to_jsonb(f.evidence_id)::text||
 ',"baseQuantity":'||to_jsonb(trim_scale(f.base_quantity)::text)::text||',"quoteQuantity":'||COALESCE(to_jsonb(trim_scale(f.quote_quantity)::text)::text,'null')||
 ',"quoteNativeQuantity":'||COALESCE(to_jsonb(trim_scale(f.quote_native_quantity)::text)::text,'null')||',"quoteCurrency":'||COALESCE(to_jsonb(f.quote_currency)::text,'null')||
 ',"quoteNativeUsdPrice":'||COALESCE(to_jsonb(trim_scale(f.quote_native_usd_price)::text)::text,'null')||',"priceUsd":'||COALESCE(to_jsonb(trim_scale(f.price_usd)::text)::text,'null')||
 ',"feeUsd":'||COALESCE(to_jsonb(trim_scale(f.fee_usd)::text)::text,'null')||',"occurredAt":'||to_jsonb(to_char(f.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))::text||
 ',"completesExecution":'||to_jsonb(f.completes_execution)::text||'}';
 IF NEW.original_digest IS DISTINCT FROM encode(sha256(convert_to(original,'UTF8')),'hex') THEN RAISE EXCEPTION 'trusted original immutable digest mismatch'; END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION public.swat_pipeline_register_worker_valuation_authority(requested_authority text,terms jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE old public.worker_valuation_authorities;
BEGIN
 IF current_user IS DISTINCT FROM 'swat_valuation_writer' OR session_user IS DISTINCT FROM current_user OR terms->>'authorityId' IS DISTINCT FROM requested_authority
 OR public.swat_pipeline_approved('valuation-register',requested_authority) IS DISTINCT FROM terms THEN RAISE EXCEPTION 'independent exact valuation enrollment required'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(requested_authority,88080));
 SELECT * INTO old FROM public.worker_valuation_authorities WHERE authority_id=requested_authority FOR SHARE;
 IF old.authority_id IS NOT NULL THEN
  IF public.swat_pipeline_valuation_authority_terms(old) IS DISTINCT FROM terms OR NOT old.enabled THEN RAISE EXCEPTION 'valuation authority immutable collision/revocation'; END IF; RETURN terms;
 END IF;
 INSERT INTO public.worker_valuation_authorities(authority_id,user_id,chain,network,provider_id,identity_digest,verifier_version,enabled,valid_until,max_quote_usd,max_fee_usd)
 VALUES(requested_authority,(terms->>'userId')::uuid,terms->>'chain',terms->>'network',terms->>'providerId',terms->>'identityDigest',terms->>'verifierVersion',true,
 (terms->>'validUntil')::timestamptz,(terms->>'maxQuoteUsd')::numeric,(terms->>'maxFeeUsd')::numeric);
 RETURN terms;
END $$;
REVOKE ALL ON FUNCTION public.swat_pipeline_register_worker_valuation_authority(text,jsonb) FROM PUBLIC,swat_app;
GRANT EXECUTE ON FUNCTION public.swat_pipeline_register_worker_valuation_authority(text,jsonb) TO swat_valuation_writer;
CREATE FUNCTION public.swat_pipeline_record_trusted_worker_valuation(requested_valuation text,terms jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE old public.trusted_worker_valuations;
BEGIN
 IF current_user IS DISTINCT FROM 'swat_valuation_writer' OR session_user IS DISTINCT FROM current_user OR terms->>'valuationId' IS DISTINCT FROM requested_valuation
 OR public.swat_pipeline_approved('valuation-write',requested_valuation) IS DISTINCT FROM terms THEN RAISE EXCEPTION 'independent exact trusted valuation required'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(requested_valuation,88081));
 SELECT * INTO old FROM public.trusted_worker_valuations WHERE valuation_id=requested_valuation FOR SHARE;
 IF old.valuation_id IS NOT NULL THEN
  IF public.swat_pipeline_trusted_valuation_terms(old) IS DISTINCT FROM terms THEN RAISE EXCEPTION 'valuation immutable collision'; END IF; RETURN terms;
 END IF;
 INSERT INTO public.trusted_worker_valuations(valuation_id,authority_id,original_evidence_id,execution_id,user_id,source_evidence_id,lineage_source_trade_id,
 lineage_acquisition_evidence_id,lineage_master_wallet_address,original_digest,provider_id,provider_identity_digest,verifier_version,revision,quote_usd,fee_usd,valid_until)
 VALUES(requested_valuation,terms->>'authorityId',(terms->>'originalEvidenceId')::uuid,(terms->>'executionId')::uuid,(terms->>'userId')::uuid,terms->>'sourceEvidenceId',
 (terms->>'lineageSourceTradeId')::uuid,(terms->>'lineageAcquisitionEvidenceId')::uuid,terms->>'lineageMasterWalletAddress',terms->>'originalDigest',terms->>'providerId',
 terms->>'providerIdentityDigest',terms->>'verifierVersion',(terms->>'revision')::numeric,(terms->>'quoteUsd')::numeric,(terms->>'feeUsd')::numeric,(terms->>'validUntil')::timestamptz);
 RETURN terms;
END $$;
REVOKE ALL ON FUNCTION public.swat_pipeline_record_trusted_worker_valuation(text,jsonb) FROM PUBLIC,swat_app;
GRANT EXECUTE ON FUNCTION public.swat_pipeline_record_trusted_worker_valuation(text,jsonb) TO swat_valuation_writer;

-- Pre-fill quote evidence is NOT SQL080 trusted_worker_valuations; no fictional
-- original_evidence_id FK is manufactured. Direct external DBA enrollment only.
CREATE TABLE public.pipeline_paper_valuation_evidence (
 evidence_id text PRIMARY KEY,execution_id uuid NOT NULL UNIQUE REFERENCES public.copy_executions(id) ON DELETE RESTRICT,
 user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 authority_id text NOT NULL REFERENCES public.worker_valuation_authorities(authority_id) ON DELETE RESTRICT,
 source_trade_id uuid NOT NULL REFERENCES public.source_trades(id) ON DELETE RESTRICT,
 source_evidence_id text NOT NULL REFERENCES public.source_verified_evidence(evidence_id) ON DELETE RESTRICT,
 evidence_digest text NOT NULL,terms jsonb NOT NULL CHECK(jsonb_typeof(terms)='object'),recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 CHECK((terms->>'evidenceId'=evidence_id AND terms->>'executionId'=execution_id::text AND terms->>'userId'=user_id::text
 AND terms->>'authorityId'=authority_id AND terms->>'sourceTradeId'=source_trade_id::text AND terms->>'sourceEvidenceId'=source_evidence_id
 AND terms->>'evidenceDigest'=evidence_digest AND evidence_digest=encode(sha256(convert_to(public.swat_pipeline_canonical_json(terms-'evidenceDigest'),'UTF8')),'hex')) IS TRUE)
);
ALTER TABLE public.pipeline_paper_valuation_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pipeline_paper_valuation_evidence FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.pipeline_paper_valuation_evidence FROM PUBLIC,swat_app,swat_valuation_writer;
CREATE FUNCTION public.swat_pipeline_paper_evidence_guard() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP IS DISTINCT FROM 'INSERT' OR public.swat_pipeline_external_dba() IS DISTINCT FROM true
 OR NOT EXISTS(SELECT 1 FROM public.pipeline_backend_approvals a WHERE a.purpose='paper-valuation' AND a.authority_id=NEW.execution_id::text
 AND a.approved_terms=NEW.terms AND a.revoked_at IS NULL AND a.valid_from<=clock_timestamp() AND a.expires_at>clock_timestamp()
 AND a.database_name=current_database() AND a.database_oid=(SELECT oid FROM pg_database WHERE datname=current_database())
 AND a.system_identifier=(SELECT system_identifier::text FROM pg_control_system())
 AND a.server_address=COALESCE(inet_server_addr()::text,'unix') AND a.server_port=COALESCE(inet_server_port(),0))
 THEN RAISE EXCEPTION 'immutable prefill evidence requires independent authenticated external enrollment'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.swat_pipeline_paper_evidence_guard() FROM PUBLIC;
CREATE TRIGGER pipeline_prefill_evidence_guard BEFORE INSERT OR UPDATE OR DELETE ON public.pipeline_paper_valuation_evidence FOR EACH ROW EXECUTE FUNCTION public.swat_pipeline_paper_evidence_guard();
CREATE FUNCTION public.swat_pipeline_paper_valuation(requested_execution uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE terms jsonb; q public.pipeline_paper_valuation_evidence; e public.copy_executions; a public.worker_valuation_authorities; b public.source_verification_bindings;
BEGIN
 IF current_user IS DISTINCT FROM 'swat_valuation_writer' OR session_user IS DISTINCT FROM current_user THEN RAISE EXCEPTION 'direct independent paper valuation role required'; END IF;
 terms:=public.swat_pipeline_approved('paper-valuation',requested_execution::text);
 SELECT * INTO STRICT q FROM public.pipeline_paper_valuation_evidence WHERE execution_id=requested_execution FOR SHARE;
 SELECT * INTO STRICT e FROM public.copy_executions WHERE id=requested_execution FOR SHARE;
 SELECT * INTO STRICT a FROM public.worker_valuation_authorities WHERE authority_id=q.authority_id FOR SHARE;
 SELECT * INTO STRICT b FROM public.source_verification_bindings WHERE source_trade_id=q.source_trade_id FOR SHARE;
 PERFORM public.swat_pipeline_worker_scope(requested_execution,terms);
 IF jsonb_typeof(terms) IS DISTINCT FROM 'object' OR (terms ?& ARRAY['executionId','userId','chain','tokenMint','targetAccount','executionMode','direction',
  'requestedBase','requestedQuote','authorityId','providerId','providerIdentity','verifierVersion','network','baseDecimals',
  'sourceTradeId','sourceEvidenceId','bindingDigest','rawQuantity','quantityScale','priceUsd','quoteCurrency','evidenceId',
  'evidenceDigest','observedAt','expiresAt','simulationModelId','simulatedFeeBps','simulatedFixedFeeUsd']) IS DISTINCT FROM true
  OR terms->>'observedAt' IS NULL OR terms->>'expiresAt' IS NULL OR terms->>'priceUsd' IS NULL
  OR terms->>'baseDecimals' IS NULL OR terms->>'quantityScale' IS NULL OR terms->>'simulationModelId' IS NULL
  OR terms->>'simulatedFeeBps' IS NULL OR terms->>'simulatedFixedFeeUsd' IS NULL
 THEN RAISE EXCEPTION 'complete nonnull paper valuation model required'; END IF;
 IF q.terms IS DISTINCT FROM terms OR NOT a.enabled OR a.user_id IS DISTINCT FROM e.user_id OR a.chain IS DISTINCT FROM e.chain OR a.network IS DISTINCT FROM b.network OR a.valid_until<=statement_timestamp()
 OR terms->>'providerId' IS DISTINCT FROM a.provider_id OR terms->>'providerIdentity' IS DISTINCT FROM a.identity_digest OR terms->>'verifierVersion' IS DISTINCT FROM a.verifier_version
 OR terms->>'network' IS DISTINCT FROM a.network OR terms->>'executionMode' IS DISTINCT FROM 'paper' OR terms->>'quoteCurrency' IS DISTINCT FROM 'USD'
 OR terms->>'tokenMint' IS DISTINCT FROM e.token_mint OR terms->>'targetAccount' IS DISTINCT FROM e.target_account
 OR terms->>'chain' IS DISTINCT FROM e.chain OR terms->>'userId' IS DISTINCT FROM e.user_id::text
 OR q.user_id IS DISTINCT FROM e.user_id OR q.source_trade_id IS DISTINCT FROM e.source_trade_id
 OR terms->>'direction' IS DISTINCT FROM e.direction OR terms->>'requestedBase' IS DISTINCT FROM trim_scale(e.requested_base_quantity)::text
 OR terms->>'requestedQuote' IS DISTINCT FROM trim_scale(e.requested_quote_quantity)::text
 OR terms->>'bindingDigest' IS DISTINCT FROM b.binding_digest OR terms->>'rawQuantity' IS DISTINCT FROM b.raw_quantity
 OR (terms->>'quantityScale')::integer IS DISTINCT FROM b.quantity_scale
 OR NOT EXISTS(SELECT 1 FROM public.source_verification_heads WHERE source_trade_id=q.source_trade_id AND evidence_id=q.source_evidence_id AND confirmation_state IN('confirmed','finalized'))
 OR NOT isfinite((terms->>'observedAt')::timestamptz) OR NOT isfinite((terms->>'expiresAt')::timestamptz)
 OR (terms->>'observedAt')::timestamptz>clock_timestamp() OR (terms->>'observedAt')::timestamptz<clock_timestamp()-interval '60 seconds'
 OR (terms->>'expiresAt')::timestamptz<=clock_timestamp() OR (terms->>'expiresAt')::timestamptz>a.valid_until
 OR (terms->>'expiresAt')::timestamptz>(terms->>'observedAt')::timestamptz+interval '60 seconds'
 OR (terms->>'priceUsd')::numeric<=0 OR (terms->>'baseDecimals')::integer NOT BETWEEN 0 AND 36
 OR (terms->>'simulatedFeeBps')::numeric NOT BETWEEN 0 AND 10000 OR (terms->>'simulatedFixedFeeUsd')::numeric<0
 OR q.evidence_digest IS DISTINCT FROM encode(sha256(convert_to(public.swat_pipeline_canonical_json(terms-'evidenceDigest'),'UTF8')),'hex')
 THEN RAISE EXCEPTION 'prefill exact persisted source/provider/rawscale/model/sizing unavailable'; END IF;
 RETURN terms;
END $$;
REVOKE ALL ON FUNCTION public.swat_pipeline_paper_valuation(uuid) FROM PUBLIC,swat_app;
GRANT EXECUTE ON FUNCTION public.swat_pipeline_paper_valuation(uuid) TO swat_valuation_writer;

CREATE TABLE public.pipeline_worker_paper_receipts (
 receipt_id text PRIMARY KEY CHECK(receipt_id ~ '^[0-9a-f]{64}$'),
 execution_id uuid NOT NULL REFERENCES public.copy_executions(id) ON DELETE RESTRICT,
 user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,worker_fence bigint NOT NULL CHECK(worker_fence>0),evidence_id text NOT NULL,
 paper_valuation_evidence_id text NOT NULL REFERENCES public.pipeline_paper_valuation_evidence(evidence_id) ON DELETE RESTRICT,
 terms jsonb NOT NULL CHECK(jsonb_typeof(terms)='object'),recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 UNIQUE(execution_id,worker_fence,evidence_id),
 CHECK((terms->>'receiptId'=receipt_id AND terms->>'executionId'=execution_id::text AND terms->>'userId'=user_id::text
 AND terms->>'workerFence'=worker_fence::text AND terms->'evidence'->>'evidenceId'=evidence_id
 AND terms->>'paperValuationEvidenceId'=paper_valuation_evidence_id
 AND receipt_id=encode(sha256(convert_to(public.swat_pipeline_canonical_json(terms-'receiptId'),'UTF8')),'hex')) IS TRUE)
);
ALTER TABLE public.pipeline_worker_paper_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pipeline_worker_paper_receipts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.pipeline_worker_paper_receipts FROM PUBLIC,swat_app;

CREATE FUNCTION public.swat_pipeline_receipt_valid(requested_execution uuid,requested_fence bigint,terms jsonb) RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE e public.copy_executions; w public.copy_execution_worker_attempts; p public.copy_execution_policy_snapshots;
 q public.pipeline_paper_valuation_evidence; a public.worker_valuation_authorities; base numeric; quote numeric; fee numeric; occurrence timestamptz; original public.copy_execution_evidence;
BEGIN
 IF jsonb_typeof(terms) IS DISTINCT FROM 'object'
 OR (terms ?& ARRAY['receiptId','executionId','userId','chain','tokenMint','targetAccount','executionMode','workerFence',
  'policyRevision','riskEpoch','paperValuationEvidenceId','paperValuationDigest','executor','evidence']) IS DISTINCT FROM true
 OR jsonb_typeof(terms->'evidence') IS DISTINCT FROM 'object'
 OR (terms->'evidence' ?& ARRAY['executionId','evidenceType','evidenceId','baseQuantity','quoteLeg','priceUsd','feeUsd',
  'confirmationState','completesExecution','occurredAt']) IS DISTINCT FROM true
 OR terms->'evidence'->>'baseQuantity' IS NULL OR terms->'evidence'->>'occurredAt' IS NULL
 OR (terms->'evidence'->'quoteLeg' IS DISTINCT FROM 'null'::jsonb AND (
  jsonb_typeof(terms->'evidence'->'quoteLeg') IS DISTINCT FROM 'object'
  OR terms->'evidence'->'quoteLeg'->>'amount' IS NULL OR terms->'evidence'->'quoteLeg'->>'currency' IS DISTINCT FROM 'USD'))
 THEN RAISE EXCEPTION 'complete exact paper receipt evidence fields required'; END IF;
 SELECT * INTO STRICT e FROM public.copy_executions WHERE id=requested_execution FOR SHARE;
 SELECT * INTO STRICT w FROM public.copy_execution_worker_attempts WHERE execution_id=e.id FOR SHARE;
 SELECT * INTO STRICT p FROM public.copy_execution_policy_snapshots WHERE execution_id=e.id FOR SHARE;
 SELECT * INTO STRICT q FROM public.pipeline_paper_valuation_evidence WHERE evidence_id=terms->>'paperValuationEvidenceId' AND execution_id=e.id FOR SHARE;
 SELECT * INTO STRICT a FROM public.worker_valuation_authorities WHERE authority_id=q.authority_id FOR SHARE;
 occurrence:=(terms->'evidence'->>'occurredAt')::timestamptz;
 IF terms->>'executionId' IS DISTINCT FROM e.id::text OR terms->>'userId' IS DISTINCT FROM e.user_id::text OR terms->>'chain' IS DISTINCT FROM e.chain
 OR terms->>'tokenMint' IS DISTINCT FROM e.token_mint OR terms->>'targetAccount' IS DISTINCT FROM e.target_account
 OR terms->>'executionMode' IS DISTINCT FROM 'paper' OR e.execution_mode IS DISTINCT FROM 'paper'
 OR w.user_id IS DISTINCT FROM e.user_id OR w.fence IS DISTINCT FROM requested_fence OR terms->>'workerFence' IS DISTINCT FROM w.fence::text
 OR terms->>'policyRevision' IS DISTINCT FROM w.policy_revision OR terms->>'policyRevision' IS DISTINCT FROM p.snapshot->>'revision'
 OR terms->>'riskEpoch' IS DISTINCT FROM w.risk_epoch::text OR terms->>'paperValuationDigest' IS DISTINCT FROM q.evidence_digest
 OR terms->>'executor' IS DISTINCT FROM 'paper-exact-simulated' OR terms->'evidence'->>'executionId' IS DISTINCT FROM e.id::text
 OR terms->'evidence'->>'evidenceType' IS DISTINCT FROM 'paper_simulation' OR terms->'evidence'->>'confirmationState' IS DISTINCT FROM 'confirmed'
 OR terms->'evidence'->'completesExecution' IS DISTINCT FROM 'true'::jsonb
 OR terms->'evidence'->>'evidenceId' IS DISTINCT FROM concat('paper:',e.client_order_id,':',q.evidence_id,':',q.terms->>'simulationModelId')
 OR NOT isfinite(occurrence) OR occurrence<(q.terms->>'observedAt')::timestamptz
 OR occurrence>=(q.terms->>'expiresAt')::timestamptz OR occurrence>clock_timestamp()
 OR NOT a.enabled OR a.user_id IS DISTINCT FROM e.user_id OR a.chain IS DISTINCT FROM e.chain OR a.provider_id IS DISTINCT FROM q.terms->>'providerId'
 OR a.identity_digest IS DISTINCT FROM q.terms->>'providerIdentity' OR a.network IS DISTINCT FROM q.terms->>'network' OR a.verifier_version IS DISTINCT FROM q.terms->>'verifierVersion'
 OR q.evidence_digest IS DISTINCT FROM encode(sha256(convert_to(public.swat_pipeline_canonical_json(q.terms-'evidenceDigest'),'UTF8')),'hex')
 OR terms->>'receiptId' IS DISTINCT FROM encode(sha256(convert_to(public.swat_pipeline_canonical_json(terms-'receiptId'),'UTF8')),'hex')
 THEN RAISE EXCEPTION 'paper receipt immutable execution/fence/model/evidence mismatch'; END IF;
 base:=CASE WHEN e.requested_base_quantity IS NOT NULL THEN e.requested_base_quantity ELSE
 div(e.requested_quote_quantity*power(10::numeric,(q.terms->>'baseDecimals')::integer),(q.terms->>'priceUsd')::numeric)/power(10::numeric,(q.terms->>'baseDecimals')::integer) END;
 quote:=base*(q.terms->>'priceUsd')::numeric;
 fee:=(q.terms->>'simulatedFixedFeeUsd')::numeric+quote*(q.terms->>'simulatedFeeBps')::numeric/10000;
 IF base<=0 OR base*power(10::numeric,(q.terms->>'baseDecimals')::integer) IS DISTINCT FROM trunc(base*power(10::numeric,(q.terms->>'baseDecimals')::integer))
 OR (terms->'evidence'->>'baseQuantity')::numeric IS DISTINCT FROM base
 OR (e.direction='buy' AND quote>e.requested_quote_quantity) THEN RAISE EXCEPTION 'paper receipt exact rawscale base/budget mismatch'; END IF;
 -- Legacy original unknown economics remain NULL, NEVER synthetic zeros. Such
 -- recovery requires exact already persisted original fill, not a generated quote.
 IF terms->'evidence'->'quoteLeg'='null'::jsonb OR terms->'evidence'->'priceUsd'='null'::jsonb OR terms->'evidence'->'feeUsd'='null'::jsonb THEN
  SELECT * INTO STRICT original FROM public.copy_execution_evidence WHERE execution_id=e.id AND evidence_id=terms->'evidence'->>'evidenceId' AND evidence_type='paper_simulation' FOR SHARE;
  IF original.base_quantity IS DISTINCT FROM base OR original.quote_quantity IS DISTINCT FROM (terms->'evidence'->'quoteLeg'->>'amount')::numeric
  OR original.quote_currency IS DISTINCT FROM (terms->'evidence'->'quoteLeg'->>'currency')
  OR original.quote_native_quantity IS DISTINCT FROM (terms->'evidence'->'quoteLeg'->>'amount')::numeric
  OR original.quote_native_usd_price IS DISTINCT FROM (CASE WHEN terms->'evidence'->'quoteLeg'='null'::jsonb THEN NULL::numeric ELSE 1::numeric END)
  OR original.price_usd IS DISTINCT FROM (terms->'evidence'->>'priceUsd')::numeric OR original.fee_usd IS DISTINCT FROM (terms->'evidence'->>'feeUsd')::numeric
  OR original.occurred_at IS DISTINCT FROM occurrence OR (original.confirmation_state IN('confirmed','finalized')) IS DISTINCT FROM true
  OR original.completes_execution IS DISTINCT FROM true
  OR NOT EXISTS(SELECT 1 FROM public.copy_position_applications app WHERE app.evidence_id=original.id AND app.execution_id=e.id AND app.user_id=e.user_id AND app.active)
  THEN RAISE EXCEPTION 'unknown original paper receipt economics must remain exact immutable null'; END IF;
 ELSE
  IF terms->'evidence'->'quoteLeg'->>'currency' IS DISTINCT FROM 'USD' OR (terms->'evidence'->'quoteLeg'->>'amount')::numeric IS DISTINCT FROM quote
  OR (terms->'evidence'->>'priceUsd')::numeric IS DISTINCT FROM (q.terms->>'priceUsd')::numeric OR (terms->'evidence'->>'feeUsd')::numeric IS DISTINCT FROM fee
  THEN RAISE EXCEPTION 'paper receipt exact quote/price/fee arithmetic mismatch'; END IF;
 END IF;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.swat_pipeline_receipt_valid(uuid,bigint,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.swat_pipeline_receipt_valid(uuid,bigint,jsonb) TO swat_app;

CREATE FUNCTION public.swat_pipeline_paper_receipt_guard() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP IS DISTINCT FROM 'INSERT' OR current_user IS DISTINCT FROM 'swat_worker_receipt_writer' OR session_user IS DISTINCT FROM current_user
 OR public.swat_pipeline_approved('paper-receipt',NEW.execution_id::text) IS DISTINCT FROM NEW.terms
 THEN RAISE EXCEPTION 'immutable independent worker receipt approval required'; END IF;
 PERFORM public.swat_pipeline_worker_scope(NEW.execution_id,NEW.terms);
 PERFORM public.swat_pipeline_receipt_valid(NEW.execution_id,NEW.worker_fence,NEW.terms);
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.swat_pipeline_paper_receipt_guard() FROM PUBLIC;
CREATE TRIGGER pipeline_worker_receipt_guard BEFORE INSERT OR UPDATE OR DELETE ON public.pipeline_worker_paper_receipts FOR EACH ROW EXECUTE FUNCTION public.swat_pipeline_paper_receipt_guard();
CREATE FUNCTION public.swat_pipeline_record_worker_paper_receipt(requested_execution uuid,requested_fence bigint,terms jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE old public.pipeline_worker_paper_receipts; approval record; checked_at timestamptz;
BEGIN
 IF current_user IS DISTINCT FROM 'swat_worker_receipt_writer' OR session_user IS DISTINCT FROM current_user OR public.swat_pipeline_approved('paper-receipt',requested_execution::text) IS DISTINCT FROM terms
 THEN RAISE EXCEPTION 'direct independent worker paper receipt enrollment required'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(requested_execution::text,88082));
 PERFORM public.swat_pipeline_worker_scope(requested_execution,terms);
 PERFORM public.swat_pipeline_receipt_valid(requested_execution,requested_fence,terms);
 SELECT * INTO old FROM public.pipeline_worker_paper_receipts WHERE execution_id=requested_execution AND worker_fence=requested_fence AND evidence_id=terms->'evidence'->>'evidenceId' FOR SHARE;
 -- Preserve serialization order; approval must still be exact/live after every wait.
 SELECT * INTO STRICT approval FROM public.swat_pipeline_backend_capability('paper-receipt',requested_execution::text);
 checked_at:=clock_timestamp();
 IF approval.approved_terms IS DISTINCT FROM terms OR approval.revoked_at IS NOT NULL
 OR approval.valid_from>checked_at OR approval.expires_at<=checked_at
 THEN RAISE EXCEPTION 'post-wait exact worker paper receipt approval required'; END IF;
 IF old.receipt_id IS NOT NULL THEN
  IF old.terms IS DISTINCT FROM terms THEN RAISE EXCEPTION 'paper receipt immutable replay collision'; END IF; RETURN terms;
 END IF;
 INSERT INTO public.pipeline_worker_paper_receipts(receipt_id,execution_id,user_id,worker_fence,evidence_id,paper_valuation_evidence_id,terms)
 VALUES(terms->>'receiptId',requested_execution,(terms->>'userId')::uuid,requested_fence,terms->'evidence'->>'evidenceId',terms->>'paperValuationEvidenceId',terms);
 RETURN terms;
END $$;
REVOKE ALL ON FUNCTION public.swat_pipeline_record_worker_paper_receipt(uuid,bigint,jsonb) FROM PUBLIC,swat_app;
-- Receipt role is provisioned disabled externally AFTER COMMIT. Exact required
-- function/column privileges are inventoried, not granted, by the companion;
-- missing independently reviewed ACL/RLS/lock closure remains a SOURCE blocker.
CREATE FUNCTION public.swat_pipeline_worker_paper_receipt(requested_execution uuid,requested_fence bigint,requested_evidence text) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE terms jsonb; c record;
BEGIN
 IF current_user IS DISTINCT FROM 'swat_app' OR session_user IS DISTINCT FROM current_user OR current_setting('role') IS DISTINCT FROM 'none' OR current_setting('row_security') IS DISTINCT FROM 'on' THEN RAISE EXCEPTION 'direct canonical worker required'; END IF;
 SELECT * INTO STRICT c FROM public.swat_claim_runtime_capability(requested_execution);
 SELECT r.terms INTO STRICT terms FROM public.pipeline_worker_paper_receipts r WHERE r.execution_id=requested_execution AND r.worker_fence=requested_fence AND r.evidence_id=requested_evidence AND r.user_id=c.user_id;
 PERFORM public.swat_pipeline_receipt_valid(requested_execution,requested_fence,terms);
 RETURN terms;
END $$;
REVOKE ALL ON FUNCTION public.swat_pipeline_worker_paper_receipt(uuid,bigint,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.swat_pipeline_worker_paper_receipt(uuid,bigint,text) TO swat_app;

REVOKE ALL ON FUNCTION public.swat_pipeline_registry_guard() FROM PUBLIC;
CREATE TRIGGER pipeline079_registry_guard BEFORE INSERT OR UPDATE OR DELETE ON public.worker_runtime_capabilities FOR EACH ROW EXECUTE FUNCTION public.swat_pipeline_registry_guard();
CREATE TRIGGER pipeline088_registration_guard BEFORE INSERT OR UPDATE OR DELETE ON public.pipeline_worker_registrations FOR EACH ROW EXECUTE FUNCTION public.swat_pipeline_registry_guard();

-- SOURCE BLOCKER: independently reviewed scoped caller SELECT/lock/DML policies
-- for canonical source/fanout/worker closure and all SQL080 risk/economic joins
-- are NOT replaced by broad grants here. These INVOKER routines remain denied
-- where exact prerequisites are missing. Disabled handoff installs only lookups.
-- Observer receipt/source scans likewise require an independently enrolled exact
-- read-only run/scope contract; no wildcard namespace/queue-ID policy is installed.
