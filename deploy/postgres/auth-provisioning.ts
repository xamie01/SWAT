import { createHash } from 'node:crypto';
import type { AuthClientLease, AuthQueryClient } from '../../packages/db/src/auth-owned.js';
import { validateAuthPolicyClosure, validateAuthRelations } from './auth-catalog-dependencies.js';

/** Staged integration contract for production and independently replayed reference/candidate.
 * The migration selection MUST include the exact 087 source, commit its inert objects and
 * retire the P2 broker first. Then call provisionCommittedAuthentication on a separately
 * owned DIRECT DBA lease. Only after catalog validation may the external LOGIN lifecycle
 * helper activate swat_auth_service. No passwords, pool creation or SQL on import.
 * This source performs no lifecycle scheduling and is not runtime authorization. */
export const AUTH_INSTALLATION_STAGES = Object.freeze([
  'direct-migrator: reviewed 001-087 selection excluding 084; commit inert 087 and retire seven-transfer broker',
  'direct-external-DBA: provisionCommittedAuthentication; checked atomic handoff COMMIT',
  'direct-external-DBA: validateAuthenticationInstallation(disabled), owned read-only committed catalog gate',
  'external-login-lifecycle: credential provisioning, bounded LOGIN, scheduled NOLOGIN and session drain',
  'direct-auth-service: checked owned runtime identity; reference/candidate authentication qualification'
] as const);
export const AUTH_MIGRATION_SHA256 = 'd561ae22c79b668965cb2615c2b6b72a388891ea70c23f8538f111097e5bf9b0';
const internal = new Set(['swat_auth_guard', 'swat_auth_user_json', 'swat_auth_session_user']);
export const AUTH_FUNCTION_SIGNATURES = Object.freeze([
  'public.swat_auth_guard()', 'public.swat_auth_user_json(public.users)',
  'public.swat_auth_signup(text,text,text)', 'public.swat_auth_password(text)',
  'public.swat_auth_issue(uuid,bytea,inet,text)', 'public.swat_auth_session_user(bytea)',
  'public.swat_auth_touch(bytea)', 'public.swat_auth_resolve(bytea)',
  'public.swat_auth_revoke(bytea,inet)', 'public.swat_auth_revoke_all(bytea)',
  'public.swat_auth_change_password(bytea,text)', 'public.swat_auth_wallets(bytea)',
  'public.swat_auth_link_wallet(bytea,text,text,inet)', 'public.swat_auth_unlink_wallet(bytea,text,text)',
  'public.swat_auth_wallet_owner(text,text)', 'public.swat_auth_login_failure(text,inet,text)',
  'public.swat_auth_wallet_failure(text,text,inet)'
] as const);
export type AuthCatalogPhase = 'inert' | 'disabled' | 'active';
type Pin = { name: string; signature: string; body: string; argumentNames: string[] | null;
  language: string; definer: boolean; result: string; set: boolean; types: string[] };
function pins(sql: string): Pin[] {
  if (typeof sql !== 'string' || createHash('sha256').update(sql).digest('hex') !== AUTH_MIGRATION_SHA256)
    throw new Error('Exact reviewed committed 087 source required');
  const found = [...sql.matchAll(/CREATE FUNCTION public\.(swat_auth_\w+)\(([^)]*)\) RETURNS (.*?) LANGUAGE (\w+) SECURITY (DEFINER|INVOKER) SET search_path=pg_catalog AS \$\$([\s\S]*?)\$\$;/g)];
  const result = found.map(m => {
    const args = m[2] ? m[2].split(',').map(a => a.trim().split(/\s+/)) : [];
    const types = args.map(a => a[1]!);
    const set = m[3]!.startsWith('SETOF ');
    const type = m[3]!.replace(/^SETOF /, '');
    return { name: m[1]!, signature: `public.${m[1]}(${types.join(',')})`, body: m[6]!,
      argumentNames: args.length ? args.map(a => a[0]!) : null, language: m[4]!,
      definer: m[5] === 'DEFINER', result: type, set, types };
  });
  if (result.length !== AUTH_FUNCTION_SIGNATURES.length || result.some((p,i) => p.signature !== AUTH_FUNCTION_SIGNATURES[i]))
    throw new Error('087 fixed routine inventory rejected');
  return result;
}
async function dba(client: AuthQueryClient, role: string, clean=false): Promise<number> {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(role) || role.startsWith('swat_')) throw new Error('Distinct direct external DBA identity required');
  const { rows } = await client.query(`SELECT current_user AS current_role,session_user AS session_role,
    current_setting('role') AS role_setting,current_setting('row_security') AS row_security,
    pg_backend_pid() AS backend,r.rolsuper AS superuser,
    (SELECT xact_start=query_start FROM pg_stat_activity WHERE pid=pg_backend_pid()) AS transaction_clean
    FROM pg_catalog.pg_roles r WHERE rolname=current_user`);
  const r = rows[0];
  if (rows.length !== 1 || r?.current_role !== role || r.session_role !== role || r.role_setting !== 'none'
    || r.row_security !== 'on' || clean && r.transaction_clean !== true || r.superuser !== true || !Number.isInteger(r.backend) || r.backend <= 0)
    throw new Error('Authenticated direct external DBA backend required');
  return r.backend as number;
}
async function roles(client: AuthQueryClient, phase: AuthCatalogPhase): Promise<void> {
  const { rows } = await client.query(`SELECT r.rolname,r.rolcanlogin,
    (r.rolsuper OR r.rolbypassrls OR r.rolinherit OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication) AS unsafe,
    EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid) AS membership,
    (EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE relowner=r.oid)
     OR EXISTS(SELECT 1 FROM pg_catalog.pg_namespace WHERE nspowner=r.oid)
     OR EXISTS(SELECT 1 FROM pg_catalog.pg_database WHERE datdba=r.oid)) AS owns,
    (has_database_privilege(r.oid,current_database(),'CREATE')
     OR EXISTS(SELECT 1 FROM pg_catalog.pg_namespace WHERE has_schema_privilege(r.oid,oid,'CREATE'))) AS can_create,
    ARRAY(SELECT p.oid::regprocedure::text FROM pg_catalog.pg_proc p WHERE proowner=r.oid ORDER BY 1) AS functions,
    EXISTS(SELECT 1 FROM pg_catalog.pg_shdepend d WHERE d.refclassid='pg_catalog.pg_authid'::regclass AND d.refobjid=r.oid AND d.deptype='o'
      AND NOT(d.dbid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND d.classid='pg_proc'::regclass
        AND d.objsubid=0 AND d.objid=ANY($1::regprocedure[]))) AS extra_ownership
    FROM pg_catalog.pg_roles r WHERE rolname IN('swat_auth_service','swat_auth_owner')`,[[...AUTH_FUNCTION_SIGNATURES]]);
  const {rows:settings}=await client.query(`SELECT r.rolname,s.setdatabase,s.setconfig FROM pg_db_role_setting s
    JOIN pg_roles r ON r.oid=s.setrole WHERE r.rolname IN('swat_auth_service','swat_auth_owner')`);
  const allowed=['row_security=on','search_path=pg_catalog','search_path=pg_catalog, public'];
  if(settings.some(r=>Number(r.setdatabase)!==0||!Array.isArray(r.setconfig)||r.setconfig.some((s:string)=>!allowed.includes(s)))
    ||phase!=='inert'&&['swat_auth_service','swat_auth_owner'].some(role=>!settings.some(r=>r.rolname===role&&r.setconfig.includes('row_security=on')&&r.setconfig.includes('search_path=pg_catalog'))))
    throw new Error('Auth role database/GUC defaults drift');
  if (!rows.some(r => r.rolname === 'swat_auth_service') || phase !== 'inert' && rows.length !== 2)
    throw new Error('Auth roles missing');
  for (const r of rows) {
    const service = r.rolname === 'swat_auth_service';
    if (r.unsafe !== false || r.membership !== false || r.owns !== false || r.extra_ownership !== false || r.can_create !== false
      || r.rolcanlogin !== (service && phase === 'active') || !Array.isArray(r.functions)
      || service && r.functions.length !== 0
      || !service && (phase === 'inert' ? r.functions.length !== 0 :
        JSON.stringify([...r.functions].sort()) !== JSON.stringify([...AUTH_FUNCTION_SIGNATURES].sort())))
      throw new Error('Auth restricted flags/ownership/CREATE/membership drift');
  }
}
async function functions(client: AuthQueryClient, expected: Pin[], phase: AuthCatalogPhase): Promise<void> {
  const { rows: inventory } = await client.query(`SELECT p.oid::regprocedure::text AS signature
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname LIKE 'swat_auth_%' ORDER BY 1`);
  if (JSON.stringify(inventory.map(r => r.signature).sort()) !== JSON.stringify([...AUTH_FUNCTION_SIGNATURES].sort()))
    throw new Error('Auth function inventory drift');
  const owner = phase === 'inert' ? 'swat_migrator' : 'swat_auth_owner';
  for (const p of expected) {
    const { rows } = await client.query(`SELECT r.rolname AS owner,p.prosrc,p.probin,p.prosqlbody,p.prokind,p.prosecdef,p.proisstrict,
      p.proleakproof,p.proretset,p.prosupport,p.provariadic,p.procost,p.prorows,p.provolatile,p.proparallel,
      p.proconfig,p.proargnames,p.proallargtypes,p.proargmodes,p.pronargdefaults,p.proargdefaults,
      p.prorettype=to_regtype($2) AS return_matches,p.pronargs,p.proargtypes::text AS argument_oids,
      ARRAY(SELECT to_regtype(t)::oid::text FROM unnest($3::text[]) t) AS expected_oids,l.lanname,
      (SELECT jsonb_agg(jsonb_build_object('grantor',g.rolname,'grantee',COALESCE(a0.rolname,'PUBLIC'),
       'privilege',a.privilege_type,'grantable',a.is_grantable) ORDER BY COALESCE(a0.rolname,'PUBLIC'))
       FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
       LEFT JOIN pg_roles g ON g.oid=a.grantor LEFT JOIN pg_roles a0 ON a0.oid=a.grantee) AS acl
      FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner JOIN pg_language l ON l.oid=p.prolang
      WHERE p.oid=to_regprocedure($1)`, [p.signature, p.result, p.types]);
    const r = rows[0];
    const expectedAcl = [owner, ...(phase !== 'inert' && !internal.has(p.name) ? ['swat_auth_service'] : [])].sort();
    if (rows.length !== 1 || !r || r.owner !== owner || r.prosrc !== p.body || r.probin !== null || r.prosqlbody !== null || r.prokind !== 'f'
      || r.prosecdef !== p.definer || r.proisstrict !== false || r.proleakproof !== false || r.proretset !== p.set
      || Number(r.prosupport) !== 0 || Number(r.provariadic) !== 0 || r.procost !== 100 || r.prorows !== (p.set ? 1000 : 0)
      || r.provolatile !== 'v' || r.proparallel !== 'u' || r.lanname !== p.language
      || JSON.stringify(r.proconfig) !== JSON.stringify(['search_path=pg_catalog'])
      || JSON.stringify(r.proargnames) !== JSON.stringify(p.argumentNames)
      || r.proallargtypes !== null || r.proargmodes !== null || r.pronargdefaults !== 0 || r.proargdefaults !== null
      || r.return_matches !== true || r.pronargs !== p.types.length || r.argument_oids !== r.expected_oids.join(' ')
      || !Array.isArray(r.acl) || JSON.stringify(r.acl.map((a: {grantee: string}) => a.grantee).sort()) !== JSON.stringify(expectedAcl)
      || r.acl.some((a: {grantor: string; privilege: string; grantable: boolean}) => a.grantor !== owner || a.privilege !== 'EXECUTE' || a.grantable !== false))
      throw new Error(`Auth exact signature/body/options/owner/ACL drift: ${p.signature}`);
  }
}
const relations = ['users','user_sessions','user_auth_wallets','auth_wallet_proofs','audit_log'] as const;
const ownerTable: Record<string, readonly string[]> = {
  users: ['SELECT'], user_sessions: ['SELECT'], user_auth_wallets: ['SELECT','DELETE'],
  auth_wallet_proofs: ['SELECT','INSERT','UPDATE'], audit_log: ['INSERT']
};
const ownerColumns: Record<string, Record<string, readonly string[]>> = {
  users: { INSERT: ['email','password_hash','display_name','role','tier','status'], UPDATE: ['password_hash','updated_at'] },
  user_sessions: { INSERT: ['user_id','token_hash','issued_at','last_seen_at','expires_at','ip','user_agent'], UPDATE: ['revoked_at','last_seen_at'] },
  user_auth_wallets: { INSERT: ['user_id','chain_kind','address','verified_at'], UPDATE: ['verified_at'] },
  audit_log: { SELECT: ['id'] }
};
const appColumns: Record<string, Record<string, readonly string[]>> = {
  users: { SELECT: ['id','email','display_name','role','tier','tier_expires_at','status','created_at','updated_at'],
    UPDATE: ['display_name','tier','tier_expires_at','updated_at'] }
};
function aclEntries(table: string, phase: AuthCatalogPhase): string[] {
  const result: string[] = [];
  if (phase !== 'inert') {
    for (const privilege of ownerTable[table] ?? []) result.push(`swat_auth_owner:${privilege}:`);
    for (const [privilege, columns] of Object.entries(ownerColumns[table] ?? {}))
      for (const c of columns) result.push(`swat_auth_owner:${privilege}:${c}`);
  }
  if (table === 'user_auth_wallets' || table === 'auth_wallet_proofs') result.push('swat_app:SELECT:');
  for (const [privilege, columns] of Object.entries(appColumns[table] ?? {}))
    for (const c of columns) result.push(`swat_app:${privilege}:${c}`);
  return result.sort();
}
function equalJson(a: unknown,b: unknown): boolean {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a0],[b0])=>a0.localeCompare(b0)).map(([k,v])=>[k,canonical(v)])) : value;
  return JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
}
async function catalog(client: AuthQueryClient, phase: AuthCatalogPhase): Promise<void> {
  // Exact auth-local ACL equality plus global absence of service/owner privileges outside
  // the reviewed auth objects. No TRUNCATE, table password UPDATE or column backdoors.
  const { rows: grants } = await client.query(`SELECT n.nspname,c.relname,COALESCE(col.attname,'') AS column_name,
    gr.rolname AS grantee,g0.rolname AS grantor,a.privilege_type,a.is_grantable
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    CROSS JOIN LATERAL (
      SELECT NULL::smallint AS attnum,x.* FROM aclexplode(c.relacl) x
      UNION ALL SELECT at.attnum,x.* FROM pg_attribute at CROSS JOIN LATERAL aclexplode(at.attacl) x
        WHERE at.attrelid=c.oid AND at.attnum>0 AND NOT at.attisdropped) a
    LEFT JOIN pg_attribute col ON col.attrelid=c.oid AND col.attnum=a.attnum
    LEFT JOIN pg_roles gr ON gr.oid=a.grantee LEFT JOIN pg_roles g0 ON g0.oid=a.grantor
    WHERE gr.rolname IN('swat_auth_owner','swat_auth_service')
      OR (n.nspname='public' AND c.relname=ANY($1::text[])
        AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='swat_migrator') OR a.attnum IS NOT NULL))`, [[...relations]]);
  for (const r of grants) {
    if (r.grantee === 'swat_auth_service' || r.nspname !== 'public'
      || ![...relations,'audit_log_id_seq'].includes(r.relname) || r.grantor !== 'swat_migrator' || r.is_grantable !== false)
      throw new Error('Auth unexpected global/table/column permission');
    if (r.relname === 'audit_log_id_seq' && (r.grantee !== 'swat_auth_owner' || r.privilege_type !== 'USAGE' || r.column_name !== ''))
      throw new Error('Auth sequence privilege drift');
  }
  for (const table of relations) {
    const actual = grants.filter(r => r.relname === table).map(r => `${r.grantee ?? 'PUBLIC'}:${r.privilege_type}:${r.column_name}`).sort();
    if (JSON.stringify(actual) !== JSON.stringify(aclEntries(table,phase))) throw new Error(`Auth ACL drift: ${table}`);
  }
  if (grants.filter(r => r.relname === 'audit_log_id_seq').length !== (phase === 'inert' ? 0 : 1)) throw new Error('Auth sequence grant missing/extra');
  // validateAuthRelations already pins every touching FK and all four internal
  // paths against the independent canonical inventory. No ANY-FK admission here.
  const { rows } = await client.query(`SELECT c.relname,r.rolname AS owner,c.relkind,c.relrowsecurity,c.relforcerowsecurity,
    EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal) AS unexpected_trigger,
    (SELECT jsonb_agg(jsonb_build_object('name',p.polname,'cmd',p.polcmd,'permissive',p.polpermissive,
      'roles',ARRAY(SELECT COALESCE(r0.rolname,'PUBLIC') FROM unnest(p.polroles) o LEFT JOIN pg_roles r0 ON r0.oid=o ORDER BY 1),
      'using',regexp_replace(pg_get_expr(p.polqual,p.polrelid),'[[:space:]]','','g'),
      'check',regexp_replace(pg_get_expr(p.polwithcheck,p.polrelid),'[[:space:]]','','g')) ORDER BY p.polname)
      FROM pg_policy p WHERE p.polrelid=c.oid) AS policies
    FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE c.oid=ANY($1::regclass[])`,
    [[...relations].map(r => `public.${r}`)]);
  if (rows.length !== relations.length) throw new Error('Auth relation inventory missing');
  for (const r of rows) {
    if (r.owner !== 'swat_migrator' || r.relkind !== 'r' || r.unexpected_trigger !== false)
      throw new Error('Auth relation owner/kind/trigger drift');
    if (r.relname === 'audit_log') {
      if (r.relrowsecurity !== false || r.relforcerowsecurity !== false || r.policies !== null)
        throw new Error('Auth audit relation policy drift');
      continue;
    }
    if (r.relrowsecurity !== true || r.relforcerowsecurity !== true || !Array.isArray(r.policies)) throw new Error('Auth FORCE RLS required');
    const proof = r.relname === 'auth_wallet_proofs';
    const wallet=r.relname==='user_auth_wallets';
    const tenant = proof ? '(user_id=public.current_app_user_id())' : wallet
      ? '(public.is_rls_bypassed()OR((user_id=public.current_app_user_id())AND(EXISTS(SELECT1FROMpublic.auth_wallet_proofspWHERE((p.wallet_id=user_auth_wallets.id)AND(p.user_id=user_auth_wallets.user_id)AND(p.chain_kind=(user_auth_wallets.chain_kind)::text)AND(p.address=(user_auth_wallets.address)::text)AND(p.verified_at=user_auth_wallets.verified_at))))))'
      : `(public.is_rls_bypassed()OR(${r.relname === 'users' ? 'id' : 'user_id'}=public.current_app_user_id()))`;
    const expected = [{ name: proof ? 'auth087_proof_tenant' : 'tenant_isolation_policy', cmd: proof ? 'r' : '*',
      permissive: true, roles: proof ? ['swat_app'] : ['swat_app','swat_migrator'], using: tenant, check: proof ? null : wallet ? 'public.is_rls_bypassed()' : tenant },
      ...(phase !== 'inert' ? [{ name: 'auth087_owner', cmd: '*', permissive: true, roles: ['swat_auth_owner'],
        using: "(CURRENT_USER='swat_auth_owner'::name)", check: "(CURRENT_USER='swat_auth_owner'::name)" }] : [])].sort((a,b)=>a.name.localeCompare(b.name));
    if (!equalJson(r.policies,expected)) throw new Error(`Auth exact RLS policy drift: ${r.relname}`);
  }
  const { rows: sequence }=await client.query(`SELECT r.rolname AS owner,c.relkind,
    pg_get_serial_sequence('public.audit_log','id') AS sequence_name FROM pg_class c
    JOIN pg_roles r ON r.oid=c.relowner WHERE c.oid=to_regclass('public.audit_log_id_seq')`);
  if(sequence.length!==1||sequence[0]?.owner!=='swat_migrator'||sequence[0].relkind!=='S'
    ||sequence[0].sequence_name!=='public.audit_log_id_seq') throw new Error('Auth exact audit sequence identity drift');
  const {rows: defaults}=await client.query(`SELECT a.oid FROM pg_default_acl a CROSS JOIN LATERAL aclexplode(a.defaclacl) x
    WHERE x.grantee IN((SELECT oid FROM pg_roles WHERE rolname='swat_auth_owner'),(SELECT oid FROM pg_roles WHERE rolname='swat_auth_service'))`);
  if(defaults.length) throw new Error('Auth unexpected default ACL authority');
  const {rows:inherited}=await client.query(`SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    CROSS JOIN LATERAL (
      SELECT x.* FROM aclexplode(c.relacl) x
      UNION ALL SELECT x.* FROM pg_attribute at CROSS JOIN LATERAL aclexplode(at.attacl) x
        WHERE at.attrelid=c.oid AND at.attnum>0 AND NOT at.attisdropped
    ) a WHERE a.grantee=0 AND n.nspname NOT IN('pg_catalog','information_schema')`);
  if(inherited.length) throw new Error('Auth inherited PUBLIC relation/sequence authority');
  // No inherited PUBLIC definer authority or direct public-schema EXECUTE on another
  // routine for the auth service/owner (pg_catalog primitives are intentionally available).
  const { rows: extra } = await client.query(`SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
    WHERE n.nspname NOT IN('pg_catalog','information_schema') AND p.oid<>ALL($1::regprocedure[])
      AND a.grantee IN(0,(SELECT oid FROM pg_roles WHERE rolname='swat_auth_service'),(SELECT oid FROM pg_roles WHERE rolname='swat_auth_owner'))`,
      [[...AUTH_FUNCTION_SIGNATURES,...(phase!=='inert'?['public.citext_cmp(public.citext,public.citext)','public.citext_eq(public.citext,public.citext)']:[])]]);
  if (extra.length) throw new Error('Auth unreviewed inherited/direct routine authority');
}
export async function validateCommittedAuthenticationCatalog(input: {
  client: AuthQueryClient; dbaRole: string; installedSql: string; phase: AuthCatalogPhase
}): Promise<void> {
  const expected = pins(input.installedSql);
  if (!['inert','disabled','active'].includes(input.phase)) throw new Error('Auth catalog phase required');
  await dba(input.client,input.dbaRole);
  await input.client.query("SELECT set_config('search_path','pg_catalog',true)");
  await roles(input.client,input.phase);
  await functions(input.client,expected,input.phase);
  await validateAuthPolicyClosure(input.client);
  await validateAuthRelations(input.client,input.phase);
  await catalog(input.client,input.phase);
}

/** Owned read-only catalog acceptance gate AFTER inert or handoff COMMIT. */
export async function validateAuthenticationInstallation(input: {
 acquire:()=>Promise<AuthClientLease>;dbaRole:string;installedSql:string;phase:AuthCatalogPhase
}):Promise<void> {
 pins(input.installedSql);
 const lease=await input.acquire();let open=false,committing=false,broken=false;
 try {
  const backend=await dba(lease.client,input.dbaRole,true);
  const b=await lease.client.query('BEGIN READ ONLY');if(b.command!=='BEGIN')throw new Error('Auth catalog BEGIN refused');open=true;
  await lease.client.query("SELECT set_config('statement_timeout','15000',true),set_config('lock_timeout','5000',true),set_config('idle_in_transaction_session_timeout','30000',true)");
  await validateCommittedAuthenticationCatalog({...input,client:lease.client});
  if(await dba(lease.client,input.dbaRole)!==backend)throw new Error('Auth catalog backend changed');
  committing=true;const c=await lease.client.query('COMMIT');if(c.command!=='COMMIT')throw new Error('Auth catalog COMMIT uncertain');
  open=false;committing=false;
 }catch(e){broken=true;if(open&&!committing){try{await lease.client.query('ROLLBACK');}catch{}}throw e;}
 finally{lease.release(open||broken);}
}

/** Sole executable privileged handoff. No caller SQL, role-membership shortcut or broker
 * extension. Uncertain COMMIT discards the lease and never claims a rollback. */
export async function provisionCommittedAuthentication(input: {
  acquire: () => Promise<AuthClientLease>; dbaRole: string; installedSql: string
}): Promise<void> {
  const expected = pins(input.installedSql);
  if (typeof input.acquire !== 'function') throw new Error('Owned external DBA lease required');
  const lease = await input.acquire();
  let open=false, committing=false, broken=false;
  try {
    const backend=await dba(lease.client,input.dbaRole,true);
    const begin=await lease.client.query('BEGIN');
    if (begin.command!=='BEGIN') throw new Error('Auth DBA BEGIN refused');
    open=true;
    await lease.client.query("SELECT set_config('statement_timeout','15000',true),set_config('lock_timeout','5000',true),set_config('idle_in_transaction_session_timeout','30000',true)");
    await lease.client.query('LOCK TABLE public.users,public.user_sessions,public.user_auth_wallets,public.auth_wallet_proofs,public.audit_log IN ACCESS EXCLUSIVE MODE');
    await lease.client.query(`DO $$ BEGIN
      IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='swat_auth_owner') THEN
        CREATE ROLE swat_auth_owner NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEROLE NOCREATEDB NOREPLICATION;
      END IF;
      IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='swat_auth_service') THEN
        CREATE ROLE swat_auth_service NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEROLE NOCREATEDB NOREPLICATION;
      END IF;
    END $$`);
    await validateCommittedAuthenticationCatalog({client:lease.client,dbaRole:input.dbaRole,installedSql:input.installedSql,phase:'inert'});
    await lease.client.query('ALTER ROLE swat_auth_owner SET row_security=on');
    await lease.client.query('ALTER ROLE swat_auth_owner SET search_path=pg_catalog');
    await lease.client.query('ALTER ROLE swat_auth_service SET row_security=on');
    await lease.client.query('ALTER ROLE swat_auth_service SET search_path=pg_catalog');
    await lease.client.query('REVOKE ALL ON FUNCTION pg_catalog.pg_control_system() FROM swat_auth_owner,swat_auth_service');
    await lease.client.query('GRANT USAGE ON SCHEMA public TO swat_auth_owner,swat_auth_service');
    // Narrow reviewed C extension support required by users.email uniqueness/index
    // comparison. Not policy bypass, SECURITY DEFINER authority, or broker transfer.
    await lease.client.query('GRANT EXECUTE ON FUNCTION public.citext_cmp(public.citext,public.citext),public.citext_eq(public.citext,public.citext) TO swat_auth_owner');
    // PostgreSQL requires destination CREATE for ALTER FUNCTION OWNER. Superuser direct
    // handoff needs no membership; temporary CREATE exists only inside this transaction.
    await lease.client.query('GRANT CREATE ON SCHEMA public TO swat_auth_owner');
    for (const p of expected) {
      await lease.client.query(`ALTER FUNCTION ${p.signature} OWNER TO swat_auth_owner`);
      await lease.client.query(`REVOKE ALL ON FUNCTION ${p.signature} FROM PUBLIC,swat_app,swat_auth_service,swat_migrator`);
      if (!internal.has(p.name)) await lease.client.query(`GRANT EXECUTE ON FUNCTION ${p.signature} TO swat_auth_service`);
    }
    await lease.client.query('REVOKE CREATE ON SCHEMA public FROM swat_auth_owner');
    for (const table of relations) {
      for (const privilege of ownerTable[table] ?? []) await lease.client.query(`GRANT ${privilege} ON public.${table} TO swat_auth_owner`);
      for (const [privilege,columns] of Object.entries(ownerColumns[table] ?? {}))
        await lease.client.query(`GRANT ${privilege}(${columns.join(',')}) ON public.${table} TO swat_auth_owner`);
      if (table!=='audit_log') await lease.client.query(`CREATE POLICY auth087_owner ON public.${table} TO swat_auth_owner
        USING(current_user='swat_auth_owner'::name) WITH CHECK(current_user='swat_auth_owner'::name)`);
    }
    await lease.client.query('GRANT USAGE ON SEQUENCE public.audit_log_id_seq TO swat_auth_owner');
    await validateCommittedAuthenticationCatalog({client:lease.client,dbaRole:input.dbaRole,installedSql:input.installedSql,phase:'disabled'});
    if (await dba(lease.client,input.dbaRole)!==backend) throw new Error('Auth DBA backend drift');
    committing=true;
    const commit=await lease.client.query('COMMIT');
    if (commit.command!=='COMMIT') throw new Error('Auth DBA COMMIT uncertain');
    committing=false; open=false;
  } catch(error) {
    broken=true;
    if (committing) throw new Error('Auth DBA COMMIT uncertain; externally reconcile catalog on new owned lease');
    if(open) { try { const r=await lease.client.query('ROLLBACK'); if(r.command==='ROLLBACK') open=false; } catch { /* uncertain, no rollback claim */ } }
    throw error;
  } finally { lease.release(broken||open); }
}
