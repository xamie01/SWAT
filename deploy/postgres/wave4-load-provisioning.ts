import type { PoolClient } from '../../packages/db/src/copy-trade-lifecycle-owned.js';

/** FROZEN source-only handoff inventory, NOT a migration selector/installer.
 * The frozen 090 source has unresolved authorization/locking seams. This module
 * cannot turn a manifest, role name, catalog callback or client into approval.
 * No body hash was computed; no SQL source parser or runtime installer is used. */
export const WAVE4_LOAD_PROVISIONING_STATUS = Object.freeze({ frozen: true, reviewed: false,
  installable: false, installed: false, sourceComplete: false, runtimeAccepted: false,
  liveCapabilityAccepted: false, productionReady: false } as const);
export const WAVE4_LOAD_DISABLED_ROLES = Object.freeze([
  'swat_load_capture_owner', 'swat_load_http_writer', 'swat_load_observer'
] as const);
export const WAVE4_LOAD_ROLE_REQUIREMENTS = Object.freeze({ login: false, superuser: false,
  bypassRls: false, inherit: false, createRole: false, createDb: false, replication: false,
  memberships: Object.freeze([]), databaseOwnership: false, schemaOwnership: false,
  relationOwnership: false, effectiveCreate: false, defaultAclAuthority: false,
  roleSettings: Object.freeze(['row_security=on','search_path=pg_catalog']),
  passwordProvisioned: false, activation: 'separate independently approved expiring lifecycle only'
} as const);

function routine(signature: string, argumentNames: readonly string[], result: string,
  language: 'plpgsql' | 'sql', definer: boolean, transfer: boolean, callers: readonly string[]) {
  return Object.freeze({ signature, argumentNames: Object.freeze([...argumentNames]), result, language, definer, transfer,
    callers: Object.freeze([...callers]), ownerInert: 'swat_migrator',
    ownerDisabled: transfer ? 'swat_load_capture_owner' : 'swat_migrator',
    searchPath: 'pg_catalog', setReturning: false, strict: false, leakproof: false,
    volatile: 'v', parallel: 'u', argumentDefaults: 0, grantOption: false } as const);
}
/** ALL fifteen real SQL090 routines; eleven owner transfers, four invoker guards
 * retained by migrator. Signatures are regprocedure identities, not invented
 * wave4_direct090/lookup APIs. Internal helpers never receive runtime EXECUTE.
 * The validator's swat_fanout edge is REQUIRED by the actual invoker deferred
 * trigger, but remains unprovisioned pending exact reviewed closure. */
export const WAVE4_LOAD_ROUTINES = Object.freeze([
  routine('wave4_load.guard_history()', [], 'trigger', 'plpgsql', false, false, []),
  routine('wave4_load.guard_approval()', [], 'trigger', 'plpgsql', false, false, []),
  routine('wave4_load.guard_fixture()', [], 'trigger', 'plpgsql', false, false, []),
  routine('wave4_load.approved(uuid,uuid,text)', ['rid','fid','requested_stage'], 'jsonb', 'plpgsql', false, true, []),
  routine('wave4_load.http_admit(bytea,jsonb)', ['token_digest','payload'], 'jsonb', 'plpgsql', true, true, ['swat_load_http_writer']),
  routine('wave4_load.http_finish(uuid,integer,text)', ['aid','http_status','refusal'], 'jsonb', 'plpgsql', true, true, ['swat_load_http_writer']),
  routine('wave4_load.assert_invocation(jsonb)', ['payload'], 'jsonb', 'plpgsql', true, true,
    ['swat_source_provider_writer','swat_fanout','swat_app']),
  routine('wave4_load.bind_canonical(jsonb)', ['payload'], 'jsonb', 'plpgsql', true, true, ['swat_fanout']),
  routine('wave4_load.check_canonical_commit()', [], 'trigger', 'plpgsql', false, false, []),
  routine('wave4_load.validate_canonical(uuid,uuid,boolean)', ['rid','fid','require_original_xid'], 'void', 'plpgsql', true, true, ['swat_fanout']),
  routine('wave4_load.export_capture(uuid)', ['rid'], 'jsonb', 'plpgsql', true, true, ['swat_load_observer']),
  routine('wave4_load.visible_capture(uuid,uuid)', ['rid','fid'], 'boolean', 'sql', false, true, []),
  routine('wave4_load.visible_user(uuid)', ['uid'], 'boolean', 'sql', false, true, []),
  routine('wave4_load.visible_asset(text)', ['mint'], 'boolean', 'sql', false, true, []),
  routine('wave4_load.export_economics(uuid)', ['rid'], 'jsonb', 'plpgsql', true, true, ['swat_load_observer'])
]);
export const WAVE4_LOAD_FUNCTION_SIGNATURES = Object.freeze(WAVE4_LOAD_ROUTINES.map(r => r.signature));
export const WAVE4_LOAD_OWNER_TRANSFERS = Object.freeze(WAVE4_LOAD_ROUTINES.filter(r => r.transfer).map(r => r.signature));

function relation(name: string, columns: readonly string[], insert: boolean, lockColumn: string | null = null) {
  return Object.freeze({ name: `wave4_load.${name}`, columns: Object.freeze([...columns]), owner: 'swat_migrator',
    forceRls: true, ownerSelect: true, ownerInsert: insert, ownerUpdateColumns: Object.freeze(lockColumn ? [lockColumn] : []),
    ownerDelete: false, runtimeTablePrivileges: Object.freeze([]), runtimeColumnPrivileges: Object.freeze([]),
    // No observer, HTTP, source, fanout or app SELECT/DML, even to capture tables.
    enrollment: insert ? 'protected fixed routines only; append-only guard rejects every UPDATE/DELETE'
      : 'independent direct external non-swat DBA only; no runtime enrollment'
  } as const);
}
export const WAVE4_LOAD_CAPTURE_RELATIONS = Object.freeze([
  relation('runs', ['run_id','namespace','network','backend_identity','valid_from','expires_at','revoked_at','enrolled_by','enrolled_at','revoked_by'], false),
  relation('fixtures', ['run_id','fixture_id','user_id','document','request_digest','request_canonical','method','route','body','token_mint','wallet_address','target_account','binding'], false),
  relation('approvals', ['approval_id','run_id','fixture_id','stage','runtime_role','database_oid','server_address','server_port','backend_identity','revision','provider','sizing','valuation','valid_from','expires_at','revoked_at','enrolled_by','enrolled_at','revoked_by'], false),
  relation('requests', ['attempt_id','run_id','fixture_id','user_id','request_digest','namespace','network','backend_identity','method','route','body','principal_kind','principal_user_id','session_id','http_approval_id','started_at'], true, 'attempt_id'),
  relation('responses', ['attempt_id','status','finished_at'], true),
  relation('stage_claims', ['attempt_id','stage','approval_id','claimed_at'], true),
  relation('canonical', ['run_id','fixture_id','user_id','original_attempt_id','source_trade_id','signal_id','execution_id','job_id','admitted_at','admission_xid'], true),
  relation('outcomes', ['attempt_id','run_id','fixture_id','user_id','outcome','reason','source_trade_id','signal_id','execution_id','job_id','admitted_at'], true)
]);
function foreignKey(from: string, columns: readonly string[], to: string, referenced: readonly string[], deferred = false) {
  return Object.freeze({ from, columns: Object.freeze([...columns]), to, referenced: Object.freeze([...referenced]),
    onDelete: 'RESTRICT', onUpdate: 'NO ACTION', match: 'SIMPLE', validated: true,
    deferrable: deferred, initiallyDeferred: deferred } as const);
}
/** Complete outgoing SQL090 FK shapes. Any additional incoming/touching FK also
 * requires independent review; matching only one expected FK is not acceptance. */
export const WAVE4_LOAD_FOREIGN_KEYS = Object.freeze([
  foreignKey('wave4_load.fixtures',['run_id'],'wave4_load.runs',['run_id']),
  foreignKey('wave4_load.fixtures',['user_id'],'public.users',['id']),
  foreignKey('wave4_load.approvals',['run_id','fixture_id'],'wave4_load.fixtures',['run_id','fixture_id']),
  foreignKey('wave4_load.requests',['principal_user_id'],'public.users',['id']),
  foreignKey('wave4_load.requests',['session_id'],'public.user_sessions',['id']),
  foreignKey('wave4_load.requests',['http_approval_id'],'wave4_load.approvals',['approval_id']),
  foreignKey('wave4_load.requests',['run_id','fixture_id','user_id','request_digest'],'wave4_load.fixtures',['run_id','fixture_id','user_id','request_digest']),
  foreignKey('wave4_load.responses',['attempt_id'],'wave4_load.requests',['attempt_id']),
  foreignKey('wave4_load.stage_claims',['attempt_id'],'wave4_load.requests',['attempt_id']),
  foreignKey('wave4_load.stage_claims',['approval_id'],'wave4_load.approvals',['approval_id']),
  foreignKey('wave4_load.canonical',['original_attempt_id'],'wave4_load.requests',['attempt_id']),
  foreignKey('wave4_load.canonical',['source_trade_id'],'public.source_trades',['id']),
  foreignKey('wave4_load.canonical',['execution_id'],'public.copy_executions',['id']),
  foreignKey('wave4_load.canonical',['original_attempt_id','run_id','fixture_id','user_id'],'wave4_load.requests',['attempt_id','run_id','fixture_id','user_id']),
  foreignKey('wave4_load.canonical',['signal_id','source_trade_id'],'public.signals',['id','source_trade_id']),
  foreignKey('wave4_load.canonical',['signal_id','job_id'],'public.source_fanout_deliveries',['signal_id','job_id'],true),
  foreignKey('wave4_load.outcomes',['attempt_id','run_id','fixture_id','user_id'],'wave4_load.requests',['attempt_id','run_id','fixture_id','user_id']),
  foreignKey('wave4_load.outcomes',['run_id','fixture_id','user_id','source_trade_id','signal_id','execution_id','job_id'],
    'wave4_load.canonical',['run_id','fixture_id','user_id','source_trade_id','signal_id','execution_id','job_id'])
]);
export const WAVE4_LOAD_DEFERRED_COMMIT = Object.freeze({ name: 'load_canonical_commit', relation: 'wave4_load.canonical',
  event: 'AFTER INSERT', deferrable: true, initiallyDeferred: true, forEach: 'ROW',
  invoker: 'wave4_load.check_canonical_commit()', validator: 'wave4_load.validate_canonical(uuid,uuid,boolean)',
  originalXid: 'admission_xid = pg_current_xact_id()', sameXidRows: Object.freeze(['execution','delivery','policy']),
  deliveryKey: Object.freeze(['signal_id','job_id']), immediateValidation: false } as const);

/** Required READ edges for the distinct NOLOGIN owner, never grants to observer
 * or runtime roles. All policy strategies are UNINSTALLED review obligations.
 * Whole-row edges are dictated by actual SQL090 composite SELECT */
function readEdge(relationName: string, scope: string, columns: readonly string[] = ['*']) {
  return Object.freeze({ relation: relationName, role: 'swat_load_capture_owner', privilege: 'SELECT',
    columns: Object.freeze([...columns]), scope, grantOption: false, installed: false } as const);
}
export const WAVE4_LOAD_OWNER_READ_INVENTORY = Object.freeze([
  readEdge('public.users','HTTP-only wave4_load.visible_user(id); exact active persisted fixture principal', ['id','status']),
  readEdge('public.user_sessions','HTTP-only wave4_load.visible_user(user_id); exact SQL040 token digest/session owner',
    ['id','user_id','token_hash','revoked_at','expires_at','issued_at','last_seen_at']),
  readEdge('public.pipeline_backend_approvals','exact current session/backend, stage/purpose, approved provider and run network; no global USING(true)'),
  readEdge('public.source_provider_authorities','exact approved provider/authority plus run network and chain; no asset-free global authority visibility'),
  readEdge('public.pipeline_follower_authorities','exact approved sizing authority joined to enrolled fixture user/asset/network'),
  readEdge('public.pipeline_exact_follower_evidence','exact fixture user/chain/target/token/paper and approved sizing authority; include newest competing evidence'),
  readEdge('public.worker_runtime_capabilities','exact enrolled fixture canonical execution/user/worker backend'),
  readEdge('public.worker_valuation_authorities','exact fixture user/network/chain plus approved valuation identity'),
  readEdge('public.source_trades','wave4_load.visible_asset(token_mint); namespace orphan coverage also requires separate exact scope review'),
  readEdge('public.signals','enrolled asset and SQL030 id/source_trade_id join'),
  readEdge('public.source_verification_bindings','exact enrolled source via source_trade_id'),
  readEdge('public.source_verification_heads','exact enrolled source via source_trade_id'),
  readEdge('public.source_verified_evidence','exact enrolled source via source_trade_id; SQL077 current head/proof'),
  readEdge('public.source_position_applications','wave4_load.visible_asset(token_mint); SQL028 source_trade_id application'),
  readEdge('public.copy_executions','wave4_load.visible_asset(token_mint); include extra tenants and orphan rows on enrolled assets'),
  readEdge('public.copy_execution_policy_snapshots','exact enrolled execution and immutable user/asset/paper policy'),
  readEdge('public.source_fanout_batches','exact enrolled source/signal; complete cohort'),
  readEdge('public.source_fanout_deliveries','SQL071 signal/job, execution/user/target/paper; include enrolled descriptor-token orphans'),
  readEdge('public.copy_execution_worker_attempts','exact enrolled execution'),
  readEdge('public.worker_effective_execution_evidence','security_invoker view: BOTH underlying evidence and correction scoped reads required'),
  readEdge('public.copy_execution_evidence','underlying SQL080 invoker view, exact enrolled execution'),
  readEdge('public.copy_execution_valuation_corrections','underlying SQL080 invoker view, exact enrolled execution'),
  readEdge('public.trades','wave4_load.visible_asset(token_mint) or exact enrolled execution'),
  readEdge('public.copy_execution_financial_receipts','exact enrolled execution; stored immutable snapshot, not worker callback'),
  readEdge('public.copy_position_applications','wave4_load.visible_asset(token_mint) or exact enrolled execution'),
  readEdge('public.copy_positions','wave4_load.visible_asset(token_mint)'),
  readEdge('public.copy_position_master_lots','wave4_load.visible_asset(token_mint) or exact acquisition execution'),
  readEdge('public.risk_spend_reservations','exact enrolled execution'),
  readEdge('public.master_capacity_ledger','wave4_load.visible_asset(token_mint) or exact enrolled source'),
  readEdge('public.copy_position_master_lot_reductions','exact enrolled sell execution or enrolled lot')
]);
export const WAVE4_LOAD_PROVISIONING_BLOCKERS = Object.freeze([
  'Independent exact frozen SQL090 body/source pin and all routine catalog options/ACL/default-ACL/policy/trigger/constraint/index/incoming-FK closure are not established. This inventory is not an installer allowlist or catalog acceptance.',
  'Three new roles must remain NOLOGIN/password-free/no-membership/nonowning; existing direct source/fanout/app LOGIN lifecycle and credentials are independently controlled, never altered here.',
  'HTTP FOR UPDATE of users and sessions requires UPDATE on a column. No safe lock-only guard/ACL for this new owner exists in frozen SQL090; granting UPDATE(id) would also authorize actual mutation. Provisioning must refuse, not grant it.',
  'requests FOR UPDATE requires owner UPDATE(attempt_id), protected by guard_history rejecting all UPDATE. No canonical public UPDATE/INSERT/DELETE/TRUNCATE/REFERENCES/TRIGGER is allowed.',
  'Deferred migrator-owned invoker check_canonical_commit calls owner-defined validate_canonical at runtime COMMIT. Its exact swat_fanout EXECUTE edge and owner role/ACL checks remain unreviewed.',
  'All owner read edges need exact scoped policies; registry predicates cannot use broad USING(true). visible_asset token-only scope cannot silently hide namespace-only source or descriptor-token delivery orphans.',
  'SQL080 worker_effective_execution_evidence is security_invoker=true, not an RLS table. Underlying evidence/correction SELECT and asset/execution policy closure are mandatory; no ALTER VIEW FORCE RLS invented.',
  'Fresh protected backend/provider/sizing/valuation approval, post-lock expiry, source acceptance chronology and enrollment revocation concurrency need frozen-source repair/review outside this exclusive scope.',
  'Capture export includes unfinished/outcome-less requests; completion must refuse missing responses/outcomes rather than synthesize refused/admitted records.',
  'SQL088 known paused draft issues, SQL089 integration, migration selection/install, route authentication, contained consumer composition, worker capability lifecycle and scoped observer authorization remain unavailable.',
  'No shared lookup-owner expansion, SQL084 selection, additional seven079082 broker transfers, pg_read_all_stats, observer table grants, runtime ownership, memberships or SET ROLE.'
] as const);

/** Explicitly callable refusal, with NO queries/DDL, even for a supplied DBA
 * client. The client's existence is not permission and there is no approved=true
 * parameter/callback to bypass unresolved source seams. This never opens a pool,
 * creates/disables/activates roles, seeds approvals or installs any SQL. */
export async function provisionWave4LoadCaptureWithClient(client: PoolClient): Promise<never> {
  if (!client || typeof client.query !== 'function') throw new Error('090 mandatory separately owned DBA client required');
  throw new Error('090 FROZEN provisioning refused: unresolved HTTP lock-only ACL, exact catalog/RLS and deferred-validator closure');
}

export interface LoadProvisioningQueryClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: unknown[]
  ): Promise<{ rows: T[]; command?: string; rowCount?: number | null }>;
}

export interface LoadProvisioningClientLease {
  readonly dbConn: LoadProvisioningQueryClient;
  release(broken: boolean): void;
}

export type Wave4LoadCatalogPhase = 'inert' | 'disabled-handoff';

export class Wave4LoadCommitUncertainError extends Error {
  constructor(message = 'Wave4 load DBA COMMIT uncertain; discard lease and reconcile externally') {
    super(message);
    this.name = 'Wave4LoadCommitUncertainError';
  }
}

const VALID_LOAD_ROLE_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;

function assertValidLoadRoleName(role: string, kind: 'dba' | 'migrator' | 'restricted'): void {
  if (typeof role !== 'string' || !VALID_LOAD_ROLE_PATTERN.test(role)) {
    throw new Error('090 invalid direct role identifier');
  }
  if (kind === 'dba' && role.startsWith('swat_')) {
    throw new Error('090 distinct direct external DBA identity required');
  }
  if (kind === 'migrator' && role !== 'swat_migrator') {
    throw new Error('090 direct swat_migrator identity required');
  }
  if (kind === 'restricted' && (!role.startsWith('swat_') || role === 'swat_migrator')) {
    throw new Error('090 restricted swat_* identity required');
  }
}

export async function assertWave4LoadRoleWithClient(
  dbConn: LoadProvisioningQueryClient,
  role: string,
  kind: 'dba' | 'migrator' | 'restricted',
  clean = false
): Promise<number> {
  if (!dbConn || typeof dbConn.query !== 'function') {
    throw new Error('090 query connection required');
  }
  assertValidLoadRoleName(role, kind);
  const { rows } = await dbConn.query<{
    current_role: unknown;
    session_role: unknown;
    role_setting: unknown;
    row_security: unknown;
    backend: unknown;
    superuser: unknown;
    can_login: unknown;
    bypass_rls?: unknown;
    inherit?: unknown;
    create_role?: unknown;
    create_db?: unknown;
    replication?: unknown;
    has_memberships: unknown;
    transaction_clean: unknown;
  }>(`SELECT current_user AS current_role, session_user AS session_role,
    current_setting('role') AS role_setting, current_setting('row_security') AS row_security,
    pg_backend_pid() AS backend, r.rolsuper AS superuser, r.rolcanlogin AS can_login,
    r.rolbypassrls AS bypass_rls, r.rolinherit AS inherit, r.rolcreaterole AS create_role,
    r.rolcreatedb AS create_db, r.rolreplication AS replication,
    EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid) AS has_memberships,
    (SELECT xact_start=query_start FROM pg_catalog.pg_stat_activity WHERE pid=pg_backend_pid()) AS transaction_clean
    FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`);
  const r = rows[0];
  if (
    rows.length !== 1 || !r
    || r.current_role !== role
    || r.session_role !== role
    || r.role_setting !== 'none'
    || r.row_security !== 'on'
    || r.has_memberships !== false
    || typeof r.backend !== 'number' || !Number.isInteger(r.backend) || r.backend <= 0
    || (clean && r.transaction_clean !== true)
  ) {
    throw new Error('090 direct role identity/session/RLS/membership/transaction check failed');
  }
  if (kind === 'dba') {
    if (r.superuser !== true) {
      throw new Error('090 authenticated direct external superuser DBA backend required');
    }
  } else {
    if (
      r.superuser !== false || r.bypass_rls !== false || r.inherit !== false
      || r.create_role !== false || r.create_db !== false || r.replication !== false
    ) {
      throw new Error('090 restricted role privilege escalation rejected');
    }
  }
  return r.backend;
}

export async function validateWave4LoadCommittedCatalog(input: {
  dbConn: LoadProvisioningQueryClient;
  dbaRole: string;
  phase: Wave4LoadCatalogPhase;
}): Promise<void> {
  if (input.phase !== 'inert' && input.phase !== 'disabled-handoff') {
    throw new Error('090 catalog phase required');
  }
  await assertWave4LoadRoleWithClient(input.dbConn, input.dbaRole, 'dba');
  await input.dbConn.query("SELECT set_config('search_path','pg_catalog',true)");

  const roleNames = [...WAVE4_LOAD_DISABLED_ROLES];
  const { rows: roleRows } = await input.dbConn.query<{
    rolname: string;
    rolcanlogin: boolean;
    unsafe: boolean;
    membership: boolean;
    owns: boolean;
    can_create: boolean;
    functions: string[];
    extra_ownership: boolean;
  }>(`SELECT r.rolname, r.rolcanlogin,
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
        AND d.objsubid=0 AND d.objid=ANY($2::regprocedure[]))) AS extra_ownership
    FROM pg_catalog.pg_roles r WHERE r.rolname = ANY($1::text[])`, [roleNames, [...WAVE4_LOAD_OWNER_TRANSFERS]]);

  if (input.phase === 'disabled-handoff') {
    for (const name of roleNames) {
      if (!roleRows.some(r => r.rolname === name)) {
        throw new Error(`090 required disabled role missing: ${name}`);
      }
    }
  }
  const expectedOwnerTransfers = input.phase === 'inert' ? [] : [...WAVE4_LOAD_OWNER_TRANSFERS].sort();
  for (const r of roleRows) {
    const expectedFuncs = r.rolname === 'swat_load_capture_owner' ? expectedOwnerTransfers : [];
    if (
      !(roleNames as readonly string[]).includes(r.rolname)
      || r.rolcanlogin !== false || r.unsafe !== false || r.membership !== false
      || r.owns !== false || r.extra_ownership !== false || r.can_create !== false
      || !Array.isArray(r.functions)
      || JSON.stringify([...r.functions].sort()) !== JSON.stringify(expectedFuncs)
    ) {
      throw new Error(`090 role flags/ownership/CREATE/membership drift: ${r.rolname}`);
    }
  }

  const { rows: settings } = await input.dbConn.query<{
    rolname: string;
    setdatabase: unknown;
    setconfig: unknown;
  }>(`SELECT r.rolname, s.setdatabase, s.setconfig FROM pg_catalog.pg_db_role_setting s
    JOIN pg_catalog.pg_roles r ON r.oid = s.setrole WHERE r.rolname = ANY($1::text[])`, [roleNames]);
  const allowedSettings = ['row_security=on', 'search_path=pg_catalog', 'search_path=pg_catalog, public'];
  for (const s of settings) {
    if (Number(s.setdatabase) !== 0 || !Array.isArray(s.setconfig) || s.setconfig.some(v => typeof v !== 'string' || !allowedSettings.includes(v))) {
      throw new Error(`090 role GUC settings drift: ${s.rolname}`);
    }
  }
  if (input.phase === 'disabled-handoff') {
    for (const name of roleNames) {
      const setting = settings.find(s => s.rolname === name);
      if (
        !setting || !Array.isArray(setting.setconfig)
        || !setting.setconfig.includes('row_security=on')
        || !setting.setconfig.includes('search_path=pg_catalog')
      ) {
        throw new Error(`090 disabled role GUC defaults missing: ${name}`);
      }
    }
  }

  const { rows: nsRows } = await input.dbConn.query<{
    nspname: string;
    owner: string;
    restricted_or_public_create: boolean;
  }>(`SELECT n.nspname, r.rolname AS owner,
    (has_schema_privilege('public', n.oid, 'CREATE')
     OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles x WHERE x.rolname = ANY($1::text[]) AND has_schema_privilege(x.oid, n.oid, 'CREATE'))) AS restricted_or_public_create
    FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_roles r ON r.oid = n.nspowner
    WHERE n.nspname = 'wave4_load'`, [roleNames]);
  if (nsRows.length !== 1 || nsRows[0]!.owner !== 'swat_migrator' || nsRows[0]!.restricted_or_public_create !== false) {
    throw new Error('090 wave4_load namespace ownership or CREATE privilege drift');
  }

  const relationNames = WAVE4_LOAD_CAPTURE_RELATIONS.map(r => r.name);
  const { rows: relRows } = await input.dbConn.query<{
    relation: string;
    owner: string;
    relkind: string;
    relrowsecurity: boolean;
    relforcerowsecurity: boolean;
    public_or_grantable_acl: boolean;
  }>(`SELECT ('wave4_load.' || c.relname) AS relation, r.rolname AS owner, c.relkind, c.relrowsecurity, c.relforcerowsecurity,
    (EXISTS(SELECT 1 FROM aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a WHERE a.grantee = 0 OR a.is_grantable)
     OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute at CROSS JOIN LATERAL aclexplode(at.attacl) a
       WHERE at.attrelid = c.oid AND at.attnum > 0 AND NOT at.attisdropped AND (a.grantee = 0 OR a.is_grantable))) AS public_or_grantable_acl
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_roles r ON r.oid = c.relowner
    WHERE c.oid = ANY($1::regclass[])`, [relationNames]);
  if (relRows.length !== relationNames.length) {
    throw new Error('090 relation inventory missing');
  }
  for (const name of relationNames) {
    const actual = relRows.find(r => r.relation === name);
    if (
      !actual || actual.owner !== 'swat_migrator' || actual.relkind !== 'r'
      || actual.relrowsecurity !== true || actual.relforcerowsecurity !== true
      || actual.public_or_grantable_acl !== false
    ) {
      throw new Error(`090 relation FORCE RLS/ownership/ACL drift: ${name}`);
    }
  }

  const { rows: lockOnlyRows } = await input.dbConn.query<{
    owner_users_update: boolean;
    owner_sessions_update: boolean;
    owner_col_update: boolean;
  }>(`SELECT
    (has_table_privilege('PUBLIC', 'public.users', 'UPDATE')
     OR CASE WHEN EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'swat_load_capture_owner')
       THEN has_table_privilege('swat_load_capture_owner', 'public.users', 'UPDATE')
       ELSE false END) AS owner_users_update,
    (has_table_privilege('PUBLIC', 'public.user_sessions', 'UPDATE')
     OR CASE WHEN EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'swat_load_capture_owner')
       THEN has_table_privilege('swat_load_capture_owner', 'public.user_sessions', 'UPDATE')
       ELSE false END) AS owner_sessions_update,
    EXISTS(SELECT 1 FROM pg_catalog.pg_attribute at CROSS JOIN LATERAL aclexplode(at.attacl) a
      JOIN pg_catalog.pg_roles r ON r.oid = a.grantee
      WHERE at.attrelid IN ('public.users'::regclass, 'public.user_sessions'::regclass)
        AND at.attnum > 0 AND NOT at.attisdropped
        AND r.rolname = 'swat_load_capture_owner' AND a.privilege_type = 'UPDATE') AS owner_col_update`);
  if (
    lockOnlyRows.length !== 1
    || lockOnlyRows[0]!.owner_users_update !== false
    || lockOnlyRows[0]!.owner_sessions_update !== false
    || lockOnlyRows[0]!.owner_col_update !== false
  ) {
    throw new Error('090 forbidden UPDATE privilege on public.users or public.user_sessions detected');
  }

  const { rows: procRows } = await input.dbConn.query<{
    signature: string;
    owner: string;
    prokind: string;
    prosecdef: boolean;
    proisstrict: boolean;
    proleakproof: boolean;
    provolatile: string;
    proparallel: string;
    pronargdefaults: number;
    proconfig: unknown;
    lanname: string;
    acl: { grantor: string; grantee: string; privilege: string; grantable: boolean }[] | null;
  }>(`SELECT p.oid::regprocedure::text AS signature, r.rolname AS owner, p.prokind, p.prosecdef,
    p.proisstrict, p.proleakproof, p.provolatile, p.proparallel, p.pronargdefaults, p.proconfig, l.lanname,
    (SELECT jsonb_agg(jsonb_build_object('grantor', g.rolname, 'grantee', COALESCE(a0.rolname, 'PUBLIC'),
      'privilege', a.privilege_type, 'grantable', a.is_grantable) ORDER BY COALESCE(a0.rolname, 'PUBLIC'))
     FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
     LEFT JOIN pg_catalog.pg_roles g ON g.oid = a.grantor
     LEFT JOIN pg_catalog.pg_roles a0 ON a0.oid = a.grantee) AS acl
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
    JOIN pg_catalog.pg_language l ON l.oid = p.prolang
    WHERE p.oid = ANY($1::regprocedure[])`, [[...WAVE4_LOAD_FUNCTION_SIGNATURES]]);
  if (procRows.length !== WAVE4_LOAD_ROUTINES.length) {
    throw new Error('090 routine catalog inventory missing');
  }
  for (const expected of WAVE4_LOAD_ROUTINES) {
    const actual = procRows.find(r => r.signature === expected.signature);
    const expectedOwner = input.phase === 'inert' ? expected.ownerInert : expected.ownerDisabled;
    const expectedGrantees = input.phase === 'inert'
      ? [expectedOwner]
      : [expectedOwner, ...expected.callers].sort();
    if (
      !actual || actual.owner !== expectedOwner || actual.prokind !== 'f'
      || actual.prosecdef !== expected.definer || actual.proisstrict !== false || actual.proleakproof !== false
      || actual.provolatile !== 'v' || actual.proparallel !== 'u'
      || actual.pronargdefaults !== 0 || actual.lanname !== expected.language
      || JSON.stringify(actual.proconfig) !== JSON.stringify(['search_path=pg_catalog'])
      || !Array.isArray(actual.acl)
      || actual.acl.some(a => typeof a?.grantee !== 'string' || a.grantee === 'PUBLIC' || a.grantable !== false || a.privilege !== 'EXECUTE' || a.grantor !== expectedOwner)
      || JSON.stringify(actual.acl.map(a => a.grantee).sort()) !== JSON.stringify(expectedGrantees)
    ) {
      throw new Error(`090 routine catalog owner/options/ACL drift: ${expected.signature}`);
    }
  }

  const { rows: policyRows } = await input.dbConn.query<{
    relation: string;
    polname: string;
    polpermissive: boolean;
    roles: string[];
    using_expr: string | null;
    check_expr: string | null;
  }>(`SELECT ('wave4_load.' || c.relname) AS relation, p.polname, p.polpermissive,
    ARRAY(SELECT COALESCE(r0.rolname, 'PUBLIC') FROM unnest(p.polroles) o LEFT JOIN pg_catalog.pg_roles r0 ON r0.oid = o ORDER BY 1) AS roles,
    regexp_replace(pg_get_expr(p.polqual, p.polrelid), '[[:space:]]', '', 'g') AS using_expr,
    regexp_replace(pg_get_expr(p.polwithcheck, p.polrelid), '[[:space:]]', '', 'g') AS check_expr
    FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
    WHERE c.oid = ANY($1::regclass[])`, [relationNames]);
  for (const pol of policyRows) {
    if (
      pol.polpermissive && (
        pol.using_expr === 'true' || pol.using_expr === '(true)'
        || pol.check_expr === 'true' || pol.check_expr === '(true)'
        || (Array.isArray(pol.roles) && pol.roles.includes('PUBLIC'))
      )
    ) {
      throw new Error(`090 permissive policy rejected on ${pol.relation}: ${pol.polname}`);
    }
  }

  const { rows: fkRows } = await input.dbConn.query<{
    relation: string;
    columns: string[];
    target: string;
    target_columns: string[];
    delete_action: string;
    update_action: string;
    match_type: string;
    deferrable: boolean;
    initially_deferred: boolean;
    validated: boolean;
  }>(`SELECT (ns.nspname || '.' || cl.relname) AS relation,
    ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
      JOIN pg_catalog.pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum ORDER BY k.ord) AS columns,
    (tns.nspname || '.' || tcl.relname) AS target,
    ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
      JOIN pg_catalog.pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum ORDER BY k.ord) AS target_columns,
    con.confdeltype::text AS delete_action, con.confupdtype::text AS update_action,
    con.confmatchtype::text AS match_type, con.condeferrable AS deferrable,
    con.condeferred AS initially_deferred, con.convalidated AS validated
    FROM pg_catalog.pg_constraint con
    JOIN pg_catalog.pg_class cl ON cl.oid = con.conrelid
    JOIN pg_catalog.pg_namespace ns ON ns.oid = cl.relnamespace
    JOIN pg_catalog.pg_class tcl ON tcl.oid = con.confrelid
    JOIN pg_catalog.pg_namespace tns ON tns.oid = tcl.relnamespace
    WHERE con.contype = 'f' AND con.conrelid = ANY($1::regclass[])`, [relationNames]);
  for (const expectedFk of WAVE4_LOAD_FOREIGN_KEYS) {
    const actual = fkRows.filter(
      f => f.relation === expectedFk.from
        && f.target === expectedFk.to
        && JSON.stringify(f.columns) === JSON.stringify(expectedFk.columns)
        && JSON.stringify(f.target_columns) === JSON.stringify(expectedFk.referenced)
    );
    if (
      actual.length !== 1
      || actual[0]!.delete_action !== 'r'
      || actual[0]!.update_action !== 'a'
      || actual[0]!.match_type !== 's'
      || actual[0]!.deferrable !== expectedFk.deferrable
      || actual[0]!.initially_deferred !== expectedFk.initiallyDeferred
      || actual[0]!.validated !== true
    ) {
      throw new Error(`090 FK catalog shape drift: ${expectedFk.from}(${expectedFk.columns.join(',')})->${expectedFk.to}`);
    }
  }
}

export async function validateWave4LoadInstallation(input: {
  acquire: () => Promise<LoadProvisioningClientLease>;
  dbaRole: string;
  phase: Wave4LoadCatalogPhase;
}): Promise<void> {
  if (typeof input.acquire !== 'function') {
    throw new Error('090 owned external DBA lease required');
  }
  const lease = await input.acquire();
  let open = false, committing = false, broken = false;
  try {
    const backend = await assertWave4LoadRoleWithClient(lease.dbConn, input.dbaRole, 'dba', true);
    const begin = await lease.dbConn.query('BEGIN READ ONLY');
    if (begin.command !== 'BEGIN') throw new Error('090 catalog BEGIN READ ONLY refused');
    open = true;
    await lease.dbConn.query("SELECT set_config('statement_timeout','15000',true),set_config('lock_timeout','5000',true),set_config('idle_in_transaction_session_timeout','30000',true)");
    await validateWave4LoadCommittedCatalog({ dbConn: lease.dbConn, dbaRole: input.dbaRole, phase: input.phase });
    if (await assertWave4LoadRoleWithClient(lease.dbConn, input.dbaRole, 'dba') !== backend) {
      throw new Error('090 catalog backend PID changed');
    }
    committing = true;
    const commit = await lease.dbConn.query('COMMIT');
    if (commit.command !== 'COMMIT') throw new Wave4LoadCommitUncertainError();
    open = false; committing = false;
  } catch (error) {
    broken = true;
    if (committing) {
      throw error instanceof Wave4LoadCommitUncertainError ? error : new Wave4LoadCommitUncertainError();
    }
    if (open) {
      try {
        const r = await lease.dbConn.query('ROLLBACK');
        if (r.command === 'ROLLBACK') open = false;
      } catch {
        /* uncertain, discard broken lease without rollback claim */
      }
    }
    throw error;
  } finally {
    lease.release(broken || open);
  }
}

export async function provisionWave4LoadCompanion(input: {
  acquire: () => Promise<LoadProvisioningClientLease>;
  dbaRole: string;
}): Promise<void> {
  if (typeof input.acquire !== 'function') {
    throw new Error('090 owned external DBA lease required');
  }
  const lease = await input.acquire();
  let open = false, committing = false, broken = false;
  try {
    const backend = await assertWave4LoadRoleWithClient(lease.dbConn, input.dbaRole, 'dba', true);
    const begin = await lease.dbConn.query('BEGIN');
    if (begin.command !== 'BEGIN') throw new Error('090 DBA BEGIN refused');
    open = true;
    await lease.dbConn.query("SELECT set_config('statement_timeout','15000',true),set_config('lock_timeout','5000',true),set_config('idle_in_transaction_session_timeout','30000',true)");
    await lease.dbConn.query("SELECT set_config('search_path','pg_catalog',true)");
    await lease.dbConn.query(
      `LOCK TABLE ${WAVE4_LOAD_CAPTURE_RELATIONS.map(r => r.name).join(', ')} IN ACCESS EXCLUSIVE MODE`
    );
    await validateWave4LoadCommittedCatalog({ dbConn: lease.dbConn, dbaRole: input.dbaRole, phase: 'inert' });
    await lease.dbConn.query(`DO $$ DECLARE r text; BEGIN
      FOREACH r IN ARRAY ARRAY['swat_load_capture_owner','swat_load_http_writer','swat_load_observer'] LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = r) THEN
          EXECUTE format('CREATE%sROLE %I NOLOGIN PASSWORD NULL NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEROLE NOCREATEDB NOREPLICATION', ' ', r);
        END IF;
      END LOOP;
    END $$`);
    for (const role of WAVE4_LOAD_DISABLED_ROLES) {
      await lease.dbConn.query(`ALTER ROLE ${role} SET row_security=on`);
      await lease.dbConn.query(`ALTER ROLE ${role} SET search_path=pg_catalog`);
    }
    await lease.dbConn.query('REVOKE ALL ON SCHEMA wave4_load FROM PUBLIC');
    await lease.dbConn.query(
      `GRANT USAGE ON SCHEMA wave4_load TO ${WAVE4_LOAD_DISABLED_ROLES.join(', ')}`
    );
    await lease.dbConn.query('GRANT CREATE ON SCHEMA wave4_load TO swat_load_capture_owner');
    for (const r of WAVE4_LOAD_ROUTINES) {
      if (r.transfer) {
        await lease.dbConn.query(`ALTER FUNCTION ${r.signature} OWNER TO swat_load_capture_owner`);
      }
      await lease.dbConn.query(`REVOKE ALL ON FUNCTION ${r.signature} FROM PUBLIC`);
      if (r.callers.length > 0) {
        await lease.dbConn.query(`GRANT EXECUTE ON FUNCTION ${r.signature} TO ${r.callers.join(', ')}`);
      }
    }
    await lease.dbConn.query('REVOKE CREATE ON SCHEMA wave4_load FROM swat_load_capture_owner');
    await validateWave4LoadCommittedCatalog({ dbConn: lease.dbConn, dbaRole: input.dbaRole, phase: 'disabled-handoff' });
    if (await assertWave4LoadRoleWithClient(lease.dbConn, input.dbaRole, 'dba') !== backend) {
      throw new Error('090 DBA backend PID drift');
    }
    committing = true;
    const commit = await lease.dbConn.query('COMMIT');
    if (commit.command !== 'COMMIT') throw new Wave4LoadCommitUncertainError();
    open = false; committing = false;
  } catch (error) {
    broken = true;
    if (committing) {
      throw error instanceof Wave4LoadCommitUncertainError ? error : new Wave4LoadCommitUncertainError();
    }
    if (open) {
      try {
        const r = await lease.dbConn.query('ROLLBACK');
        if (r.command === 'ROLLBACK') open = false;
      } catch {
        /* uncertain, discard broken lease without rollback claim */
      }
    }
    throw error;
  } finally {
    lease.release(broken || open);
  }

  await validateWave4LoadInstallation({
    acquire: input.acquire,
    dbaRole: input.dbaRole,
    phase: 'disabled-handoff'
  });
}
