-- 081-custody-schema.proposal.sql — SOURCE PROPOSAL ONLY. NEVER APPLIED BY OWNER E.
-- Requires independently approved/provisioned swat_custody_writer and service
-- identities. No CREATE ROLE, membership, credentials, bypass, or seeding here.
-- Envelope formatting is not authenticated custody. The writer must actually
-- authenticate all binding AAD and retain its admission before an app grant write.
-- The migration runner owns the suffix+journal transaction; no inner transaction control.
DO $$
DECLARE writer oid; migrator oid;
BEGIN
  IF current_user <> 'swat_migrator' OR session_user <> 'swat_migrator' THEN
    RAISE EXCEPTION 'custody proposal requires separate migrator';
  END IF;
  SELECT oid INTO migrator FROM pg_roles WHERE rolname = 'swat_migrator';
  SELECT oid INTO writer FROM pg_roles WHERE rolname = 'swat_custody_writer'
    AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb
    AND NOT rolreplication AND NOT rolinherit;
  IF writer IS NULL THEN RAISE EXCEPTION 'separate approved custody writer required'; END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members WHERE member = writer OR roleid = writer) THEN
    RAISE EXCEPTION 'custody writer membership in either direction is forbidden';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_database WHERE datdba = writer)
    OR EXISTS (SELECT 1 FROM pg_namespace WHERE nspowner = writer)
    OR EXISTS (SELECT 1 FROM pg_class WHERE relowner = writer)
    OR EXISTS (SELECT 1 FROM pg_proc WHERE proowner = writer)
    OR has_database_privilege(writer, current_database(), 'CREATE')
    OR EXISTS (SELECT 1 FROM pg_namespace WHERE has_schema_privilege(writer, oid, 'CREATE')) THEN
    RAISE EXCEPTION 'custody writer must not own objects or have effective CREATE';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'public' AND nspowner = migrator)
    OR NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.user_execution_grants'::regclass
      AND relkind = 'r' AND relowner = migrator AND NOT relispartition)
    OR NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.users'::regclass AND relkind = 'r' AND relowner = migrator)
    OR to_regclass('public.custody_secret_admissions') IS NOT NULL
    OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname IN ('custody_admission_guard_081','custody_grant_guard_081'))
    OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.user_execution_grants'::regclass
      AND tgname = 'custody_grant_guard_081')
    OR EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.user_execution_grants'::regclass
      AND polname IN ('custody_bootstrap_081','custody_grant_tenant_081','custody_grant_allow_081'))
    OR EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.user_execution_grants'::regclass
      AND NOT attisdropped AND attname IN ('secret_binding','lifecycle_revision','revocation_tombstone','activated_key_version')) THEN
    -- Suffix journal makes this once-only. Never silently trust IF NOT EXISTS catalog drift.
    RAISE EXCEPTION 'unexpected preexisting custody catalog or non-migrator owner';
  END IF;
END $$;

ALTER TABLE public.user_execution_grants ADD COLUMN secret_binding jsonb;
ALTER TABLE public.user_execution_grants ADD COLUMN lifecycle_revision bigint NOT NULL DEFAULT 1 CHECK (lifecycle_revision > 0);
ALTER TABLE public.user_execution_grants ADD COLUMN revocation_tombstone timestamptz;
ALTER TABLE public.user_execution_grants ADD COLUMN activated_key_version integer CHECK (activated_key_version > 0);
-- Preserve existing revocations before installing the monotonic guard. Migrator-only
-- temporary policy does not grant runtime bypass and is dropped in this transaction.
CREATE POLICY custody_bootstrap_081 ON public.user_execution_grants TO swat_migrator
  USING (current_user = 'swat_migrator' AND session_user = 'swat_migrator')
  WITH CHECK (current_user = 'swat_migrator' AND session_user = 'swat_migrator');
UPDATE public.user_execution_grants SET revocation_tombstone = COALESCE(revoked_at, statement_timestamp()),
  activated_key_version = key_version WHERE status IN ('revoked','compromised') OR revoked_at IS NOT NULL;
UPDATE public.user_execution_grants SET activated_key_version = key_version WHERE activated_key_version IS NULL;
DROP POLICY custody_bootstrap_081 ON public.user_execution_grants;

CREATE TABLE public.custody_secret_admissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  chain varchar(32) NOT NULL CHECK (chain IN ('polygon','robinhood-chain')),
  grant_kind varchar(24) NOT NULL CHECK (grant_kind IN ('eip7702','session_key_4337','polymarket_signer')),
  account_address varchar(100) NOT NULL CHECK (account_address ~ '^0x[0-9a-f]{40}$'),
  key_version integer NOT NULL CHECK (key_version > 0),
  sealed_secret text NOT NULL,
  secret_binding jsonb NOT NULL,
  scope_policy jsonb,
  expires_at timestamptz,
  wrapper_id text NOT NULL CHECK (wrapper_id ~ '^[A-Za-z0-9:_-]{1,128}$'),
  service_identity text NOT NULL CHECK (length(service_identity) BETWEEN 1 AND 256),
  authenticated_receipt text NOT NULL CHECK (length(authenticated_receipt) BETWEEN 1 AND 4096),
  accepted_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (grant_id, key_version),
  CHECK (grant_kind = 'polymarket_signer' OR expires_at IS NOT NULL)
);
ALTER TABLE public.custody_secret_admissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.custody_secret_admissions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS custody_admission_tenant ON public.custody_secret_admissions;
CREATE POLICY custody_admission_tenant ON public.custody_secret_admissions
  USING (user_id = NULLIF(current_setting('app.current_user_id',true),'')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id',true),'')::uuid);
REVOKE ALL ON public.custody_secret_admissions FROM PUBLIC, swat_app, swat_custody_writer;
GRANT SELECT ON public.custody_secret_admissions TO swat_app;
GRANT SELECT, INSERT ON public.custody_secret_admissions TO swat_custody_writer;
-- No UPDATE or DELETE and no app INSERT. Independent authenticated writer only.

CREATE OR REPLACE FUNCTION public.custody_admission_guard_081() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog,public AS $$
DECLARE b jsonb;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'custody admissions are immutable'; END IF;
  IF current_user <> 'swat_custody_writer' OR session_user <> 'swat_custody_writer' THEN
    RAISE EXCEPTION 'authenticated custody writer required';
  END IF;
  NEW.accepted_at := statement_timestamp();
  b := NEW.secret_binding;
  IF jsonb_typeof(b) IS DISTINCT FROM 'object' OR
     NOT (b ?& ARRAY['contextVersion','scopeVersion','purpose','grantId','userId','chain','grantKind',
       'accountAddress','keyVersion','policyDigest','deploymentId','chainId','expiresAt']) OR
     (SELECT count(*) FROM jsonb_object_keys(b)) <> 13 OR
     b->'contextVersion' IS DISTINCT FROM '2'::jsonb OR b->'scopeVersion' IS DISTINCT FROM '1'::jsonb OR
     b->'keyVersion' IS DISTINCT FROM to_jsonb(NEW.key_version) OR
     b->>'purpose' IS DISTINCT FROM 'execution-grant' OR
     b->>'grantId' IS DISTINCT FROM NEW.grant_id::text OR b->>'userId' IS DISTINCT FROM NEW.user_id::text OR
     b->>'chain' IS DISTINCT FROM NEW.chain OR b->>'grantKind' IS DISTINCT FROM NEW.grant_kind OR
     b->>'accountAddress' IS DISTINCT FROM NEW.account_address OR b->>'keyVersion' IS DISTINCT FROM NEW.key_version::text OR
     COALESCE(b->>'policyDigest','') !~ '^[0-9a-f]{64}$' OR
     COALESCE(b->>'deploymentId','') !~ '^[A-Za-z0-9:_-]{1,128}$' OR
     b->>'chainId' IS DISTINCT FROM (CASE NEW.chain WHEN 'polygon' THEN '137' ELSE '4663' END) OR
     (NEW.grant_kind = 'polymarket_signer' AND NEW.chain <> 'polygon') OR
     (NEW.grant_kind <> 'polymarket_signer' AND NEW.chain <> 'robinhood-chain') OR
     split_part(NEW.sealed_secret,'.',1) <> 'v2' OR
     split_part(NEW.sealed_secret,'.',2) <> NEW.wrapper_id OR
     split_part(NEW.sealed_secret,'.',3) <> NEW.key_version::text OR
     array_length(string_to_array(NEW.sealed_secret,'.'),1) <> 7 OR
     (NEW.expires_at IS NULL AND b->'expiresAt' IS DISTINCT FROM 'null'::jsonb) OR
     (NEW.expires_at IS NOT NULL AND (b->>'expiresAt')::timestamptz IS DISTINCT FROM NEW.expires_at) OR
     (NEW.expires_at IS NOT NULL AND NEW.expires_at <= NEW.accepted_at) THEN
    RAISE EXCEPTION 'invalid authenticated custody binding';
  END IF;
  -- Policy digest is the application canonical JSON SHA256, authenticated by
  -- the service. PG jsonb::text is not its canonicalizer. Exact JSON policy and
  -- binding are joined below; a digest label alone cannot authorize anything.
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS custody_admission_guard_081 ON public.custody_secret_admissions;
CREATE TRIGGER custody_admission_guard_081 BEFORE INSERT OR UPDATE OR DELETE
  ON public.custody_secret_admissions FOR EACH ROW EXECUTE FUNCTION public.custody_admission_guard_081();
REVOKE ALL ON FUNCTION public.custody_admission_guard_081() FROM PUBLIC;

ALTER TABLE public.user_execution_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_execution_grants FORCE ROW LEVEL SECURITY;
-- Existing broad bypass policy is replaced for this domain: no wildcard setting.
DROP POLICY IF EXISTS tenant_isolation_policy ON public.user_execution_grants;
DROP POLICY IF EXISTS tenant_isolation ON public.user_execution_grants;
DROP POLICY IF EXISTS custody_grant_tenant_081 ON public.user_execution_grants;
CREATE POLICY custody_grant_tenant_081 ON public.user_execution_grants AS RESTRICTIVE
  USING (user_id = NULLIF(current_setting('app.current_user_id',true),'')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id',true),'')::uuid);
DROP POLICY IF EXISTS custody_grant_allow_081 ON public.user_execution_grants;
CREATE POLICY custody_grant_allow_081 ON public.user_execution_grants
  USING (user_id = NULLIF(current_setting('app.current_user_id',true),'')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id',true),'')::uuid);

CREATE OR REPLACE FUNCTION public.custody_grant_guard_081() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog,public AS $$
DECLARE a public.custody_secret_admissions%ROWTYPE; changed_binding boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'execution grant history must be retained'; END IF;
  changed_binding := true;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id OR
       NEW.chain IS DISTINCT FROM OLD.chain OR NEW.account_address IS DISTINCT FROM OLD.account_address OR
       NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'execution grant identity is immutable';
    END IF;
    IF OLD.status = 'compromised' THEN RAISE EXCEPTION 'compromised grant is terminal'; END IF;
    -- Server-generated revision advances even on a no-op write. Never accept caller
    -- revisions, tombstone clearing or staged activated-version substitution.
    NEW.lifecycle_revision := OLD.lifecycle_revision + 1;
    NEW.revocation_tombstone := OLD.revocation_tombstone;
    NEW.activated_key_version := OLD.activated_key_version;
    NEW.revoked_at := OLD.revoked_at;
    IF NEW.status IN ('revoked','compromised') THEN
      NEW.revoked_at := GREATEST(statement_timestamp(), OLD.revocation_tombstone);
      NEW.revocation_tombstone := NEW.revoked_at;
      NEW.activated_key_version := GREATEST(OLD.activated_key_version, OLD.key_version);
    END IF;
    changed_binding := (NEW.sealed_secret,NEW.secret_binding,NEW.scope_policy,NEW.expires_at,NEW.grant_kind,NEW.key_version)
      IS DISTINCT FROM (OLD.sealed_secret,OLD.secret_binding,OLD.scope_policy,OLD.expires_at,OLD.grant_kind,OLD.key_version);
    IF changed_binding AND (NEW.key_version IS NULL OR OLD.key_version IS NULL OR NEW.key_version <= OLD.key_version) THEN
      RAISE EXCEPTION 'new immutable custody admission version required';
    END IF;
    -- Retirement never erases a revocation. Keyless resurrection requires a
    -- separately verified deployed re-enrollment capability, not this local API.
    IF NEW.status = 'active' AND OLD.revocation_tombstone IS NOT NULL AND
       (OLD.status <> 'active' OR changed_binding) AND
       (NEW.grant_kind = 'solana_vault' OR NEW.key_version IS NULL OR
        NEW.key_version <= COALESCE(OLD.activated_key_version, OLD.key_version, 0)) THEN
      RAISE EXCEPTION 'fresh post-revocation custody admission required';
    END IF;
    -- Legacy unbound rows can retire/revoke without admission, but this early
    -- return occurs only AFTER revision/tombstone have been assigned above.
    IF NOT changed_binding AND NEW.status <> 'active' THEN RETURN NEW; END IF;
  ELSE
    IF NEW.status NOT IN ('active','retired') OR NEW.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'new custody grant must be an enrollment';
    END IF;
    NEW.lifecycle_revision := 1;
    NEW.revocation_tombstone := NULL;
    NEW.revoked_at := NULL;
    NEW.activated_key_version := NULL;
  END IF;
  IF NEW.grant_kind = 'solana_vault' THEN
    IF NEW.chain <> 'solana' OR NEW.sealed_secret IS NOT NULL OR NEW.key_version IS NOT NULL OR NEW.secret_binding IS NOT NULL THEN
      RAISE EXCEPTION 'keyless grants must remain keyless';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO a FROM public.custody_secret_admissions
    WHERE grant_id = NEW.id AND user_id = NEW.user_id AND key_version = NEW.key_version;
  IF NOT FOUND OR a.chain IS DISTINCT FROM NEW.chain OR a.grant_kind IS DISTINCT FROM NEW.grant_kind OR
     a.account_address IS DISTINCT FROM NEW.account_address OR a.sealed_secret IS DISTINCT FROM NEW.sealed_secret OR
     a.secret_binding IS DISTINCT FROM NEW.secret_binding OR a.scope_policy IS DISTINCT FROM NEW.scope_policy OR
     a.expires_at IS DISTINCT FROM NEW.expires_at OR
     (NEW.revocation_tombstone IS NOT NULL AND a.accepted_at <= NEW.revocation_tombstone AND
       (changed_binding OR NEW.status = 'active')) OR
     (NEW.status = 'active' AND NEW.expires_at IS NOT NULL AND NEW.expires_at <= statement_timestamp()) THEN
    RAISE EXCEPTION 'independent authenticated custody admission required';
  END IF;
  IF NEW.status = 'active' THEN
    NEW.activated_key_version := NEW.key_version;
    NEW.revoked_at := NULL; -- only after fresh version and independent admission checks
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS custody_grant_guard_081 ON public.user_execution_grants;
CREATE TRIGGER custody_grant_guard_081 BEFORE INSERT OR UPDATE OR DELETE
  ON public.user_execution_grants FOR EACH ROW EXECUTE FUNCTION public.custody_grant_guard_081();
REVOKE ALL ON FUNCTION public.custody_grant_guard_081() FROM PUBLIC;
-- Keep application grant operations; authenticated admissions constrain keyed writes.
REVOKE DELETE ON public.user_execution_grants FROM swat_app;
REVOKE ALL ON public.user_execution_grants FROM swat_custody_writer;
-- A separately authorized execution reader is NOT provisioned here. This schema
-- does not make DB credentials or process API/executor isolation true.
-- Fail closed on catalog/owner drift after DDL. The writer's SELECT/INSERT never
-- conveys trigger/constraint/ACL ownership; all domain objects remain migrator-owned.
DO $$
DECLARE migrator oid;
BEGIN
  SELECT oid INTO migrator FROM pg_roles WHERE rolname = 'swat_migrator';
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.custody_secret_admissions'::regclass
      AND relkind = 'r' AND relowner = migrator AND relrowsecurity AND relforcerowsecurity AND NOT relispartition)
    OR (SELECT count(*) FROM pg_attribute WHERE attrelid = 'public.custody_secret_admissions'::regclass
      AND attnum > 0 AND NOT attisdropped) <> 15
    OR EXISTS (SELECT 1 FROM pg_proc WHERE oid IN
      ('public.custody_admission_guard_081()'::regprocedure,'public.custody_grant_guard_081()'::regprocedure)
      AND (proowner <> migrator OR prosecdef)) THEN
    RAISE EXCEPTION 'unexpected resulting custody catalog or owner';
  END IF;
END $$;
