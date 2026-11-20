-- SOURCE ONLY087: commit INERT as direct swat_migrator. No privileged owner creation,
-- LOGIN, memberships, or owner transfer here. After the migration transaction COMMIT,
-- deploy/postgres/auth-provisioning.ts performs the separate exact direct-DBA handoff.
DO $$
DECLARE m oid; r record;
BEGIN
 IF current_user <> 'swat_migrator' OR session_user <> 'swat_migrator'
  OR current_setting('role') <> 'none' OR current_setting('row_security') <> 'on'
 THEN RAISE EXCEPTION '087 requires direct migrator'; END IF;
 SELECT oid INTO m FROM pg_roles WHERE rolname=current_user
  AND NOT (rolsuper OR rolbypassrls OR rolinherit OR rolcreaterole OR rolcreatedb OR rolreplication);
 IF m IS NULL OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=m OR roleid=m)
 THEN RAISE EXCEPTION '087 migrator role drift'; END IF;
 FOR r IN SELECT c.* FROM pg_class c WHERE c.oid IN
  ('public.users'::regclass,'public.user_sessions'::regclass,'public.user_auth_wallets'::regclass) LOOP
  IF r.relowner<>m OR NOT r.relrowsecurity OR NOT r.relforcerowsecurity OR r.relkind<>'r'
  THEN RAISE EXCEPTION '087 auth table owner/FORCE RLS drift'; END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='swat_auth_service' AND NOT rolcanlogin
  AND NOT(rolsuper OR rolbypassrls OR rolinherit OR rolcreaterole OR rolcreatedb OR rolreplication))
 THEN RAISE EXCEPTION '087 requires disabled auth service'; END IF;
END $$;

-- Pin UUID defaults to the PostgreSQL builtin; the pgcrypto public wrapper is not
-- granted to the restricted auth owner and must not become an executable dependency.
ALTER TABLE public.users ALTER COLUMN id SET DEFAULT pg_catalog.gen_random_uuid();
ALTER TABLE public.user_sessions ALTER COLUMN id SET DEFAULT pg_catalog.gen_random_uuid();
ALTER TABLE public.user_auth_wallets ALTER COLUMN id SET DEFAULT pg_catalog.gen_random_uuid();

-- Existing tenant predicates are unchanged, but no PUBLIC policy may expose auth
-- rows through forged tenant GUCs. Owner/service are excluded from the app policy.
ALTER POLICY tenant_isolation_policy ON public.users TO swat_app,swat_migrator;
ALTER POLICY tenant_isolation_policy ON public.user_sessions TO swat_app,swat_migrator;
ALTER POLICY tenant_isolation_policy ON public.user_auth_wallets TO swat_app,swat_migrator;
CREATE TABLE public.auth_wallet_proofs (
 wallet_id uuid PRIMARY KEY REFERENCES public.user_auth_wallets(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES public.users(id), chain_kind text NOT NULL,
 address text NOT NULL, verified_at timestamptz NOT NULL,
 audit_id bigint NOT NULL REFERENCES public.audit_log(id),
 UNIQUE(chain_kind,address), CHECK(chain_kind IN('evm','solana'))
);
ALTER TABLE public.auth_wallet_proofs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auth_wallet_proofs FORCE ROW LEVEL SECURITY;
CREATE POLICY auth087_proof_tenant ON public.auth_wallet_proofs FOR SELECT TO swat_app
 USING(user_id=public.current_app_user_id());
-- Owner-specific policies are installed by the external provisioner, not migrator.
REVOKE ALL ON public.auth_wallet_proofs FROM PUBLIC,swat_app,swat_auth_service;
GRANT SELECT ON public.auth_wallet_proofs TO swat_app;
ALTER POLICY tenant_isolation_policy ON public.user_auth_wallets
 USING(public.is_rls_bypassed() OR (user_id=public.current_app_user_id() AND EXISTS(
  SELECT 1 FROM public.auth_wallet_proofs p WHERE p.wallet_id=user_auth_wallets.id
   AND p.user_id=user_auth_wallets.user_id AND p.chain_kind=user_auth_wallets.chain_kind::text
   AND p.address=user_auth_wallets.address::text AND p.verified_at=user_auth_wallets.verified_at)))
 WITH CHECK(public.is_rls_bypassed());

CREATE FUNCTION public.swat_auth_guard() RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE r record;
BEGIN
 IF current_user<>'swat_auth_owner' OR session_user<>'swat_auth_service'
  OR current_setting('role')<>'none' OR current_setting('row_security')<>'on'
  OR COALESCE(current_setting('app.current_user_id',true),'')<>''
  OR COALESCE(current_setting('app.bypass_rls',true),'off')<>'off'
  OR COALESCE(current_setting('app.worker_execution_id',true),'')<>''
 THEN RAISE EXCEPTION 'protected direct authentication identity required' USING ERRCODE='42501'; END IF;
 FOR r IN SELECT * FROM pg_roles WHERE rolname IN('swat_auth_owner','swat_auth_service') LOOP
  IF r.rolsuper OR r.rolbypassrls OR r.rolinherit OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication
   OR (r.rolname='swat_auth_owner' AND r.rolcanlogin)
   OR (r.rolname='swat_auth_service' AND NOT r.rolcanlogin)
   OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid)
   OR EXISTS(SELECT 1 FROM pg_namespace WHERE nspowner=r.oid OR has_schema_privilege(r.oid,oid,'CREATE'))
   OR EXISTS(SELECT 1 FROM pg_class WHERE relowner=r.oid)
   OR EXISTS(SELECT 1 FROM pg_database WHERE datdba=r.oid)
   OR has_database_privilege(r.oid,current_database(),'CREATE')
   OR (r.rolname='swat_auth_service' AND EXISTS(SELECT 1 FROM pg_proc WHERE proowner=r.oid))
  THEN RAISE EXCEPTION 'protected authentication role drift' USING ERRCODE='42501'; END IF;
 END LOOP;
 IF (SELECT count(*) FROM pg_roles WHERE rolname IN('swat_auth_owner','swat_auth_service'))<>2
 THEN RAISE EXCEPTION 'protected authentication roles missing'; END IF;
END $$;

CREATE FUNCTION public.swat_auth_user_json(u public.users) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('id',u.id,'email',u.email,'display_name',u.display_name,'role',u.role,
 'tier',u.tier,'tier_expires_at',u.tier_expires_at,'status',u.status,'created_at',u.created_at)
$$;

CREATE FUNCTION public.swat_auth_signup(e text,h text,d text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE u public.users;
BEGIN
 PERFORM public.swat_auth_guard();
 IF length(e)<3 OR length(e)>254 OR e !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  OR h NOT LIKE '$argon2id$%' OR length(h)>1024 OR length(d)>64
 THEN RAISE EXCEPTION 'invalid signup'; END IF;
 INSERT INTO public.users(email,password_hash,display_name,role,tier,status)
 VALUES(e,h,d,'user','free','active') RETURNING * INTO u;
 INSERT INTO public.audit_log(actor_type,actor_id,event) VALUES('user',u.id,'auth.signup');
 RETURN public.swat_auth_user_json(u);
END $$;

CREATE FUNCTION public.swat_auth_password(e text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE u public.users;
BEGIN
 PERFORM public.swat_auth_guard();
 SELECT * INTO u FROM public.users WHERE lower(email::text)=lower(e) FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 RETURN public.swat_auth_user_json(u)||jsonb_build_object('password_hash',u.password_hash);
END $$;

CREATE FUNCTION public.swat_auth_issue(uid uuid,digest bytea,ip_address inet,agent text) RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE expiry timestamptz;
BEGIN
 PERFORM public.swat_auth_guard();
 PERFORM 1 FROM public.users WHERE id=uid AND status='active' FOR UPDATE;
 IF NOT FOUND OR octet_length(digest)<>32 THEN RAISE EXCEPTION 'session admission refused'; END IF;
 expiry:=clock_timestamp()+interval '30 days';
 INSERT INTO public.user_sessions(user_id,token_hash,issued_at,last_seen_at,expires_at,ip,user_agent)
 VALUES(uid,digest,clock_timestamp(),clock_timestamp(),expiry,ip_address,left(agent,256));
 INSERT INTO public.audit_log(actor_type,actor_id,event,ip,user_agent)
 VALUES('user',uid,'auth.login',ip_address,left(agent,256));
 RETURN expiry;
END $$;

-- User-first locking serializes issuance, revoke-all/password-change and wallet operations.
-- Recheck the session AFTER obtaining the user lock, never authorize from the first lookup.
CREATE FUNCTION public.swat_auth_session_user(digest bytea) RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE uid uuid;
BEGIN
 PERFORM public.swat_auth_guard();
 SELECT user_id INTO uid FROM public.user_sessions WHERE token_hash=digest;
 IF uid IS NULL THEN RETURN NULL; END IF;
 PERFORM 1 FROM public.users WHERE id=uid AND status='active' FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 PERFORM 1 FROM public.user_sessions WHERE token_hash=digest AND user_id=uid AND revoked_at IS NULL
  AND expires_at>clock_timestamp() AND issued_at>clock_timestamp()-interval '30 days'
  AND last_seen_at>clock_timestamp()-interval '7 days' FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 RETURN uid;
END $$;

CREATE FUNCTION public.swat_auth_touch(digest bytea) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE uid uuid;
BEGIN
 uid:=public.swat_auth_session_user(digest);
 IF uid IS NULL THEN RETURN false; END IF;
 UPDATE public.user_sessions SET last_seen_at=clock_timestamp() WHERE token_hash=digest
  AND last_seen_at<clock_timestamp()-interval '5 minutes';
 RETURN true;
END $$;

CREATE FUNCTION public.swat_auth_resolve(digest bytea) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE u public.users; sid uuid;
BEGIN
 PERFORM public.swat_auth_guard();
 SELECT s.id INTO sid FROM public.users u0 JOIN public.user_sessions s ON s.user_id=u0.id
 WHERE s.token_hash=digest AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
  AND s.issued_at>clock_timestamp()-interval '30 days' AND s.last_seen_at>clock_timestamp()-interval '7 days'
  AND u0.status='active';
 IF sid IS NULL THEN RETURN NULL; END IF;
 SELECT u0.* INTO u FROM public.users u0 JOIN public.user_sessions s ON s.user_id=u0.id WHERE s.id=sid;
 RETURN public.swat_auth_user_json(u)||jsonb_build_object('session_id',sid);
END $$;

CREATE FUNCTION public.swat_auth_revoke(digest bytea,ip_address inet) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE uid uuid;
BEGIN
 PERFORM public.swat_auth_guard();
 SELECT user_id INTO uid FROM public.user_sessions WHERE token_hash=digest;
 IF uid IS NULL THEN RETURN; END IF;
 PERFORM 1 FROM public.users WHERE id=uid FOR UPDATE;
 UPDATE public.user_sessions SET revoked_at=clock_timestamp() WHERE token_hash=digest AND revoked_at IS NULL;
 IF FOUND THEN INSERT INTO public.audit_log(actor_type,actor_id,event,ip) VALUES('user',uid,'auth.logout',ip_address); END IF;
END $$;

CREATE FUNCTION public.swat_auth_revoke_all(digest bytea) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE uid uuid; n integer;
BEGIN
 uid:=public.swat_auth_session_user(digest);
 IF uid IS NULL THEN RETURN NULL; END IF;
 UPDATE public.user_sessions SET revoked_at=clock_timestamp() WHERE user_id=uid AND revoked_at IS NULL;
 GET DIAGNOSTICS n=ROW_COUNT;
 INSERT INTO public.audit_log(actor_type,actor_id,event) VALUES('user',uid,'auth.sessions_revoked');
 RETURN n;
END $$;

CREATE FUNCTION public.swat_auth_change_password(digest bytea,h text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE uid uuid;
BEGIN
 uid:=public.swat_auth_session_user(digest);
 IF uid IS NULL THEN RETURN false; END IF;
 IF h NOT LIKE '$argon2id$%' OR length(h)>1024 THEN RAISE EXCEPTION 'invalid password encoding'; END IF;
 UPDATE public.users SET password_hash=h,updated_at=clock_timestamp() WHERE id=uid;
 UPDATE public.user_sessions SET revoked_at=clock_timestamp() WHERE user_id=uid AND revoked_at IS NULL;
 INSERT INTO public.audit_log(actor_type,actor_id,event) VALUES('user',uid,'auth.password_changed');
 RETURN true;
END $$;

CREATE FUNCTION public.swat_auth_wallets(digest bytea) RETURNS SETOF public.user_auth_wallets LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE uid uuid;
BEGIN
 uid:=public.swat_auth_session_user(digest);
 IF uid IS NULL THEN RETURN; END IF;
 RETURN QUERY SELECT w.* FROM public.user_auth_wallets w JOIN public.auth_wallet_proofs p
 ON p.wallet_id=w.id AND p.user_id=w.user_id AND p.chain_kind=w.chain_kind AND p.address=w.address AND p.verified_at=w.verified_at
 WHERE w.user_id=uid ORDER BY w.verified_at;
END $$;

CREATE FUNCTION public.swat_auth_link_wallet(digest bytea,chain text,addr text,ip_address inet) RETURNS SETOF public.user_auth_wallets LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE uid uuid; w public.user_auth_wallets; aid bigint;
BEGIN
 uid:=public.swat_auth_session_user(digest);
 IF uid IS NULL THEN RAISE EXCEPTION 'fresh session required' USING ERRCODE='28000'; END IF;
 IF chain NOT IN('evm','solana') OR addr IS NULL OR length(addr)<32 OR length(addr)>100
  OR (chain='evm' AND addr !~ '^0x[0-9a-f]{40}$')
  OR (chain='solana' AND addr !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$') THEN RAISE EXCEPTION 'invalid wallet'; END IF;
 INSERT INTO public.user_auth_wallets(user_id,chain_kind,address,verified_at)
 VALUES(uid,chain,addr,clock_timestamp()) ON CONFLICT(chain_kind,address) DO UPDATE
 SET verified_at=clock_timestamp() WHERE user_auth_wallets.user_id=uid RETURNING * INTO w;
 IF w.id IS NULL THEN RETURN; END IF;
 INSERT INTO public.audit_log(actor_type,actor_id,event,target_type,target_id,ip,metadata,occurred_at)
 VALUES('user',uid,'auth.wallet_linked','auth_wallet',addr,ip_address,'{"proof":"siwe-siws"}',w.verified_at) RETURNING id INTO aid;
 INSERT INTO public.auth_wallet_proofs(wallet_id,user_id,chain_kind,address,verified_at,audit_id)
 VALUES(w.id,uid,chain,addr,w.verified_at,aid) ON CONFLICT(wallet_id) DO UPDATE
 SET verified_at=EXCLUDED.verified_at,audit_id=EXCLUDED.audit_id;
 RETURN NEXT w;
END $$;

CREATE FUNCTION public.swat_auth_unlink_wallet(digest bytea,chain text,addr text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE uid uuid;
BEGIN
 uid:=public.swat_auth_session_user(digest);
 IF uid IS NULL THEN RAISE EXCEPTION 'fresh session required' USING ERRCODE='28000'; END IF;
 DELETE FROM public.user_auth_wallets WHERE user_id=uid AND chain_kind=chain AND address=addr;
 IF NOT FOUND THEN RETURN false; END IF;
 INSERT INTO public.audit_log(actor_type,actor_id,event,target_type,target_id) VALUES('user',uid,'auth.wallet_unlinked','auth_wallet',addr);
 RETURN true;
END $$;

CREATE FUNCTION public.swat_auth_wallet_owner(chain text,addr text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE uid uuid; u public.users;
BEGIN
 PERFORM public.swat_auth_guard();
 SELECT w.user_id INTO uid FROM public.user_auth_wallets w JOIN public.auth_wallet_proofs p
 ON p.wallet_id=w.id AND p.user_id=w.user_id AND p.chain_kind=w.chain_kind AND p.address=w.address AND p.verified_at=w.verified_at
 WHERE w.chain_kind=chain AND w.address=addr;
 IF uid IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO u FROM public.users WHERE id=uid FOR UPDATE;
 -- Fresh proof after user lock: unlink and login serialize on the same root.
 IF NOT EXISTS(SELECT 1 FROM public.user_auth_wallets w JOIN public.auth_wallet_proofs p
 ON p.wallet_id=w.id AND p.user_id=w.user_id AND p.chain_kind=w.chain_kind AND p.address=w.address AND p.verified_at=w.verified_at
 WHERE w.user_id=uid AND w.chain_kind=chain AND w.address=addr) THEN RETURN NULL; END IF;
 RETURN public.swat_auth_user_json(u);
END $$;

CREATE FUNCTION public.swat_auth_login_failure(e text,ip_address inet,agent text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM public.swat_auth_guard();
 INSERT INTO public.audit_log(actor_type,event,ip,user_agent,metadata)
 VALUES('anonymous','auth.login_failed',ip_address,left(agent,256),jsonb_build_object('email',left(e,254)));
END $$;

CREATE FUNCTION public.swat_auth_wallet_failure(chain text,addr text,ip_address inet) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM public.swat_auth_guard();
 INSERT INTO public.audit_log(actor_type,event,ip,metadata)
 VALUES('anonymous','auth.wallet_login_failed',ip_address,jsonb_build_object('chainKind',chain,'address',addr));
END $$;

-- No direct app/service authentication mutation or password read, including column ACL remnants.
REVOKE ALL ON public.users,public.user_sessions,public.user_auth_wallets FROM PUBLIC,swat_app,swat_auth_service;
DO $$ DECLARE c record; f record; BEGIN
 FOR c IN SELECT t.relname,a.attname FROM pg_attribute a JOIN pg_class t ON t.oid=a.attrelid
 WHERE t.oid IN('public.users'::regclass,'public.user_sessions'::regclass,'public.user_auth_wallets'::regclass)
 AND a.attnum>0 AND NOT a.attisdropped LOOP
  EXECUTE format('REVOKE ALL (%I) ON public.%I FROM PUBLIC,swat_app,swat_auth_service',c.attname,c.relname);
 END LOOP;
 FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname LIKE 'swat_auth_%' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,swat_app,swat_auth_service',f.signature);
 END LOOP;
END $$;
GRANT SELECT(id,email,display_name,role,tier,tier_expires_at,status,created_at,updated_at) ON public.users TO swat_app;
GRANT UPDATE(display_name,tier,tier_expires_at,updated_at) ON public.users TO swat_app;
GRANT SELECT ON public.user_auth_wallets TO swat_app;
-- No service EXECUTE until exact external DBA catalog validation and handoff.
