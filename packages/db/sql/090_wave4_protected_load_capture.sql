-- SOURCE ONLY090 / P7. INERT, UNAPPLIED. No LOGIN, seeds, role membership,
-- shared lookup-owner expansion, SQL084, broker transfer, or runtime installation.
-- Commit as direct swat_migrator; separately reviewed DBA handoff is in
-- deploy/postgres/wave4-load-provisioning.ts. All runtime entry points start
-- inaccessible and migrator owned. public SQL001-087 source pins stay unchanged.
DO $$ BEGIN
 IF current_user<>'swat_migrator' OR session_user<>'swat_migrator'
  OR current_setting('role')<>'none' OR current_setting('row_security')<>'on'
  OR COALESCE(current_setting('app.bypass_rls',true),'off')<>'off'
  OR EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname=current_user AND
    (r.rolsuper OR r.rolbypassrls OR r.rolinherit OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication
     OR EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid)))
 THEN RAISE EXCEPTION '090 requires isolated direct migrator'; END IF;
END $$;
CREATE SCHEMA wave4_load AUTHORIZATION swat_migrator;
REVOKE ALL ON SCHEMA wave4_load FROM PUBLIC;

CREATE TABLE wave4_load.runs (
 run_id uuid PRIMARY KEY, namespace text NOT NULL UNIQUE, network text NOT NULL UNIQUE,
 backend_identity text NOT NULL CHECK(length(backend_identity) BETWEEN 1 AND 512),
 valid_from timestamptz NOT NULL, expires_at timestamptz NOT NULL, revoked_at timestamptz,
 enrolled_by name NOT NULL, enrolled_at timestamptz NOT NULL, revoked_by name,
 CHECK(isfinite(valid_from) AND isfinite(expires_at)), CHECK((revoked_at IS NULL)=(revoked_by IS NULL)),
 CHECK(namespace='wave4-load-'||run_id::text), CHECK(network='solana:wave4-'||run_id::text),
 CHECK(expires_at>valid_from), CHECK(revoked_at IS NULL OR revoked_at>=valid_from)
);
CREATE TABLE wave4_load.fixtures (
 run_id uuid NOT NULL REFERENCES wave4_load.runs(run_id) ON DELETE RESTRICT,
 fixture_id uuid NOT NULL, user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 document jsonb NOT NULL CHECK(jsonb_typeof(document)='object'),
 request_digest text NOT NULL CHECK(request_digest ~ '^[0-9a-f]{64}$'),
 request_canonical text NOT NULL, method text NOT NULL CHECK(method='POST'),
 route text NOT NULL CHECK(route IN('/v1/me/wallets','/v1/me/tokens/backfill')),
 body jsonb NOT NULL CHECK(jsonb_typeof(body)='object'),
 token_mint text NOT NULL CHECK(token_mint ~ '^solana:[1-9A-HJ-NP-Za-km-z]{32,44}$'),
 wallet_address text NOT NULL CHECK(wallet_address ~ '^solana:[1-9A-HJ-NP-Za-km-z]{32,44}$'),
 target_account text NOT NULL CHECK(target_account ~ '^solana:[1-9A-HJ-NP-Za-km-z]{32,44}$'),
 binding jsonb NOT NULL CHECK(jsonb_typeof(binding)='object'),
 PRIMARY KEY(run_id,fixture_id), UNIQUE(run_id,fixture_id,user_id,request_digest), UNIQUE(token_mint),
 CHECK((document->>'fixtureId' IS NOT DISTINCT FROM fixture_id::text AND document->>'userId' IS NOT DISTINCT FROM user_id::text
  AND document->>'requestDigest' IS NOT DISTINCT FROM request_digest AND document->'binding' IS NOT DISTINCT FROM binding
  AND document->>'tokenMint' IS NOT DISTINCT FROM token_mint AND document->>'walletAddress' IS NOT DISTINCT FROM wallet_address
  AND document->>'targetAccount' IS NOT DISTINCT FROM target_account))
);
-- Exact fixture coverage, not a wildcard namespace/boolean/adapter declaration.
-- Independently approved provider/sizing/valuation selectors are compared to
-- their CURRENT protected backing at every stage, not treated as authority here.
CREATE TABLE wave4_load.approvals (
 approval_id uuid PRIMARY KEY, run_id uuid NOT NULL, fixture_id uuid NOT NULL,
 stage text NOT NULL CHECK(stage IN('http','source','fanout','worker','observer')),
 runtime_role name NOT NULL, database_oid oid NOT NULL, server_address text NOT NULL,
 server_port integer NOT NULL CHECK(server_port BETWEEN 0 AND 65535), backend_identity text NOT NULL,
 revision text NOT NULL CHECK(length(revision) BETWEEN 1 AND 128),
 provider jsonb, sizing jsonb, valuation jsonb,
 valid_from timestamptz NOT NULL, expires_at timestamptz NOT NULL, revoked_at timestamptz,
 enrolled_by name NOT NULL, enrolled_at timestamptz NOT NULL, revoked_by name,
 CHECK(isfinite(valid_from) AND isfinite(expires_at)), CHECK((revoked_at IS NULL)=(revoked_by IS NULL)),
 FOREIGN KEY(run_id,fixture_id) REFERENCES wave4_load.fixtures(run_id,fixture_id) ON DELETE RESTRICT,
 UNIQUE(run_id,fixture_id,stage), CHECK(expires_at>valid_from),
 CHECK(revoked_at IS NULL OR revoked_at>=valid_from),
 CHECK(runtime_role=CASE stage WHEN 'http' THEN 'swat_load_http_writer' WHEN 'source' THEN 'swat_source_provider_writer'
  WHEN 'fanout' THEN 'swat_fanout' WHEN 'worker' THEN 'swat_app' ELSE 'swat_load_observer' END),
 CHECK((stage IN('source','fanout','worker'))=(provider IS NOT NULL)),
 CHECK((stage IN('fanout','worker'))=(sizing IS NOT NULL)), CHECK((stage='worker')=(valuation IS NOT NULL)),
 CHECK(provider IS NULL OR jsonb_typeof(provider)='object'),
 CHECK(sizing IS NULL OR jsonb_typeof(sizing)='object'), CHECK(valuation IS NULL OR jsonb_typeof(valuation)='object')
);
-- First immutable record: only the separately backed HTTP admission writer can
-- create it, using a currently valid real session, never a successful response DTO.
CREATE TABLE wave4_load.requests (
 attempt_id uuid PRIMARY KEY, run_id uuid NOT NULL, fixture_id uuid NOT NULL, user_id uuid NOT NULL,
 request_digest text NOT NULL, namespace text NOT NULL, network text NOT NULL, backend_identity text NOT NULL,
 method text NOT NULL, route text NOT NULL, body jsonb NOT NULL, principal_kind text NOT NULL CHECK(principal_kind='user'),
 principal_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 session_id uuid NOT NULL REFERENCES public.user_sessions(id) ON DELETE RESTRICT,
 http_approval_id uuid NOT NULL REFERENCES wave4_load.approvals(approval_id) ON DELETE RESTRICT,
 started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(run_id,fixture_id,user_id,request_digest)
  REFERENCES wave4_load.fixtures(run_id,fixture_id,user_id,request_digest) ON DELETE RESTRICT,
 CHECK(principal_user_id=user_id), UNIQUE(attempt_id,run_id,fixture_id,user_id)
);
-- Completion is another append, so the start record is never rewritten. Status
-- is transport evidence only; it can never produce admitted/replay authority.
CREATE TABLE wave4_load.responses (
 attempt_id uuid PRIMARY KEY REFERENCES wave4_load.requests(attempt_id) ON DELETE RESTRICT,
 status integer NOT NULL CHECK(status BETWEEN 100 AND 599), finished_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE wave4_load.stage_claims (
 attempt_id uuid NOT NULL REFERENCES wave4_load.requests(attempt_id) ON DELETE RESTRICT,
 stage text NOT NULL CHECK(stage IN('source','fanout','worker')),
 approval_id uuid NOT NULL REFERENCES wave4_load.approvals(approval_id) ON DELETE RESTRICT,
 claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(attempt_id,stage)
);
CREATE TABLE wave4_load.canonical (
 run_id uuid NOT NULL, fixture_id uuid NOT NULL, user_id uuid NOT NULL,
 original_attempt_id uuid NOT NULL UNIQUE REFERENCES wave4_load.requests(attempt_id) ON DELETE RESTRICT,
 source_trade_id uuid NOT NULL UNIQUE REFERENCES public.source_trades(id) ON DELETE RESTRICT,
 signal_id uuid NOT NULL UNIQUE, execution_id uuid NOT NULL UNIQUE REFERENCES public.copy_executions(id) ON DELETE RESTRICT,
 job_id text NOT NULL UNIQUE, admitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 admission_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
 PRIMARY KEY(run_id,fixture_id), UNIQUE(run_id,fixture_id,user_id,source_trade_id,signal_id,execution_id,job_id),
 FOREIGN KEY(original_attempt_id,run_id,fixture_id,user_id)
  REFERENCES wave4_load.requests(attempt_id,run_id,fixture_id,user_id) ON DELETE RESTRICT,
 FOREIGN KEY(signal_id,source_trade_id) REFERENCES public.signals(id,source_trade_id) ON DELETE RESTRICT,
 -- Delivery is created AFTER canonicalPrepare; this FK and the exact join below
 -- intentionally validate at COMMIT on the very same client/transaction.
 FOREIGN KEY(signal_id,job_id) REFERENCES public.source_fanout_deliveries(signal_id,job_id)
  ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
 CHECK(job_id='source-trade-'||signal_id::text||'-u-'||user_id::text)
);
CREATE TABLE wave4_load.outcomes (
 attempt_id uuid PRIMARY KEY, run_id uuid NOT NULL, fixture_id uuid NOT NULL, user_id uuid NOT NULL,
 outcome text NOT NULL CHECK(outcome IN('admitted','replay','refused')), reason text,
 source_trade_id uuid, signal_id uuid, execution_id uuid, job_id text,
 admitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(attempt_id,run_id,fixture_id,user_id) REFERENCES wave4_load.requests(attempt_id,run_id,fixture_id,user_id) ON DELETE RESTRICT,
 FOREIGN KEY(run_id,fixture_id,user_id,source_trade_id,signal_id,execution_id,job_id)
  REFERENCES wave4_load.canonical(run_id,fixture_id,user_id,source_trade_id,signal_id,execution_id,job_id) ON DELETE RESTRICT,
 CHECK((outcome='refused' AND length(reason) BETWEEN 1 AND 512 AND source_trade_id IS NULL AND signal_id IS NULL
   AND execution_id IS NULL AND job_id IS NULL)
  OR (outcome IN('admitted','replay') AND reason IS NULL AND source_trade_id IS NOT NULL AND signal_id IS NOT NULL
   AND execution_id IS NOT NULL AND job_id IS NOT NULL))
);
CREATE UNIQUE INDEX load_one_original ON wave4_load.outcomes(run_id,fixture_id) WHERE outcome='admitted';

CREATE FUNCTION wave4_load.guard_history() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'load capture append-only'; END IF;
 IF current_user<>'swat_load_capture_owner' THEN RAISE EXCEPTION 'protected capture writer required'; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION wave4_load.guard_approval() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 IF current_user IS DISTINCT FROM session_user OR session_user LIKE 'swat\_%' ESCAPE '\'
  OR current_setting('role') IS DISTINCT FROM 'none' OR current_setting('row_security') IS DISTINCT FROM 'on'
  OR COALESCE(current_setting('app.bypass_rls',true),'off') IS DISTINCT FROM 'off'
  OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=session_user AND rolsuper AND rolcanlogin)
  OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=session_user)
   OR roleid=(SELECT oid FROM pg_roles WHERE rolname=session_user))
 THEN RAISE EXCEPTION 'independent direct external DBA enrollment required'; END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'approval history retained'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('wave4-load-approval:'||NEW.run_id::text,0));
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(NEW)-ARRAY['revoked_at','revoked_by']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['revoked_at','revoked_by'])
   OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL OR NOT isfinite(NEW.revoked_at)
   OR NEW.revoked_at<OLD.enrolled_at THEN RAISE EXCEPTION 'one-way approval revocation only'; END IF;
  NEW.revoked_by:=session_user;
 ELSE
  IF NEW.revoked_at IS NOT NULL OR NEW.revoked_by IS NOT NULL OR NEW.valid_from>clock_timestamp()
   OR NEW.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'fresh nonrevoked enrollment required'; END IF;
  NEW.enrolled_by:=session_user; NEW.enrolled_at:=clock_timestamp();
  IF TG_TABLE_NAME='approvals' AND (NEW.database_oid IS DISTINCT FROM (SELECT oid FROM pg_database WHERE datname=current_database())
   OR NEW.server_address IS DISTINCT FROM COALESCE(inet_server_addr()::text,'unix')
   OR NEW.server_port IS DISTINCT FROM COALESCE(inet_server_port(),0)
   OR NEW.backend_identity IS DISTINCT FROM concat(current_database(),'|',NEW.server_address,'|',NEW.server_port,'|',NEW.runtime_role))
  THEN RAISE EXCEPTION 'independent exact backend enrollment required'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION wave4_load.guard_fixture() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE r wave4_load.runs; j jsonb;
BEGIN
 IF TG_OP<>'INSERT' OR current_user IS DISTINCT FROM session_user OR session_user LIKE 'swat\_%' ESCAPE '\'
  OR current_setting('role') IS DISTINCT FROM 'none' OR current_setting('row_security') IS DISTINCT FROM 'on'
  OR COALESCE(current_setting('app.bypass_rls',true),'off') IS DISTINCT FROM 'off'
  OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=session_user AND rolsuper AND rolcanlogin)
 THEN RAISE EXCEPTION 'independent immutable fixture enrollment required'; END IF;
 SELECT * INTO STRICT r FROM wave4_load.runs WHERE run_id=NEW.run_id;
 j:=NEW.request_canonical::jsonb;
 IF NEW.request_digest<>encode(sha256(convert_to(NEW.request_canonical,'UTF8')),'hex')
  OR j IS DISTINCT FROM jsonb_build_object('runId',r.run_id,'namespace',r.namespace,'fixtureId',NEW.fixture_id,
   'userId',NEW.user_id,'method',NEW.method,'route',NEW.route,'body',NEW.body)
  OR NEW.document->'scope' IS DISTINCT FROM jsonb_build_object('runId',r.run_id,'namespace',r.namespace,
    'network',r.network,'backendIdentity',r.backend_identity)
  OR NEW.binding->>'network' IS DISTINCT FROM r.network OR NEW.binding->>'chain' IS DISTINCT FROM 'solana'
  OR NEW.binding->>'sourceEventId' IS DISTINCT FROM r.namespace||'/'||NEW.fixture_id::text
  OR NEW.binding->>'transactionHash' IS DISTINCT FROM r.namespace||'/'||NEW.fixture_id::text
  OR NEW.binding->>'sourceEventType' IS DISTINCT FROM 'transaction' OR NEW.binding->>'sourceEventIndex' IS DISTINCT FROM '0'
  OR NEW.binding->>'walletAddress' IS DISTINCT FROM NEW.wallet_address OR NEW.binding->>'tokenMint' IS DISTINCT FROM NEW.token_mint
  OR NEW.binding->>'side' IS DISTINCT FROM 'buy'
  OR (NEW.route='/v1/me/wallets' AND (NEW.document->>'kind' IS DISTINCT FROM 'wallet' OR NEW.body IS DISTINCT FROM
   jsonb_build_object('address',substr(NEW.wallet_address,8),'chain','solana')))
  OR (NEW.route='/v1/me/tokens/backfill' AND (NEW.document->>'kind' IS DISTINCT FROM 'token' OR NEW.body IS DISTINCT FROM
   jsonb_build_object('tokenMint',substr(NEW.token_mint,8),'chain','solana')))
 THEN RAISE EXCEPTION 'fixture exact namespace/request/body/binding mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER load_run_guard BEFORE INSERT OR UPDATE OR DELETE ON wave4_load.runs FOR EACH ROW EXECUTE FUNCTION wave4_load.guard_approval();
CREATE TRIGGER load_approval_guard BEFORE INSERT OR UPDATE OR DELETE ON wave4_load.approvals FOR EACH ROW EXECUTE FUNCTION wave4_load.guard_approval();
CREATE TRIGGER load_fixture_guard BEFORE INSERT OR UPDATE OR DELETE ON wave4_load.fixtures FOR EACH ROW EXECUTE FUNCTION wave4_load.guard_fixture();
CREATE TRIGGER load_request_guard BEFORE INSERT OR UPDATE OR DELETE ON wave4_load.requests FOR EACH ROW EXECUTE FUNCTION wave4_load.guard_history();
CREATE TRIGGER load_response_guard BEFORE INSERT OR UPDATE OR DELETE ON wave4_load.responses FOR EACH ROW EXECUTE FUNCTION wave4_load.guard_history();
CREATE TRIGGER load_stage_guard BEFORE INSERT OR UPDATE OR DELETE ON wave4_load.stage_claims FOR EACH ROW EXECUTE FUNCTION wave4_load.guard_history();
CREATE TRIGGER load_canonical_guard BEFORE INSERT OR UPDATE OR DELETE ON wave4_load.canonical FOR EACH ROW EXECUTE FUNCTION wave4_load.guard_history();
CREATE TRIGGER load_outcome_guard BEFORE INSERT OR UPDATE OR DELETE ON wave4_load.outcomes FOR EACH ROW EXECUTE FUNCTION wave4_load.guard_history();

-- This one isolated owner is necessary for HTTP principal/session authentication
-- and scoped independent exports. It is NOT swat_runtime_lookup and owns only the
-- fixed eleven callable/internal routines transferred by the separately committed
-- DBA handoff. No table/schema ownership, login, memberships, bypass or DML on
-- canonical public economics is allowed. Invoker guards remain migrator-owned.
CREATE FUNCTION wave4_load.approved(rid uuid,fid uuid,requested_stage text) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE a wave4_load.approvals; r wave4_load.runs; role_record record;
BEGIN
 IF rid IS NULL OR fid IS NULL OR requested_stage IS NULL OR requested_stage NOT IN('http','source','fanout','worker','observer')
  OR current_user IS DISTINCT FROM 'swat_load_capture_owner' OR current_setting('role') IS DISTINCT FROM 'none'
  OR current_setting('row_security') IS DISTINCT FROM 'on'
  OR COALESCE(current_setting('app.bypass_rls',true),'off') IS DISTINCT FROM 'off'
  OR (requested_stage<>'worker' AND (COALESCE(current_setting('app.current_user_id',true),'')<>''
   OR COALESCE(current_setting('app.worker_execution_id',true),'')<>''))
 THEN RAISE EXCEPTION 'load capture protected direct backend required'; END IF;
 FOR role_record IN SELECT * FROM pg_roles WHERE rolname IN(current_user,session_user) LOOP
  IF role_record.rolsuper OR role_record.rolbypassrls OR role_record.rolinherit OR role_record.rolcreaterole
   OR role_record.rolcreatedb OR role_record.rolreplication
   OR (role_record.rolname=current_user AND role_record.rolcanlogin)
   OR (role_record.rolname=session_user AND NOT role_record.rolcanlogin)
   OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=role_record.oid OR roleid=role_record.oid)
  THEN RAISE EXCEPTION 'load direct role drift'; END IF;
 END LOOP;
 IF (SELECT count(*) FROM pg_roles WHERE rolname IN(current_user,session_user))<>2
  OR EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname IN(current_user,session_user) AND
   (has_database_privilege(r.oid,current_database(),'CREATE') OR EXISTS(SELECT 1 FROM pg_namespace WHERE has_schema_privilege(r.oid,oid,'CREATE'))
    OR EXISTS(SELECT 1 FROM pg_class WHERE relowner=r.oid) OR EXISTS(SELECT 1 FROM pg_namespace WHERE nspowner=r.oid)
    OR EXISTS(SELECT 1 FROM pg_database WHERE datdba=r.oid)
    OR (r.rolname=session_user AND EXISTS(SELECT 1 FROM pg_proc WHERE proowner=r.oid))))
 THEN RAISE EXCEPTION 'load restricted ownership/CREATE drift'; END IF;
 -- Shared approval lock pairs with external revocation; fresh clock AFTER wait.
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('wave4-load-approval:'||rid::text,0));
 SELECT * INTO STRICT r FROM wave4_load.runs WHERE run_id=rid AND revoked_at IS NULL
  AND valid_from<=clock_timestamp() AND expires_at>clock_timestamp();
 SELECT * INTO STRICT a FROM wave4_load.approvals WHERE run_id=rid AND fixture_id=fid AND stage=requested_stage
  AND runtime_role=session_user AND revoked_at IS NULL AND valid_from<=clock_timestamp() AND expires_at>clock_timestamp()
  AND expires_at<=r.expires_at AND database_oid=(SELECT oid FROM pg_database WHERE datname=current_database())
  AND server_address=COALESCE(inet_server_addr()::text,'unix') AND server_port=COALESCE(inet_server_port(),0)
  AND backend_identity=concat(current_database(),'|',COALESCE(inet_server_addr()::text,'unix'),'|',COALESCE(inet_server_port(),0),'|',session_user);
 IF requested_stage IN('source','fanout') AND NOT EXISTS(SELECT 1 FROM public.pipeline_backend_approvals b
  WHERE b.runtime_role=session_user AND b.database_oid=a.database_oid AND b.server_address=a.server_address
   AND b.server_port=a.server_port AND b.backend_identity=a.backend_identity AND b.revoked_at IS NULL
   AND b.valid_from<=clock_timestamp() AND b.expires_at>clock_timestamp()
   AND b.purpose=CASE requested_stage WHEN 'source' THEN 'source-intake' ELSE 'fanout' END
   AND b.authority_id=CASE requested_stage WHEN 'source' THEN a.provider->>'authorityId' ELSE '' END
   AND (requested_stage='fanout' OR (b.provider_id=a.provider->>'providerId' AND b.identity_digest=a.provider->>'identityDigest'
    AND b.network=r.network AND b.chain='solana' AND b.verifier_version=a.provider->>'verifierVersion'
    AND b.provider_valid_until=(a.provider->>'validUntil')::timestamptz)))
 THEN RAISE EXCEPTION 'current independent source/fanout backend backing missing'; END IF;
 RETURN to_jsonb(a);
END $$;
CREATE FUNCTION wave4_load.http_admit(token_digest bytea,payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE f wave4_load.fixtures; r wave4_load.runs; a jsonb; uid uuid; sid uuid; existing wave4_load.requests;
BEGIN
 IF token_digest IS NULL OR octet_length(token_digest) IS DISTINCT FROM 32 OR payload IS NULL
  OR jsonb_typeof(payload) IS DISTINCT FROM 'object' OR NOT payload ?& ARRAY['attemptId','runId','fixtureId','userId',
   'namespace','network','backendIdentity','requestDigest','method','route','body']
  OR (payload-ARRAY['attemptId','runId','fixtureId','userId','namespace','network','backendIdentity','requestDigest','method','route','body'])<>'{}'::jsonb
  OR payload->>'attemptId' IS NULL OR session_user IS DISTINCT FROM 'swat_load_http_writer'
 THEN RAISE EXCEPTION 'authenticated HTTP writer required'; END IF;
 SELECT * INTO STRICT f FROM wave4_load.fixtures WHERE run_id=(payload->>'runId')::uuid AND fixture_id=(payload->>'fixtureId')::uuid;
 a:=wave4_load.approved(f.run_id,f.fixture_id,'http');
 SELECT * INTO STRICT r FROM wave4_load.runs WHERE run_id=f.run_id;
 -- Same user-first serialization and fresh locked session conditions as SQL087;
 -- no token/hash, password, auth DTO or credential is persisted/exported here.
 SELECT user_id INTO uid FROM public.user_sessions WHERE token_hash=token_digest;
 IF uid IS DISTINCT FROM f.user_id THEN RAISE EXCEPTION 'HTTP authenticated tenant mismatch'; END IF;
 PERFORM 1 FROM public.users WHERE id=uid AND status='active' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'HTTP active principal required'; END IF;
 SELECT id INTO sid FROM public.user_sessions WHERE token_hash=token_digest AND user_id=uid AND revoked_at IS NULL
  AND expires_at>clock_timestamp() AND issued_at>clock_timestamp()-interval '30 days'
  AND last_seen_at>clock_timestamp()-interval '7 days' FOR UPDATE;
 IF sid IS NULL OR payload->>'userId' IS DISTINCT FROM uid::text OR payload->>'namespace' IS DISTINCT FROM r.namespace
  OR payload->>'network' IS DISTINCT FROM r.network OR payload->>'backendIdentity' IS DISTINCT FROM r.backend_identity
  OR payload->>'requestDigest' IS DISTINCT FROM f.request_digest OR payload->>'method' IS DISTINCT FROM f.method
  OR payload->>'route' IS DISTINCT FROM f.route OR payload->'body' IS DISTINCT FROM f.body
 THEN RAISE EXCEPTION 'HTTP exact authenticated request mismatch'; END IF;
 SELECT * INTO existing FROM wave4_load.requests WHERE attempt_id=(payload->>'attemptId')::uuid;
 IF FOUND THEN RAISE EXCEPTION 'HTTP attempt identity reused; retry requires a new attempt'; END IF;
 INSERT INTO wave4_load.requests(attempt_id,run_id,fixture_id,user_id,request_digest,namespace,network,backend_identity,
  method,route,body,principal_kind,principal_user_id,session_id,http_approval_id)
 VALUES((payload->>'attemptId')::uuid,f.run_id,f.fixture_id,uid,f.request_digest,r.namespace,r.network,r.backend_identity,
  f.method,f.route,f.body,'user',uid,sid,(a->>'approval_id')::uuid) RETURNING * INTO existing;
 RETURN jsonb_build_object('attemptId',existing.attempt_id,'principal',jsonb_build_object('kind','user','userId',uid),
  'startedAt',to_char(existing.started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
END $$;
CREATE FUNCTION wave4_load.http_finish(aid uuid,http_status integer,refusal text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE q wave4_load.requests; response wave4_load.responses;
BEGIN
 IF aid IS NULL OR http_status IS NULL OR http_status NOT BETWEEN 100 AND 599
  OR (refusal IS NOT NULL AND (length(refusal) NOT BETWEEN 1 AND 512 OR refusal<>btrim(refusal)))
  OR session_user IS DISTINCT FROM 'swat_load_http_writer' THEN RAISE EXCEPTION 'HTTP transport writer required'; END IF;
 SELECT * INTO STRICT q FROM wave4_load.requests WHERE attempt_id=aid FOR UPDATE;
 PERFORM wave4_load.approved(q.run_id,q.fixture_id,'http');
 IF http_status IN(200,201) AND refusal IS NOT NULL OR http_status NOT IN(200,201) AND refusal IS NULL
 THEN RAISE EXCEPTION 'HTTP transport/refusal mismatch'; END IF;
 IF refusal IS NOT NULL THEN
  IF EXISTS(SELECT 1 FROM wave4_load.outcomes WHERE attempt_id=aid)
   OR EXISTS(SELECT 1 FROM wave4_load.stage_claims WHERE attempt_id=aid)
   OR EXISTS(SELECT 1 FROM wave4_load.canonical WHERE original_attempt_id=aid)
  THEN RAISE EXCEPTION 'financially admitted attempt cannot become refusal'; END IF;
  -- Refusal is terminal BEFORE any source/fanout/worker authorization is issued.
  INSERT INTO wave4_load.outcomes(attempt_id,run_id,fixture_id,user_id,outcome,reason)
   VALUES(aid,q.run_id,q.fixture_id,q.user_id,'refused',refusal);
 END IF;
 INSERT INTO wave4_load.responses(attempt_id,status) VALUES(aid,http_status) RETURNING * INTO response;
 RETURN jsonb_build_object('attemptId',aid,'status',response.status,
  'finishedAt',to_char(response.finished_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
END $$;
CREATE FUNCTION wave4_load.assert_invocation(payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE q wave4_load.requests; f wave4_load.fixtures; r wave4_load.runs; response wave4_load.responses;
 a jsonb; p jsonb; stage text; original wave4_load.canonical; balance record;
BEGIN
 stage:=payload->>'stage';
 IF payload IS NULL OR jsonb_typeof(payload) IS DISTINCT FROM 'object' OR stage IS NULL
  OR stage NOT IN('source','fanout','worker') THEN RAISE EXCEPTION 'load invocation stage required'; END IF;
 SELECT * INTO STRICT q FROM wave4_load.requests WHERE attempt_id=(payload->'attempt'->>'attemptId')::uuid FOR UPDATE;
 SELECT * INTO STRICT f FROM wave4_load.fixtures WHERE run_id=q.run_id AND fixture_id=q.fixture_id;
 SELECT * INTO STRICT r FROM wave4_load.runs WHERE run_id=q.run_id;
 SELECT * INTO STRICT response FROM wave4_load.responses WHERE attempt_id=q.attempt_id AND status IN(200,201);
 a:=wave4_load.approved(q.run_id,q.fixture_id,stage); p:=a->'provider';
 IF payload->'scope' IS DISTINCT FROM f.document->'scope' OR payload->'fixture' IS DISTINCT FROM f.document
  OR payload->'principal' IS DISTINCT FROM jsonb_build_object('kind','user','userId',q.principal_user_id)
  OR payload->'attempt' IS DISTINCT FROM jsonb_build_object('attemptId',q.attempt_id,'fixtureId',q.fixture_id,'runId',q.run_id,
   'namespace',q.namespace,'userId',q.user_id,'requestDigest',q.request_digest,'route',q.route,'status',response.status,
   'startedAt',to_char(q.started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   'finishedAt',to_char(response.finished_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  OR EXISTS(SELECT 1 FROM wave4_load.outcomes WHERE attempt_id=q.attempt_id AND outcome='refused')
 THEN RAISE EXCEPTION 'persisted HTTP admission/invocation mismatch'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.source_provider_authorities provider WHERE provider.authority_id=p->>'authorityId'
  AND provider.provider_id=p->>'providerId' AND provider.identity_digest=p->>'identityDigest'
  AND provider.verifier_version=p->>'verifierVersion' AND provider.chain='solana' AND provider.network=r.network
  AND provider.enabled AND provider.valid_until>clock_timestamp()
  AND provider.valid_until=(p->>'validUntil')::timestamptz)
 THEN RAISE EXCEPTION 'current independent source provider backing missing/revoked'; END IF;
 IF stage IN('fanout','worker') THEN
  -- Read exact backing directly under this distinct owner's asset-scoped RLS.
  -- Do not expand/call the SQL079 lookup broker or use SQL048 numeric caches.
  SELECT e.*,authority.provider_id,authority.provider_identity,authority.valid_until AS provider_valid_until
   INTO STRICT balance FROM public.pipeline_exact_follower_evidence e
   JOIN public.pipeline_follower_authorities authority ON authority.authority_id=e.authority_id
   WHERE e.user_id=q.user_id AND e.chain='solana' AND e.target_account=f.target_account AND e.token_mint=f.token_mint
    AND e.execution_mode='paper' AND e.authority_id=a->'sizing'->>'authorityId'
    AND e.observed_at=(SELECT max(newer.observed_at) FROM public.pipeline_exact_follower_evidence newer
     WHERE newer.user_id=e.user_id AND newer.chain=e.chain AND newer.target_account=e.target_account
      AND newer.token_mint=e.token_mint AND newer.execution_mode=e.execution_mode)
    AND authority.enabled IS TRUE AND authority.revoked_at IS NULL;
  IF balance.authority_id IS DISTINCT FROM a->'sizing'->>'authorityId'
   OR balance.provider_id IS DISTINCT FROM a->'sizing'->>'providerId'
   OR balance.provider_identity IS DISTINCT FROM a->'sizing'->>'providerIdentity'
   OR balance.network IS DISTINCT FROM r.network OR balance.enabled IS DISTINCT FROM true OR balance.revoked_at IS NOT NULL
   OR balance.observed_at>clock_timestamp() OR balance.observed_at<clock_timestamp()-interval '60 seconds'
   OR balance.expires_at<=clock_timestamp() OR balance.provider_valid_until<=clock_timestamp()
   OR balance.expires_at>balance.provider_valid_until
   OR balance.available_usd::numeric IS DISTINCT FROM balance.raw_available_usd::numeric/power(10::numeric,balance.usd_scale)
   OR balance.evidence_digest IS DISTINCT FROM encode(sha256(convert_to(balance.evidence_canonical,'UTF8')),'hex')
   OR balance.evidence_canonical::jsonb IS DISTINCT FROM jsonb_build_object('authorityId',balance.authority_id,
    'providerId',balance.provider_id,'providerIdentity',balance.provider_identity,'evidenceId',balance.evidence_id,
    'userId',q.user_id,'chain','solana','network',r.network,'targetAccount',f.target_account,'tokenMint',f.token_mint,
    'executionMode','paper','rawAvailableUsd',balance.raw_available_usd,'usdScale',balance.usd_scale,'availableUsd',balance.available_usd,
    'observedAt',to_char(balance.observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'expiresAt',to_char(balance.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  THEN RAISE EXCEPTION 'current protected follower sizing unavailable'; END IF;
 END IF;
 IF stage='worker' THEN
  SELECT * INTO STRICT original FROM wave4_load.canonical WHERE run_id=q.run_id AND fixture_id=q.fixture_id;
  IF NOT EXISTS(SELECT 1 FROM public.worker_runtime_capabilities capability
   JOIN public.copy_executions execution ON execution.id=capability.execution_id
   JOIN public.source_fanout_deliveries delivery ON delivery.execution_id=execution.id
    AND delivery.signal_id=execution.signal_id AND delivery.user_id=execution.user_id AND delivery.job_id=original.job_id
   JOIN public.copy_execution_policy_snapshots policy ON policy.execution_id=execution.id
    AND policy.user_id=execution.user_id AND policy.target_account=execution.target_account
    AND policy.token_mint=execution.token_mint AND policy.execution_mode=execution.execution_mode
   WHERE execution.id=original.execution_id AND execution.user_id=q.user_id AND execution.chain='solana'
    AND execution.token_mint=f.token_mint AND execution.target_account=f.target_account AND execution.execution_mode='paper'
    AND capability.runtime_role=session_user AND capability.revoked_at IS NULL AND capability.valid_from<=clock_timestamp()
    AND capability.expires_at>clock_timestamp() AND capability.database_oid=(a->>'database_oid')::oid
    AND capability.server_address=a->>'server_address' AND capability.server_port=(a->>'server_port')::integer
    AND capability.backend_identity=a->>'backend_identity' AND capability.backend_identity=r.backend_identity
    AND COALESCE(current_setting('app.current_user_id',true),'')=q.user_id::text
    AND COALESCE(current_setting('app.worker_execution_id',true),'')=execution.id::text)
  OR NOT EXISTS(SELECT 1 FROM public.worker_valuation_authorities valuation
   WHERE valuation.authority_id=a->'valuation'->>'authorityId' AND valuation.provider_id=a->'valuation'->>'providerId'
    AND valuation.identity_digest=a->'valuation'->>'identityDigest' AND valuation.verifier_version=a->'valuation'->>'verifierVersion'
    AND valuation.user_id=q.user_id AND valuation.chain='solana' AND valuation.network=r.network
    AND valuation.enabled AND valuation.valid_until>clock_timestamp())
  THEN RAISE EXCEPTION 'current protected paper worker capability/valuation unavailable'; END IF;
 END IF;
 INSERT INTO wave4_load.stage_claims(attempt_id,stage,approval_id) VALUES(q.attempt_id,stage,(a->>'approval_id')::uuid)
  ON CONFLICT(attempt_id,stage) DO NOTHING;
 RETURN jsonb_build_object('scope',f.document->'scope','fixtureId',q.fixture_id,'attemptId',q.attempt_id,
  'userId',q.user_id,'stage',stage,'approval',a);
END $$;
CREATE FUNCTION wave4_load.bind_canonical(payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE q wave4_load.requests; f wave4_load.fixtures; c wave4_load.canonical; o wave4_load.outcomes; kind text;
BEGIN
 IF payload IS NULL OR jsonb_typeof(payload) IS DISTINCT FROM 'object'
  OR NOT payload ?& ARRAY['scope','fixtureId','attemptId','userId','sourceTradeId','signalId','executionId','jobId']
  OR payload->>'sourceTradeId' IS NULL OR payload->>'signalId' IS NULL OR payload->>'executionId' IS NULL OR payload->>'jobId' IS NULL
  OR session_user IS DISTINCT FROM 'swat_fanout' THEN RAISE EXCEPTION 'owned fanout transaction required'; END IF;
 SELECT * INTO STRICT q FROM wave4_load.requests WHERE attempt_id=(payload->>'attemptId')::uuid FOR UPDATE;
 SELECT * INTO STRICT f FROM wave4_load.fixtures WHERE run_id=q.run_id AND fixture_id=q.fixture_id;
 PERFORM wave4_load.approved(q.run_id,q.fixture_id,'fanout');
 IF payload->'scope' IS DISTINCT FROM f.document->'scope' OR payload->>'fixtureId' IS DISTINCT FROM q.fixture_id::text
  OR payload->>'userId' IS DISTINCT FROM q.user_id::text
  OR NOT EXISTS(SELECT 1 FROM wave4_load.responses WHERE attempt_id=q.attempt_id AND status IN(200,201))
  OR NOT EXISTS(SELECT 1 FROM wave4_load.stage_claims WHERE attempt_id=q.attempt_id AND stage='fanout')
  OR EXISTS(SELECT 1 FROM wave4_load.outcomes WHERE attempt_id=q.attempt_id AND outcome='refused')
 THEN RAISE EXCEPTION 'protected canonical HTTP join refused'; END IF;
 -- Serialize fixture races, not merely attempt races. Advisory key is namespace
 -- separated from production claim locks; uniqueness is the final DB arbiter.
 PERFORM pg_advisory_xact_lock(hashtextextended('wave4-load-canonical:'||q.run_id::text||':'||q.fixture_id::text,0));
 PERFORM wave4_load.approved(q.run_id,q.fixture_id,'fanout');
 SELECT * INTO c FROM wave4_load.canonical WHERE run_id=q.run_id AND fixture_id=q.fixture_id;
 IF NOT FOUND THEN
  INSERT INTO wave4_load.canonical(run_id,fixture_id,user_id,original_attempt_id,source_trade_id,signal_id,execution_id,job_id)
   VALUES(q.run_id,q.fixture_id,q.user_id,q.attempt_id,(payload->>'sourceTradeId')::uuid,(payload->>'signalId')::uuid,
    (payload->>'executionId')::uuid,payload->>'jobId') RETURNING * INTO c;
  kind:='admitted';
 ELSE
  IF c.source_trade_id::text IS DISTINCT FROM payload->>'sourceTradeId' OR c.signal_id::text IS DISTINCT FROM payload->>'signalId'
   OR c.execution_id::text IS DISTINCT FROM payload->>'executionId' OR c.job_id IS DISTINCT FROM payload->>'jobId'
  THEN RAISE EXCEPTION 'replay changed original canonical obligation'; END IF;
  IF c.original_attempt_id=q.attempt_id THEN kind:='admitted'; ELSE
   kind:='replay';
   PERFORM wave4_load.validate_canonical(q.run_id,q.fixture_id,false);
   -- Replay must read the ORIGINAL PERSISTED delivery, not regenerate a DTO.
   IF NOT EXISTS(SELECT 1 FROM public.source_fanout_deliveries WHERE signal_id=c.signal_id AND job_id=c.job_id
    AND execution_id=c.execution_id AND user_id=c.user_id AND execution_mode='paper' AND target_account=f.target_account)
   THEN RAISE EXCEPTION 'replay original persisted delivery missing'; END IF;
  END IF;
 END IF;
 SELECT * INTO o FROM wave4_load.outcomes WHERE attempt_id=q.attempt_id;
 IF FOUND THEN
  IF o.outcome<>kind OR o.execution_id IS DISTINCT FROM c.execution_id OR o.source_trade_id IS DISTINCT FROM c.source_trade_id
   OR o.signal_id IS DISTINCT FROM c.signal_id OR o.job_id IS DISTINCT FROM c.job_id
  THEN RAISE EXCEPTION 'immutable attempt outcome changed'; END IF;
 ELSE
  INSERT INTO wave4_load.outcomes(attempt_id,run_id,fixture_id,user_id,outcome,source_trade_id,signal_id,execution_id,job_id)
   VALUES(q.attempt_id,q.run_id,q.fixture_id,q.user_id,kind,c.source_trade_id,c.signal_id,c.execution_id,c.job_id) RETURNING * INTO o;
 END IF;
 RETURN to_jsonb(o);
END $$;
CREATE FUNCTION wave4_load.check_canonical_commit() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 -- No runtime table grant: protected validator owns the read and xid check.
 PERFORM wave4_load.validate_canonical(NEW.run_id,NEW.fixture_id,true);
 RETURN NULL;
END $$;
CREATE FUNCTION wave4_load.validate_canonical(rid uuid,fid uuid,require_original_xid boolean) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c wave4_load.canonical; f wave4_load.fixtures; a jsonb;
BEGIN
 a:=wave4_load.approved(rid,fid,'fanout');
 SELECT * INTO STRICT c FROM wave4_load.canonical WHERE run_id=rid AND fixture_id=fid;
 SELECT * INTO STRICT f FROM wave4_load.fixtures WHERE run_id=rid AND fixture_id=fid;
 IF require_original_xid IS NULL OR (require_original_xid AND c.admission_xid IS DISTINCT FROM pg_current_xact_id())
 THEN RAISE EXCEPTION 'original correlation must commit with obligation'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.copy_executions e
  JOIN public.signals signal ON signal.id=e.signal_id AND signal.source_trade_id=e.source_trade_id
  JOIN public.source_trades source ON source.id=e.source_trade_id
  JOIN public.source_verification_bindings binding ON binding.source_trade_id=source.id
  JOIN public.source_verification_heads head ON head.source_trade_id=source.id
  JOIN public.source_verified_evidence proof ON proof.evidence_id=head.evidence_id AND proof.source_trade_id=source.id
  JOIN public.source_provider_authorities provider ON provider.authority_id=proof.authority_id
  JOIN public.source_position_applications application ON application.source_trade_id=source.id
  JOIN public.copy_execution_policy_snapshots policy ON policy.execution_id=e.id AND policy.user_id=e.user_id
  JOIN public.source_fanout_batches batch ON batch.signal_id=e.signal_id AND batch.source_trade_id=source.id AND batch.state='complete'
  JOIN public.source_fanout_deliveries d ON d.signal_id=e.signal_id AND d.execution_id=e.id AND d.user_id=e.user_id
  WHERE e.id=c.execution_id AND e.user_id=c.user_id AND e.signal_id=c.signal_id AND source.id=c.source_trade_id
   AND e.chain='solana' AND e.token_mint=f.token_mint AND e.target_account=f.target_account AND e.execution_mode='paper'
   AND e.direction='buy' AND e.requested_base_quantity IS NULL AND e.requested_quote_quantity>0
   AND e.requested_quote_quantity=(f.document->'quoteBudget'->>'raw')::numeric/power(10::numeric,(f.document->'quoteBudget'->>'scale')::integer)
   AND e.exit_lot_id IS NULL AND e.exit_trigger IS NULL
   AND (NOT require_original_xid OR (e.xmin::text::numeric=mod(pg_current_xact_id()::text::numeric,4294967296)
    AND d.xmin::text::numeric=mod(pg_current_xact_id()::text::numeric,4294967296)
    AND policy.xmin::text::numeric=mod(pg_current_xact_id()::text::numeric,4294967296)))
   AND source.source_event_id=f.binding->>'sourceEventId' AND source.wallet_address=f.wallet_address
   AND source.chain=e.chain AND source.token_mint=e.token_mint AND source.direction=e.direction
   AND binding.binding=f.binding AND binding.network=f.document->'scope'->>'network'
   AND source.confirmation_state IN('confirmed','finalized') AND head.confirmation_state=source.confirmation_state
   AND proof.binding_digest=binding.binding_digest AND proof.finality=head.confirmation_state
   AND provider.enabled AND provider.authority_id=a->'provider'->>'authorityId' AND provider.provider_id=proof.provider_id
   AND provider.identity_digest=proof.provider_identity_digest AND provider.network=binding.network
   AND provider.verifier_version=proof.verifier_version AND provider.valid_until>clock_timestamp() AND proof.provider_valid_until>clock_timestamp()
   AND application.active AND application.wallet_address=f.wallet_address AND application.token_mint=f.token_mint
   AND application.chain='solana' AND policy.target_account=e.target_account AND policy.chain=e.chain
   AND policy.token_mint=e.token_mint AND policy.execution_mode=e.execution_mode AND policy.master_wallet_address=f.wallet_address
   AND d.job_id=c.job_id AND d.execution_mode=e.execution_mode AND d.target_account=e.target_account
   AND d.descriptor->'data'->>'copyExecutionId'=e.id::text AND d.descriptor->'data'->>'signalId'=e.signal_id::text
   AND d.descriptor->'data'->>'sourceTradeId'=source.id::text AND d.descriptor->'data'->>'userId'=e.user_id::text
   AND d.descriptor->'data'->>'tokenMint'=e.token_mint AND d.descriptor->'data'->>'targetAccount'=e.target_account
   AND d.descriptor->'data'->'requestedBaseQuantity' IS NOT DISTINCT FROM 'null'::jsonb
   AND d.descriptor->'data'->'exitLotId' IS NOT DISTINCT FROM 'null'::jsonb
   AND d.descriptor->>'chain'='solana' AND d.descriptor->'data'->>'chain'='solana'
   AND (d.descriptor->'data'->>'requestedQuoteQuantity')::numeric=e.requested_quote_quantity
   AND d.descriptor->'data'->>'executionMode'='paper' AND d.descriptor->'data'->>'direction'='buy'
   AND d.descriptor->'data'->>'masterWalletAddress'=f.wallet_address AND d.descriptor->'options'->>'jobId'=c.job_id)
 THEN RAISE EXCEPTION 'same-transaction original canonical source/policy/delivery not backed'; END IF;
 IF NOT EXISTS(SELECT 1 FROM wave4_load.outcomes WHERE attempt_id=c.original_attempt_id AND outcome='admitted')
 THEN RAISE EXCEPTION 'original financial outcome missing at COMMIT'; END IF;
END $$;
CREATE CONSTRAINT TRIGGER load_canonical_commit AFTER INSERT ON wave4_load.canonical
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION wave4_load.check_canonical_commit();

-- Read API captures EVERY enrolled attempt, including unfinished or outcome-less
-- attempts; the adapter refuses complete accounting until both are present.
CREATE FUNCTION wave4_load.export_capture(rid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE f record; r wave4_load.runs; result jsonb;
BEGIN
 IF session_user<>'swat_load_observer' OR current_setting('transaction_read_only')<>'on'
  OR current_setting('transaction_isolation')<>'repeatable read'
 THEN RAISE EXCEPTION 'independent read-only repeatable-read observer required'; END IF;
 SELECT * INTO STRICT r FROM wave4_load.runs WHERE run_id=rid;
 IF NOT EXISTS(SELECT 1 FROM wave4_load.fixtures WHERE run_id=rid)
 THEN RAISE EXCEPTION 'nonempty independently enrolled observer coverage required'; END IF;
 FOR f IN SELECT fixture_id FROM wave4_load.fixtures WHERE run_id=rid LOOP
  PERFORM wave4_load.approved(rid,f.fixture_id,'observer');
 END LOOP;
 RETURN jsonb_build_object('scope',jsonb_build_object('runId',r.run_id,'namespace',r.namespace,'network',r.network,'backendIdentity',r.backend_identity),
  'fixtures',COALESCE((SELECT jsonb_agg(document ORDER BY fixture_id) FROM wave4_load.fixtures WHERE run_id=rid),'[]'::jsonb),
  'requests',COALESCE((SELECT jsonb_agg(to_jsonb(q)-'session_id' ORDER BY q.started_at,q.attempt_id) FROM wave4_load.requests q WHERE run_id=rid),'[]'::jsonb),
  'responses',COALESCE((SELECT jsonb_agg(to_jsonb(response) ORDER BY q.started_at,q.attempt_id) FROM wave4_load.requests q
   JOIN wave4_load.responses response USING(attempt_id) WHERE q.run_id=rid),'[]'::jsonb),
  'outcomes',COALESCE((SELECT jsonb_agg(to_jsonb(outcome) ORDER BY q.started_at,q.attempt_id) FROM wave4_load.requests q
   JOIN wave4_load.outcomes outcome USING(attempt_id) WHERE q.run_id=rid),'[]'::jsonb));
END $$;
-- Exact private read scope. These invoker predicates are owner-only and are
-- called by the separate DBA's owner-specific policies, never granted to readers.
CREATE FUNCTION wave4_load.visible_capture(rid uuid,fid uuid) RETURNS boolean LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT current_user='swat_load_capture_owner' AND current_setting('role')='none'
  AND current_setting('row_security')='on' AND COALESCE(current_setting('app.bypass_rls',true),'off')='off'
  AND EXISTS(SELECT 1 FROM wave4_load.runs r JOIN wave4_load.approvals a ON a.run_id=r.run_id
   WHERE r.run_id=rid AND a.fixture_id=fid AND r.revoked_at IS NULL AND r.valid_from<=clock_timestamp() AND r.expires_at>clock_timestamp()
    AND a.runtime_role=session_user AND a.revoked_at IS NULL AND a.valid_from<=clock_timestamp() AND a.expires_at>clock_timestamp()
    AND a.expires_at<=r.expires_at AND a.database_oid=(SELECT oid FROM pg_database WHERE datname=current_database())
    AND a.server_address=COALESCE(inet_server_addr()::text,'unix') AND a.server_port=COALESCE(inet_server_port(),0)
    AND a.backend_identity=concat(current_database(),'|',a.server_address,'|',a.server_port,'|',session_user))
$$;
CREATE FUNCTION wave4_load.visible_user(uid uuid) RETURNS boolean LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT current_user='swat_load_capture_owner' AND session_user='swat_load_http_writer'
  AND EXISTS(SELECT 1 FROM wave4_load.fixtures f WHERE f.user_id=uid AND wave4_load.visible_capture(f.run_id,f.fixture_id))
$$;
-- Fixed scoped predicate for the NEW owner policies only. No observer table
-- privilege and no global tenant grant; session/backend + enrolled exact assets.
CREATE FUNCTION wave4_load.visible_asset(mint text) RETURNS boolean LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT current_user='swat_load_capture_owner' AND EXISTS(SELECT 1 FROM wave4_load.fixtures f
  JOIN wave4_load.runs r ON r.run_id=f.run_id JOIN wave4_load.approvals a ON a.run_id=f.run_id AND a.fixture_id=f.fixture_id
  WHERE f.token_mint=mint AND r.revoked_at IS NULL AND r.valid_from<=CURRENT_TIMESTAMP AND r.expires_at>CURRENT_TIMESTAMP
   AND a.runtime_role=session_user AND a.stage IN('source','fanout','worker','observer') AND a.revoked_at IS NULL
   AND a.valid_from<=clock_timestamp() AND a.expires_at>clock_timestamp() AND a.expires_at<=r.expires_at
   AND current_setting('role')='none' AND current_setting('row_security')='on'
   AND COALESCE(current_setting('app.bypass_rls',true),'off')='off'
   AND a.database_oid=(SELECT oid FROM pg_database WHERE datname=current_database())
   AND a.server_address=COALESCE(inet_server_addr()::text,'unix') AND a.server_port=COALESCE(inet_server_port(),0)
   AND a.backend_identity=concat(current_database(),'|',COALESCE(inet_server_addr()::text,'unix'),'|',COALESCE(inet_server_port(),0),'|',session_user))
$$;
-- Economics export is fixed, scoped to every enrolled token and namespace, and
-- includes orphan/additional rows rather than selecting only supplied ids. Actual
-- SQL071/074/077/079/080 relations only; no callback-derived receipt/financial rows.
CREATE FUNCTION wave4_load.export_economics(rid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE capture jsonb; tokens text[]; source_ids uuid[]; ids uuid[]; lot_ids uuid[]; result jsonb;
BEGIN
 capture:=wave4_load.export_capture(rid);
 SELECT array_agg(token_mint) INTO tokens FROM wave4_load.fixtures WHERE run_id=rid;
 SELECT array_agg(id) INTO source_ids FROM public.source_trades WHERE token_mint=ANY(tokens)
  OR source_event_id LIKE (capture->'scope'->>'namespace')||'/%';
 SELECT array_agg(id) INTO ids FROM public.copy_executions WHERE token_mint=ANY(tokens) OR source_trade_id=ANY(source_ids);
 SELECT array_agg(id) INTO lot_ids FROM public.copy_position_master_lots WHERE token_mint=ANY(tokens);
 result:=jsonb_build_object('scope',capture->'scope');
 result:=result||jsonb_build_object('sources',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',s.id,'binding',b.binding,
  'bindingDigest',b.binding_digest,'evidenceId',h.evidence_id,'finality',h.confirmation_state,'applicationActive',app.active,
  'accepted',s.confirmation_state IN('confirmed','finalized') AND h.confirmation_state=s.confirmation_state
   AND proof.source_trade_id=s.id AND proof.binding_digest=b.binding_digest AND proof.finality=h.confirmation_state
   AND authority.enabled AND authority.provider_id=proof.provider_id AND authority.identity_digest=proof.provider_identity_digest
   AND authority.network=b.network AND authority.chain=s.chain AND authority.verifier_version=proof.verifier_version
   AND authority.valid_until>CURRENT_TIMESTAMP AND proof.provider_valid_until>CURRENT_TIMESTAMP AND app.active) ORDER BY s.id)
  FROM public.source_trades s LEFT JOIN public.source_verification_bindings b ON b.source_trade_id=s.id
  LEFT JOIN public.source_verification_heads h ON h.source_trade_id=s.id LEFT JOIN public.source_verified_evidence proof ON proof.evidence_id=h.evidence_id
  LEFT JOIN public.source_provider_authorities authority ON authority.authority_id=proof.authority_id
  LEFT JOIN public.source_position_applications app ON app.source_trade_id=s.id WHERE s.id=ANY(source_ids)),'[]'::jsonb));
 result:=result||jsonb_build_object('executions',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'signalId',signal_id,
  'sourceTradeId',source_trade_id,'userId',user_id,'targetAccount',target_account,'chain',chain,'tokenMint',token_mint,
  'direction',direction,'executionMode',execution_mode,'state',state,'requestedBase',requested_base_quantity::text,
  'requestedQuote',requested_quote_quantity::text,'confirmedBase',confirmed_base_quantity::text,
  'confirmedQuote',confirmed_quote_quantity::text,'quoteUnknown',quote_unassessed_fill_count::text) ORDER BY id)
  FROM public.copy_executions WHERE id=ANY(ids)),'[]'::jsonb));
 result:=result||jsonb_build_object('deliveries',COALESCE((SELECT jsonb_agg(jsonb_build_object('executionId',execution_id,
  'signalId',signal_id,'userId',user_id,'targetAccount',target_account,'executionMode',execution_mode,'jobId',job_id,
  'state',state,'fence',fence::text,'descriptor',descriptor) ORDER BY job_id) FROM public.source_fanout_deliveries
  WHERE execution_id=ANY(ids) OR descriptor->'data'->>'tokenMint'=ANY(tokens)),'[]'::jsonb));
 result:=result||jsonb_build_object('workerAttempts',COALESCE((SELECT jsonb_agg(jsonb_build_object('executionId',execution_id,
  'userId',user_id,'fence',fence::text,'policyRevision',policy_revision,'riskEpoch',risk_epoch::text,'state',state) ORDER BY execution_id)
  FROM public.copy_execution_worker_attempts WHERE execution_id=ANY(ids)),'[]'::jsonb));
 result:=result||jsonb_build_object('evidence',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',f.id,'executionId',f.execution_id,
  'userId',e.user_id,'sourceTradeId',e.source_trade_id,'evidenceId',f.evidence_id,'evidenceType',f.evidence_type,
  'confirmationState',f.confirmation_state,'completes',f.completes_execution,'base',f.base_quantity::text,'quote',f.quote_quantity::text,
  'fee',f.fee_usd::text,'quoteCurrency',f.quote_currency,'nativeQuote',f.quote_native_quantity::text,'nativePrice',f.quote_native_usd_price::text,
  'effectiveQuote',f.effective_quote_usd::text,'effectiveFee',f.effective_fee_usd::text,'correctionId',f.valuation_correction_id,
  'applicationActive',app.active) ORDER BY f.id) FROM public.worker_effective_execution_evidence f
  JOIN public.copy_executions e ON e.id=f.execution_id LEFT JOIN public.copy_position_applications app ON app.evidence_id=f.id
  WHERE f.execution_id=ANY(ids)),'[]'::jsonb));
 result:=result||jsonb_build_object('trades',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'executionId',copy_execution_id,
  'userId',user_id,'signalId',signal_id,'sourceTradeId',source_trade_id,'tokenMint',token_mint,'chain',chain,'direction',direction,
  'executionMode',execution_mode,'base',token_amount::text,'quote',amount_usd::text,'fee',fee_usd::text,'status',status) ORDER BY id)
  FROM public.trades WHERE copy_execution_id=ANY(ids) OR token_mint=ANY(tokens)),'[]'::jsonb));
 result:=result||jsonb_build_object('receipts',COALESCE((SELECT jsonb_agg(jsonb_build_object('receiptId',receipt_id,'snapshot',snapshot) ORDER BY receipt_id)
  FROM public.copy_execution_financial_receipts WHERE execution_id=ANY(ids)),'[]'::jsonb));
 result:=result||jsonb_build_object('applications',COALESCE((SELECT jsonb_agg(jsonb_build_object('evidenceId',evidence_id,'executionId',execution_id,
  'positionId',position_id,'userId',user_id,'targetAccount',target_account,'tokenMint',token_mint,'chain',chain,'active',active) ORDER BY evidence_id)
  FROM public.copy_position_applications WHERE execution_id=ANY(ids) OR token_mint=ANY(tokens)),'[]'::jsonb));
 result:=result||jsonb_build_object('positions',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'userId',user_id,'targetAccount',target_account,
  'tokenMint',token_mint,'chain',chain,'base',confirmed_quantity::text,'basis',cost_basis_usd::text) ORDER BY id)
  FROM public.copy_positions WHERE token_mint=ANY(tokens)),'[]'::jsonb));
 result:=result||jsonb_build_object('lots',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',lot.id,'positionId',lot.position_id,'userId',lot.user_id,
  'tokenMint',lot.token_mint,'chain',lot.chain,'masterWalletAddress',lot.master_wallet_address,'acquisitionExecutionId',lot.acquisition_execution_id,
  'acquisitionEvidenceId',lot.acquisition_evidence_id,'acquisitionSourceTradeId',lot.source_trade_id,'acquisitionMode',e.execution_mode,
  'acquiredBase',lot.acquired_quantity::text,'remainingBase',lot.remaining_quantity::text,'acquiredBasis',lot.acquired_cost_basis_usd::text,
  'remainingBasis',lot.remaining_cost_basis_usd::text) ORDER BY lot.id) FROM public.copy_position_master_lots lot
  JOIN public.copy_executions e ON e.id=lot.acquisition_execution_id WHERE lot.token_mint=ANY(tokens) OR lot.acquisition_execution_id=ANY(ids)),'[]'::jsonb));
 result:=result||jsonb_build_object('risk',COALESCE((SELECT jsonb_agg(jsonb_build_object('executionId',execution_id,'account',account,'epoch',policy_epoch::text,
  'state',state,'debit',confirmed_usd::text,'liability',liability_usd::text,'chain',chain,'executionMode',execution_mode) ORDER BY execution_id)
  FROM public.risk_spend_reservations WHERE execution_id=ANY(ids)),'[]'::jsonb));
 result:=result||jsonb_build_object('capacity',COALESCE((SELECT jsonb_agg(jsonb_build_object('sourceTradeId',source_trade_id,'executionMode',execution_mode,
  'notional',notional_usd::text,'chain',chain,'tokenMint',token_mint,'masterWalletAddress',master_wallet_address) ORDER BY source_trade_id,execution_mode)
  FROM public.master_capacity_ledger WHERE source_trade_id=ANY(source_ids) OR token_mint=ANY(tokens)),'[]'::jsonb));
 result:=result||jsonb_build_object('corrections',COALESCE((SELECT jsonb_agg(jsonb_build_object('executionId',execution_id,'correctionId',correction_id) ORDER BY correction_id)
  FROM public.copy_execution_valuation_corrections WHERE execution_id=ANY(ids)),'[]'::jsonb));
 result:=result||jsonb_build_object('reductions',COALESCE((SELECT jsonb_agg(jsonb_build_object('executionId',sell_execution_id,'evidenceId',sell_evidence_id,'lotId',lot_id) ORDER BY id)
  FROM public.copy_position_master_lot_reductions WHERE sell_execution_id=ANY(ids) OR lot_id=ANY(lot_ids)),'[]'::jsonb));
 RETURN result;
END $$;

-- Inert ACL/RLS. No runtime or migrator enrollment policy; direct external DBA
-- enrollment and exact owner-specific policies/transfers are a separate handoff.
DO $$ DECLARE t text; fn record; BEGIN
 FOREACH t IN ARRAY ARRAY['runs','fixtures','approvals','requests','responses','stage_claims','canonical','outcomes'] LOOP
  EXECUTE format('ALTER TABLE wave4_load.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE wave4_load.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON wave4_load.%I FROM PUBLIC',t);
  -- Close inherited/default ACLs, including column remnants; no role creation.
  FOR fn IN SELECT grantee,privilege_type FROM aclexplode((SELECT relacl FROM pg_class WHERE oid=to_regclass('wave4_load.'||t)))
   WHERE grantee<>(SELECT oid FROM pg_roles WHERE rolname='swat_migrator') LOOP
   EXECUTE format('REVOKE ALL ON wave4_load.%I FROM %s',t,CASE WHEN fn.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(fn.grantee)) END);
  END LOOP;
 END LOOP;
 FOR fn IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='wave4_load' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',fn.signature);
 END LOOP;
END $$;
-- Unclosed runtime gates: protected HTTP route lifecycle, SOURCE088 provider and
-- sizing backing installation/allowlist review, SOURCE089 financial integration,
-- worker capability activation, namespace enrollment, independent observer lease.
-- This proposal does not claim public routes or workers are wired/qualified.
