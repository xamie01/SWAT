/** SQL089 companion, LOCAL SOURCE AUTHORING ONLY.
 * No imports, client, executor, discovery, parser, digest, approval or installation API.
 * Inventory below is transcribed from the frozen proposal, NOT an observed catalog.
 * Exact bodies, defaults, incoming dependencies and baseline ACLs still need independent
 * consumed-source review. Passing a projection check cannot select SQL089 or enable LOGIN.
 */
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}
export const WAVE4_FINANCIAL_PROVISIONING_STATUS = frozen({
  authored: true, sourceComplete: false, reviewed: false, selected: false, applied: false,
  installed: false, testsRun: false, catalogObserved: false, runtimeAccepted: false,
  liveCapabilityAccepted: false, productionReady: false, sourceSha256: null,
  sourceIdentity: 'uncomputed; frozen local proposal bytes are not a reviewed pin',
} as const);
export const WAVE4_FINANCIAL_ROLES = frozen({
  authorityWriter: { role: 'swat_wave4_authority_writer', purpose: 'independently verified external authority, custody request/revocation, LP initialization approval' },
  financialWriter: { role: 'swat_wave4_financial_writer', purpose: 'LP non-initialization provenance only; NOT SQL082 receipt writer' },
  lpInitializer: { role: 'swat_lp_initializer', purpose: 'separately committed approval -> canonical subscription/config and FK closure' },
  custodyReader: { role: 'swat_custody_reader', purpose: 'execution secret read and lock only; currently SOURCE-refused database scope' },
  custodyObserver: { role: 'swat_custody_observer', purpose: 'independent secret/history observation; currently SOURCE-refused database scope and invoker audit ACL/RLS' },
} as const);
export type Wave4FinancialRole = typeof WAVE4_FINANCIAL_ROLES[keyof typeof WAVE4_FINANCIAL_ROLES]['role'];
const participants = ['swat_app','swat_lp_admitter','swat_custody_writer','swat_financial_receipt_writer',
  'swat_wave4_authority_writer','swat_wave4_financial_writer','swat_lp_initializer','swat_custody_reader','swat_custody_observer'] as const;

/** Fixed disabled-role draft text, not an executable installer. A distinct direct
 * external DBA must review absence/ownership/effective privileges in ALL databases
 * first. Existing roles are NOT repaired with IF NOT EXISTS or normalized in place.
 * No credentials, connection grants, data grants, memberships, ownership transfers
 * or enabling operation. NOLOGIN does not drain preexisting sessions.
 */
export const WAVE4_FINANCIAL_DISABLED_ROLE_SOURCE = `-- UNSELECTED, UNAPPLIED SOURCE DRAFT; independent direct DBA review required.
DO $financial_role_source$
BEGIN
 IF session_user<>current_user OR left(current_user::text,5)='swat_'
  OR current_setting('role')<>'none' OR current_setting('row_security')<>'on'
  OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND rolsuper)
 THEN RAISE EXCEPTION 'distinct direct external DBA required'; END IF;
 CREATE ROLE swat_wave4_authority_writer NOLOGIN PASSWORD NULL NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEROLE NOCREATEDB NOREPLICATION;
 CREATE ROLE swat_wave4_financial_writer NOLOGIN PASSWORD NULL NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEROLE NOCREATEDB NOREPLICATION;
 CREATE ROLE swat_lp_initializer NOLOGIN PASSWORD NULL NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEROLE NOCREATEDB NOREPLICATION;
 CREATE ROLE swat_custody_reader NOLOGIN PASSWORD NULL NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEROLE NOCREATEDB NOREPLICATION;
 CREATE ROLE swat_custody_observer NOLOGIN PASSWORD NULL NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEROLE NOCREATEDB NOREPLICATION;
 ALTER ROLE swat_wave4_authority_writer SET row_security=on;
 ALTER ROLE swat_wave4_authority_writer SET search_path=pg_catalog;
 ALTER ROLE swat_wave4_financial_writer SET row_security=on;
 ALTER ROLE swat_wave4_financial_writer SET search_path=pg_catalog;
 ALTER ROLE swat_lp_initializer SET row_security=on;
 ALTER ROLE swat_lp_initializer SET search_path=pg_catalog;
 ALTER ROLE swat_custody_reader SET row_security=on;
 ALTER ROLE swat_custody_reader SET search_path=pg_catalog;
 ALTER ROLE swat_custody_observer SET row_security=on;
 ALTER ROLE swat_custody_observer SET search_path=pg_catalog;
END $financial_role_source$;`;
export interface Wave4DisabledRoleFacts {
  readonly role: string; readonly canLogin: boolean; readonly passwordIsNull: boolean;
  readonly superuser: boolean; readonly bypassRls: boolean; readonly inherit: boolean;
  readonly createRole: boolean; readonly createDb: boolean; readonly replication: boolean;
  readonly membershipsIn: number; readonly membershipsOut: number; readonly sessions: number;
  readonly ownsRelations: boolean; readonly ownsFunctions: boolean; readonly ownsSchemas: boolean;
  readonly ownsDatabases: boolean; readonly otherSharedOwnership: boolean;
  readonly schemaCreate: boolean; readonly databaseCreate: boolean;
  readonly settings: readonly string[]; readonly databaseSpecificSettings: readonly string[];
  readonly extraEffectivePrivileges: readonly string[];
}
/** Caller-supplied consistency facts only. No catalog IO or authenticated approval.
 * Fail closed on missing/NULL facts, stale sessions, role defaults and extra authority.
 * There is deliberately NO active-role phase.
 */
export function validateWave4DisabledFinancialRoles(rows: readonly Wave4DisabledRoleFacts[]): void {
  const expected = Object.values(WAVE4_FINANCIAL_ROLES).map(r => r.role);
  const entries = inertArray(rows,expected.length);
  if (!entries) throw new Error('089 exact five disabled roles required');
  const seen = new Set<string>();
  for (const entry of entries) {
    const facts = inertRecord(entry,['role','canLogin','passwordIsNull','superuser','bypassRls','inherit','createRole','createDb','replication',
      'membershipsIn','membershipsOut','sessions','ownsRelations','ownsFunctions','ownsSchemas','ownsDatabases','otherSharedOwnership',
      'schemaCreate','databaseCreate','settings','databaseSpecificSettings','extraEffectivePrivileges']);
    if (!facts) throw new Error('089 exact inert disabled role facts required');
    const r = facts as unknown as Wave4DisabledRoleFacts;
    if (typeof r.role !== 'string' || seen.has(r.role) || !expected.some(role => role === r.role) || r.passwordIsNull !== true
      || [r.canLogin,r.superuser,r.bypassRls,r.inherit,r.createRole,r.createDb,r.replication,
        r.ownsRelations,r.ownsFunctions,r.ownsSchemas,r.ownsDatabases,r.otherSharedOwnership,r.schemaCreate,r.databaseCreate].some(v => v !== false)
      || r.membershipsIn !== 0 || r.membershipsOut !== 0 || r.sessions !== 0
      || !sameSet(r.settings,['row_security=on','search_path=pg_catalog'])
      || !sameSet(r.databaseSpecificSettings,[]) || !sameSet(r.extraEffectivePrivileges,[]))
      throw new Error('089 disabled nonowning role flags/ownership/ACL/settings/session drift');
    seen.add(r.role);
  }
}

const routine = (signature: string, argumentNames: readonly string[], result: 'boolean'|'jsonb'|'trigger',
  language: 'sql'|'plpgsql', execute: readonly string[], calls: readonly string[]) => ({
  signature, argumentNames, result, language, owner: 'swat_migrator', security: 'INVOKER',
  searchPath: ['pg_catalog'], kind: 'f', volatility: 'v', parallel: 'u', strict: false,
  leakproof: false, returnsSet: false, cost: 100, rows: 0, defaults: 0, variadic: 0, support: 0,
  execute: ['swat_migrator',...execute], grantor: 'swat_migrator', grantable: false,
  sourceCalls: calls, bodyPin: null,
});
/** Exact ordered signatures/argument names/result/language and declared 089 EXECUTE
 * recipients. sourceCalls describes explicit public calls, NOT full pg_depend closure.
 * All eight trigger-only routines retain owner EXECUTE only; none is a new broker.
 */
export const WAVE4_FINANCIAL_ROUTINES = frozen([
  routine('public.wave4_direct089(text,uuid)',['expected_role','tenant'],'boolean','plpgsql',participants,['public.current_app_user_id()']),
  routine('public.wave4_authority_current089(uuid,uuid,bigint)',['tenant','identity','rev'],'boolean','sql',participants,[]),
  routine('public.wave4_registry_guard089()',[],'trigger','plpgsql',[],['public.wave4_direct089(text,uuid)','public.wave4_authority_current089(uuid,uuid,bigint)','public.lp085_fields(jsonb,text[])','public.lp085_time(jsonb)']),
  routine('public.wave4_custody_lookup089(uuid,jsonb)',['tenant','requested'],'jsonb','plpgsql',
    ['swat_app','swat_custody_writer','swat_custody_reader','swat_custody_observer'],['public.current_app_user_id()','public.wave4_authority_current089(uuid,uuid,bigint)']),
  routine('public.wave4_custody_scope089(uuid,uuid)',['tenant','grant'],'boolean','sql',
    ['swat_custody_reader','swat_custody_observer'],['public.current_app_user_id()','public.wave4_authority_current089(uuid,uuid,bigint)']),
  routine('public.wave4_lp_guard089()',[],'trigger','plpgsql',[],['public.wave4_direct089(text,uuid)','public.wave4_authority_current089(uuid,uuid,bigint)','public.lp085_fields(jsonb,text[])','public.lp085_micro(jsonb,boolean)','public.lp085_time(jsonb)']),
  routine('public.wave4_lp_lookup089(uuid,text,text,text,text,text)',['tenant','account','requested_chain','network','requested_purpose','requested_selector'],'jsonb','plpgsql',
    ['swat_app','swat_lp_admitter','swat_wave4_financial_writer','swat_lp_initializer'],['public.current_app_user_id()','public.wave4_direct089(text,uuid)','public.wave4_authority_current089(uuid,uuid,bigint)']),
  routine('public.wave4_lp_initialize089(uuid,uuid)',['tenant','record_id'],'jsonb','plpgsql',
    ['swat_lp_initializer'],['public.wave4_direct089(text,uuid)','public.wave4_lp_lookup089(uuid,text,text,text,text,text)','public.lp085_time(jsonb)']),
  routine('public.wave4_lp_initialization_guard089()',[],'trigger','plpgsql',[],['public.wave4_direct089(text,uuid)','public.wave4_lp_lookup089(uuid,text,text,text,text,text)','public.lp085_time(jsonb)']),
  routine('public.wave4_spot_guard089()',[],'trigger','plpgsql',[],['public.wave4_direct089(text,uuid)','public.wave4_authority_current089(uuid,uuid,bigint)','public.lp085_fields(jsonb,text[])','public.lp085_micro(jsonb,boolean)','public.lp085_time(jsonb)']),
  routine('public.wave4_accounting_guard089()',[],'trigger','plpgsql',[],[]),
  routine('public.wave4_spot_settlement_guard089()',[],'trigger','plpgsql',[],['public.wave4_direct089(text,uuid)','public.wave4_authority_current089(uuid,uuid,bigint)','public.lp085_time(jsonb)']),
  routine('public.wave4_spot_atomic089()',[],'trigger','plpgsql',[],[]),
  routine('public.wave4_custody_readonly089()',[],'trigger','plpgsql',[],[]),
]);
export const WAVE4_FINANCIAL_EXTERNAL_ROUTINE_GRANTS = frozen([
  { signature: 'public.current_app_user_id()', execute: Object.values(WAVE4_FINANCIAL_ROLES).map(r => r.role) },
  ...['public.lp085_fields(jsonb,text[])','public.lp085_micro(jsonb,boolean)','public.lp085_time(jsonb)'].map(signature => ({ signature,
    execute: ['swat_wave4_authority_writer','swat_wave4_financial_writer','swat_lp_initializer','swat_financial_receipt_writer'] })),
]);

const relation = (name: string, primaryKey: readonly string[], select: readonly string[], insert: readonly string[], insertColumns: readonly string[] = []) => ({
  relation: `public.${name}`, kind: 'r', owner: 'swat_migrator', forceRls: true, enableRls: true,
  primaryKey, select, insert, insertColumns, update: [], delete: [], grantable: false,
});
export const WAVE4_FINANCIAL_RELATIONS = frozen([
  relation('wave4_authorities089',['user_id','identity_id','revision'],participants,['swat_wave4_authority_writer']),
  relation('wave4_authority_revocations089',['user_id','identity_id','revision'],participants,['swat_wave4_authority_writer']),
  relation('wave4_custody_requests089',['id'],participants,['swat_wave4_authority_writer']),
  relation('wave4_custody_revocations089',['user_id','request_id'],participants,['swat_wave4_authority_writer']),
  relation('wave4_lp_records089',['user_id','id'],['swat_app','swat_lp_admitter','swat_wave4_financial_writer','swat_lp_initializer','swat_wave4_authority_writer'],['swat_wave4_financial_writer','swat_wave4_authority_writer']),
  relation('wave4_lp_revocations089',['user_id','record_id'],['swat_app','swat_lp_admitter','swat_wave4_financial_writer','swat_lp_initializer','swat_wave4_authority_writer'],['swat_wave4_authority_writer']),
  relation('wave4_lp_initializations089',['user_id','record_id'],['swat_app','swat_lp_admitter','swat_lp_initializer'],['swat_lp_initializer'],['user_id','record_id','subscription_id']),
  relation('wave4_spot_admissions089',['receipt_id'],['swat_app','swat_financial_receipt_writer'],['swat_financial_receipt_writer']),
  relation('wave4_spot_settlements089',['receipt_id'],['swat_app','swat_financial_receipt_writer'],['swat_app']),
]);
export const WAVE4_FINANCIAL_AUDIT_VIEW = frozen({
  relation: 'public.wave4_custody_audit089', kind: 'v', owner: 'swat_migrator',
  securityInvoker: true, securityBarrier: true, select: ['swat_custody_observer'],
  columns: ['id','actor_type','actor_id','event','target_type','target_id','metadata','occurred_at'],
  underlying: ['public.audit_log','public.wave4_authorities089'],
  events: ['grant.locally_retired','grant.locally_revoked','grant.locally_compromised','grant.locally_replaced'],
  underlyingAuditSelectGranted: false, sourceUsable: false,
});
const fk = (from: string, columns: readonly string[], to: string, targetColumns: readonly string[]) => ({
  from: `public.${from}`, columns, to: `public.${to}`, targetColumns,
  onDelete: 'RESTRICT', onUpdate: 'NO ACTION', match: 'SIMPLE', deferrable: false, initiallyDeferred: false, validated: true,
});
/** All 18 declared SQL089 FKs, including incoming edges between new relations.
 * Unnamed constraint names/OIDs and internal trigger OIDs are NOT fabricated.
 * Single-column FKs do not prove tenant/account/economic binding: guards still must.
 */
export const WAVE4_FINANCIAL_FOREIGN_KEYS = frozen([
  fk('wave4_authorities089',['grant_id'],'user_execution_grants',['id']),
  fk('wave4_authorities089',['user_id'],'users',['id']),
  fk('wave4_authority_revocations089',['user_id','identity_id','revision'],'wave4_authorities089',['user_id','identity_id','revision']),
  fk('wave4_custody_requests089',['user_id','identity_id','authority_revision'],'wave4_authorities089',['user_id','identity_id','revision']),
  fk('wave4_custody_revocations089',['user_id','request_id'],'wave4_custody_requests089',['user_id','id']),
  fk('wave4_lp_records089',['user_id','identity_id','authority_revision'],'wave4_authorities089',['user_id','identity_id','revision']),
  fk('wave4_lp_revocations089',['user_id','record_id'],'wave4_lp_records089',['user_id','id']),
  fk('wave4_lp_initializations089',['user_id','record_id'],'wave4_lp_records089',['user_id','id']),
  fk('wave4_lp_initializations089',['subscription_id','user_id'],'lp_copy_subscriptions',['id','user_id']),
  fk('wave4_spot_admissions089',['execution_id'],'copy_executions',['id']),
  fk('wave4_spot_admissions089',['lot_id'],'copy_position_master_lots',['id']),
  fk('wave4_spot_admissions089',['position_id'],'copy_positions',['id']),
  fk('wave4_spot_admissions089',['user_id','identity_id','authority_revision'],'wave4_authorities089',['user_id','identity_id','revision']),
  fk('wave4_spot_admissions089',['intent_id','user_id'],'withdrawal_reducing_intents',['id','user_id']),
  fk('wave4_spot_admissions089',['attempt_id','intent_id','user_id'],'withdrawal_reducing_attempts',['id','intent_id','user_id']),
  fk('wave4_spot_admissions089',['receipt_id'],'withdrawal_reducing_receipts',['receipt_id']),
  fk('wave4_spot_settlements089',['evidence_id'],'copy_execution_evidence',['id']),
  fk('wave4_spot_settlements089',['user_id','receipt_id'],'wave4_spot_admissions089',['user_id','receipt_id']),
]);
export const WAVE4_FINANCIAL_NON_FK_BINDINGS = frozen([
  { relation: 'public.wave4_custody_requests089', column: 'grant_id', reason: 'pre-enrollment approval precedes INSERT of grant; deliberately no FK' },
  { relation: 'public.wave4_lp_records089', column: 'subscription_id', reason: 'independent approval commits before canonical initialization; closure table owns composite subscription FK' },
  { relation: 'public.wave4_spot_admissions089', column: 'receipt_id', reason: 'single receipt FK; exact user/intent/attempt/receipt body/provider/delta checked by wave4_spot_guard089' },
]);
const trigger = (table: string, name: string, fn: string, events: readonly string[] = ['INSERT','UPDATE','DELETE'], deferred = false) => ({
  relation: `public.${table}`, name, function: `public.${fn}()`, timing: deferred ? 'AFTER' : 'BEFORE', events,
  row: true, enabled: 'O', constraint: deferred, deferrable: deferred, initiallyDeferred: deferred,
  when: null, arguments: [],
});
export const WAVE4_FINANCIAL_TRIGGERS = frozen([
  ...['wave4_authorities089','wave4_authority_revocations089','wave4_custody_requests089','wave4_custody_revocations089']
    .map(table => trigger(table,'wave4_registry089','wave4_registry_guard089')),
  trigger('wave4_lp_initializations089','wave4_lp_initialization089','wave4_lp_initialization_guard089'),
  trigger('wave4_lp_records089','wave4_lp089','wave4_lp_guard089'),
  trigger('wave4_lp_revocations089','wave4_lp_revoke089','wave4_registry_guard089'),
  trigger('wave4_spot_admissions089','wave4_spot089','wave4_spot_guard089'),
  trigger('wave4_spot_settlements089','wave4_spot_settlement089','wave4_spot_settlement_guard089'),
  trigger('wave4_spot_settlements089','wave4_spot_atomic089','wave4_spot_atomic089',['INSERT'],true),
  trigger('withdrawal_reducing_accounting_admissions','wave4_accounting089','wave4_accounting_guard089',['INSERT']),
  trigger('user_execution_grants','wave4_custody_readonly089','wave4_custody_readonly089'),
]);
const tenant = "user_id=public.current_app_user_id() AND session_user=current_user AND current_setting('role')='none' AND current_setting('row_security')='on' AND COALESCE(current_setting('app.bypass_rls',true),'off')='off'";
const scoped = 'user_id=public.current_app_user_id()';
const policy = (table: string, name: string, command: string, roles: readonly string[], using: string|null, check: string|null, restrictive = false) => ({
  relation: `public.${table}`, name, command, roles, using, check, permissive: !restrictive,
});
/** SQL-source expressions, NOT pg_get_expr spelling or baseline policy replacement.
 * The 40 new policies include 28 on new tables and 12 on existing canonical tables.
 */
export const WAVE4_FINANCIAL_POLICIES = frozen([
  ...WAVE4_FINANCIAL_RELATIONS.map(r => policy(r.relation.slice(7),'wave4_tenant089','ALL',['PUBLIC'],tenant,tenant,true)),
  ...['wave4_authorities089','wave4_authority_revocations089','wave4_custody_requests089','wave4_custody_revocations089'].flatMap(table => [
    policy(table,'wave4_read089','SELECT',participants,scoped,null),
    policy(table,'wave4_insert089','INSERT',['swat_wave4_authority_writer'],null,scoped),
  ]),
  policy('wave4_lp_records089','wave4_read089','SELECT',['swat_app','swat_lp_admitter','swat_wave4_financial_writer','swat_lp_initializer'],scoped,null),
  policy('wave4_lp_records089','wave4_approver_read089','SELECT',['swat_wave4_authority_writer'],scoped,null),
  policy('wave4_lp_records089','wave4_insert089','INSERT',['swat_wave4_financial_writer','swat_wave4_authority_writer'],null,
    `${scoped} AND ((current_user='swat_wave4_authority_writer' AND purpose='initialization') OR(current_user='swat_wave4_financial_writer' AND purpose<>'initialization'))`),
  policy('wave4_lp_revocations089','wave4_read089','SELECT',['swat_app','swat_lp_admitter','swat_wave4_financial_writer','swat_lp_initializer','swat_wave4_authority_writer'],scoped,null),
  policy('wave4_lp_revocations089','wave4_insert089','INSERT',['swat_wave4_authority_writer'],null,scoped),
  policy('wave4_lp_initializations089','wave4_read089','SELECT',['swat_app','swat_lp_admitter','swat_lp_initializer'],scoped,null),
  policy('wave4_lp_initializations089','wave4_insert089','INSERT',['swat_lp_initializer'],null,scoped),
  ...['lp_copy_subscriptions','lp_guardrail_configs'].flatMap(table => [
    policy(table,'wave4_initializer089','SELECT',['swat_lp_initializer'],scoped,null),
    policy(table,'wave4_initializer_insert089','INSERT',['swat_lp_initializer'],null,scoped),
  ]),
  ...['wave4_spot_admissions089','wave4_spot_settlements089'].flatMap(table => [
    policy(table,'wave4_read089','SELECT',['swat_app','swat_financial_receipt_writer'],scoped,null),
    policy(table,'wave4_insert089','INSERT',[table === 'wave4_spot_admissions089' ? 'swat_financial_receipt_writer' : 'swat_app'],null,scoped),
  ]),
  policy('copy_execution_evidence','wave4_receipt_writer089','SELECT',['swat_financial_receipt_writer'],
    'EXISTS(SELECT 1 FROM public.copy_executions e WHERE e.id=execution_id AND e.user_id=public.current_app_user_id())',null),
  ...['copy_position_applications','copy_executions','copy_positions','copy_position_master_lots'].map(table =>
    policy(table,'wave4_receipt_writer089','SELECT',['swat_financial_receipt_writer'],scoped,null)),
  policy('user_execution_grants','wave4_execution_scope089','ALL',['swat_custody_reader','swat_custody_observer'],
    'public.wave4_custody_scope089(user_id,id)','false',true),
  policy('custody_secret_admissions','wave4_execution_scope089','ALL',['swat_custody_reader','swat_custody_observer'],
    'public.wave4_custody_scope089(user_id,grant_id)','false',true),
  policy('user_execution_grants','wave4_approver089','SELECT',['swat_wave4_authority_writer'],scoped,null),
]);
export const WAVE4_FINANCIAL_CANONICAL_ACL_DELTAS = frozen([
  { relations: ['public.lp_copy_subscriptions','public.lp_guardrail_configs'], roles: ['swat_lp_initializer'], privilege: 'SELECT', columns: [] },
  { relations: ['public.lp_copy_subscriptions'], roles: ['swat_lp_initializer'], privilege: 'INSERT', columns: ['id','user_id','master_wallet_address','chain','venue','allocated_budget_usd','max_capital_per_position_usd','status','created_at','updated_at'] },
  { relations: ['public.lp_guardrail_configs'], roles: ['swat_lp_initializer'], privilege: 'INSERT', columns: ['user_id','max_pool_allocation_pct','profit_bank_pct','reserve_sub_vault_chain','reserve_sub_vault_address','updated_at'] },
  { relations: ['public.copy_executions','public.copy_positions','public.copy_position_master_lots','public.copy_execution_evidence','public.copy_position_applications'], roles: ['swat_financial_receipt_writer'], privilege: 'SELECT', columns: [] },
  { relations: ['public.user_execution_grants','public.custody_secret_admissions'], roles: ['swat_custody_reader','swat_custody_observer'], privilege: 'SELECT', columns: [] },
  { relations: ['public.user_execution_grants'], roles: ['swat_custody_reader'], privilege: 'UPDATE', columns: ['lifecycle_revision'], reason: 'row-lock privilege only; restrictive WITH CHECK(false) and supplement reject mutation' },
  { relations: ['public.user_execution_grants'], roles: ['swat_wave4_authority_writer'], privilege: 'SELECT', columns: ['id','user_id','chain','account_address'] },
  { relations: ['public.user_execution_grants'], roles: ['swat_app'], privilege: 'SELECT', columns: ['id','user_id','chain','grant_kind','account_address','key_version','scope_policy','expires_at','revoked_at','status','created_at','secret_binding','lifecycle_revision','revocation_tombstone','activated_key_version'], reason: '089 revokes table and every column SELECT before regranting all actual non-sealed_secret columns; exact complete baseline column inventory pending' },
  { relations: ['public.custody_secret_admissions'], roles: ['swat_app'], privilege: 'SELECT', columns: ['id','grant_id','user_id','chain','grant_kind','account_address','key_version','secret_binding','scope_policy','expires_at','wrapper_id','service_identity','authenticated_receipt','accepted_at'], reason: 'same dynamic non-sealed_secret regrant; never ciphertext SELECT' },
]);
export const WAVE4_FINANCIAL_BASELINE_BOUNDARY = frozen({
  existingSelection: '001–087 only, existing refusal084 and reviewed pins unchanged',
  proposals: ['088_wave4_protected_pipeline.sql','089_wave4_protected_financial.sql','090_wave4_protected_load_capture.sql'],
  selectedProposals: [], brokerExtended: false, brokerTransfersUnchanged: [
    'public.swat_claim_runtime_capability(uuid)', 'public.has_worker_execution_capability(uuid)',
    'public.swat_apply_perps_reducing_receipt(uuid,text)', 'public.w3_apply_financial_receipt()',
    'public.w3_perps_accounting_requires_application()', 'public.swat_cancel_expired_financial_intent(uuid)',
    'public.w3_guard_perps_position_mutation()',
  ],
  historicalConstraintBaseline: 47, historicalEnforcementPathBaseline: 188,
  newTotalsQualified: false, sql088And090Owner: 'separate owner; no companion edits here',
});
export const WAVE4_FINANCIAL_PREREQUISITES = frozen([
  'Preserve dirty source and historical evidence; do not change frozen SQL089, SQL001–087 selection/pins, refusal084 or seven079082 transfers.',
  'Independent consumed-source byte/body/default/expression/constraint/ACL/RLS review must produce genuine pins later; no hashes or reviewer approval exist for this local companion.',
  'Separate direct external DBA disabled-role provisioning must independently authenticate DBA identity; check no existing roles/sessions, ownership via pg_shdepend across databases, memberships either way, effective PUBLIC/default/column/sequence/routine/CREATE/stats privileges and role/database GUCs.',
  'An independent future selection/install owner must close exact baseline SQL081/082/083/085/086/087 catalog and every touching incoming/outgoing FK, key order/actions/validation plus all internal RI trigger/function/OID/dependency paths; no arbitrary FK admission.',
  'Migrator must be direct restricted swat_migrator, role=none, row_security=on, no membership, public schema owner; five new roles disabled/nonowning and no preexisting wave4_%089 relations/routines.',
  'All new routines stay migrator-owned INVOKER with search_path=pg_catalog; no owner transfer, lookup broker, migrator runtime or broad privilege repair.',
  'Authority approval service must independently verify complete external identity evidence; issuer/receiptId/payloadHash are persisted labels, not an implemented verifier. Current SQL rejects database authority admission and authority_current admits external only.',
  'LP authority approval must COMMIT before separate initializer canonical writes/COMMIT; runtime/admitter initialization reads require persisted exact closure. Caller WithClient results remain provisional until owned checked COMMIT.',
  'Source blockers below must be repaired by their authorized owners before any separately approved external lifecycle, credentials, catalog qualification, disposable-infrastructure or live operation. This source cannot enable or schedule any of them.',
]);
export const WAVE4_FINANCIAL_SOURCE_BLOCKERS = frozen([
  { id: 'database-identity', layer: 'SOURCE', reason: 'wave4_registry_guard089 raises for database; wave4_authority_current089 requires external. No protected foreign-backend observation exists; pg_read_all_stats, client labels, membership and SET ROLE are forbidden.' },
  { id: 'custody-database-scope', layer: 'SOURCE', reason: 'wave4_custody_scope089 requires database_role=current_user/backend_pid=pg_backend_pid, incompatible with external-only current authority. Reader/observer grants confer no reachable approved secret scope.' },
  { id: 'custody-invoker-audit', layer: 'SOURCE', reason: 'wave4_custody_audit089 is INVOKER/barrier over unscoped audit_log without underlying observer SELECT or exact RLS; view SELECT cannot confer underlying rights. readWave4CustodyAuditWithClient unconditionally refuses; no runtime callback can certify this source gap.' },
  { id: 'sql081-secret-read', layer: 'SOURCE', reason: 'custody_grant_guard_081 SELECT * compares sealed_secret; canonical loadCustodySecretAdmissionWithClient and custody lifecycle load require sealed_secret. Metadata projection repair is not an admission/lifecycle secret-read repair; app ciphertext SELECT remains forbidden.' },
  { id: 'custody-journal-composition', layer: 'SOURCE', reason: 'Existing custody-journal reads raw audit_log, not the refused scoped adapter. SQL089 has no underlying exact audit ACL/RLS fix and no adapter wiring in that reserved file.' },
  { id: 'withdrawal-account-journal', layer: 'SOURCE', reason: 'No canonical withdrawal funding/transfer/fee account journal writer exists. Generic SQL082 accounting labels cannot substitute for real ledger effects; wave4_accounting_guard089 requires exact spot backing.' },
  { id: 'spot-fee-only', layer: 'SOURCE', reason: '089 delta_raw>0 and canonical recordCopyExecutionEvidenceWithClient positive baseQuantity exclude zero-base fee-only spot evidence. Do not invent a fill or repurpose the separately preserved perps fee-only journal.' },
  { id: 'nested-lp-validation', layer: 'SOURCE', reason: '089 LP guard calls lp085_fields for top-level presence but does not close all nested types/non-NULL action/kind/economics checks (notably quote/quote-context/settlement-context). Adapter checks do not repair hostile direct SQL insertion.' },
  { id: 'chronology-lock-closure', layer: 'SOURCE', reason: 'Custody lookup lacks the direct financial089 advisory lock used by revocation; full post-wait chronology/current-authority and canonical parent/attempt/lot/settlement concurrency closure remain unproved/unreviewed.' },
  { id: 'catalog-pin-closure', layer: 'SOURCE', reason: 'No exact independently reviewed SQL089 source/body/default/policy/constraint/default-ACL/full incoming FK+internal enforcement inventory or migration/install composition exists. Declared inventory below is not installed catalog evidence.' },
  { id: 'external-effects', layer: 'EXTERNAL', reason: 'Remote wrap verification, decrypt, deployed policy inspection, nonce/effect atomicity, owned transaction COMMIT outcomes, lifecycle scheduling and actual hostile DB/isolation proof require separately authorized capabilities.' },
]);
export const WAVE4_FINANCIAL_CATALOG_REQUIREMENTS = frozen({
  routine: ['complete inventory','identity argument OIDs/names/modes/defaults','return OID','prosrc/probin/prosqlbody','owner/language/security/options','exact grantor/grantee/EXECUTE/grant-option','full dependencies including composite types and builtins'],
  relation: ['complete columns/order/types/nullability/defaults/generated/identity','owner/kind/nonpartition/noninheritance','PK/UNIQUE/CHECK/FK definitions/indexes','ENABLE/FORCE RLS','complete permissive+restrictive policies/roles/expressions','table+column ACL/default ACL/PUBLIC/effective privilege closure'],
  enforcement: ['complete old+supplemental noninternal triggers','tgtype/enabled/args/qual/constraint/deferral','all incoming+outgoing FKs and referenced unique keys','internal RI trigger/function/dependency identity for every touching FK','no synthetic OIDs or hashes'],
  view: ['exact definition/rewrite dependencies','security_invoker/security_barrier','view ACL AND underlying audit ACL/RLS','database identity scope source refusal'],
  gateImplemented: false,
});
/** Inspect own data descriptors only: no caller iteration, getters or array hooks. */
function inertArray(actual: unknown, length: number): unknown[] | null {
  if (!Array.isArray(actual) || Object.getPrototypeOf(actual)!==Array.prototype) return null;
  const descriptors = Object.getOwnPropertyDescriptors(actual), size = Object.getOwnPropertyDescriptor(actual, 'length');
  if (!size || !('value' in size) || size.value!==length || size.enumerable
    || Reflect.ownKeys(actual).length!==length+1) return null;
  const values: unknown[] = [];
  for (let index=0;index<length;index++) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return null;
    values.push(descriptor.value);
  }
  return values;
}
function inertRecord(actual: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!actual || typeof actual!=='object' || Object.getPrototypeOf(actual)!==Object.prototype
    || Reflect.ownKeys(actual).length!==keys.length) return null;
  const descriptors = Object.getOwnPropertyDescriptors(actual), values: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return null;
    values[key] = descriptor.value;
  }
  return values;
}
function sameSet(actual: unknown, expected: readonly string[]): boolean {
  const values = inertArray(actual,expected.length);
  if (!values) return false;
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value!=='string' || seen.has(value) || !expected.includes(value)) return false;
    seen.add(value);
  }
  return seen.size===expected.length;
}
/** Pure declared-inventory projection checks for hostile inert fixtures ONLY.
 * Not a parser, body pin, catalog verifier, installer or acceptance gate.
 */
export function validateWave4FinancialDeclaredInventory(input: {
  readonly routines: readonly string[]; readonly relations: readonly string[];
  readonly triggers: readonly string[]; readonly foreignKeys: readonly string[];
}): void {
  const fkKey = (f: typeof WAVE4_FINANCIAL_FOREIGN_KEYS[number]) => `${f.from}(${f.columns.join(',')})->${f.to}(${f.targetColumns.join(',')})`;
  const fields = inertRecord(input,['routines','relations','triggers','foreignKeys']);
  if (!fields || !sameSet(fields.routines,WAVE4_FINANCIAL_ROUTINES.map(r => r.signature))
    || !sameSet(fields.relations,[...WAVE4_FINANCIAL_RELATIONS.map(r => r.relation),WAVE4_FINANCIAL_AUDIT_VIEW.relation])
    || !sameSet(fields.triggers,WAVE4_FINANCIAL_TRIGGERS.map(t => `${t.relation}:${t.name}`))
    || !sameSet(fields.foreignKeys,WAVE4_FINANCIAL_FOREIGN_KEYS.map(fkKey)))
    throw new Error('089 declared inventory missing/duplicate/extra/signature/FK-order drift');
}
/** Exact structured declaration equality for inert routine/FK/trigger/policy/ACL
 * mutation tests. Caller facts are not observed catalog data or approval. No body,
 * SQL-expression deparser or cryptographic identity is derived by this helper.
 */
export function validateWave4FinancialCatalogDeclaration(kind: 'routine'|'foreignKey'|'trigger'|'policy'|'canonicalAcl', candidate: unknown): void {
  const inventories: Record<string, readonly unknown[]> = {
    routine: WAVE4_FINANCIAL_ROUTINES, foreignKey: WAVE4_FINANCIAL_FOREIGN_KEYS,
    trigger: WAVE4_FINANCIAL_TRIGGERS, policy: WAVE4_FINANCIAL_POLICIES,
    canonicalAcl: WAVE4_FINANCIAL_CANONICAL_ACL_DELTAS,
  };
  const inventory = inventories[kind];
  function equal(expected: unknown, actual: unknown): boolean {
    if (expected === null || typeof expected !== 'object') return Object.is(expected, actual);
    if (!actual || typeof actual !== 'object' || Object.getPrototypeOf(actual) !== Object.getPrototypeOf(expected)
      || Object.getOwnPropertySymbols(actual).length !== 0) return false;
    const wanted = Object.getOwnPropertyDescriptors(expected), found = Object.getOwnPropertyDescriptors(actual);
    const keys = Object.keys(wanted);
    return keys.length === Object.keys(found).length && keys.every(key => {
      const a = wanted[key]!, b = found[key];
      return b && 'value' in b && a.enumerable === b.enumerable && equal(a.value, b.value);
    });
  }
  // Descriptor equality does not invoke getters/toJSON or stringify an attacker.
  // Full expected object shape bounds recursion even for cyclic candidate input.
  if (!inventory || !candidate || !inventory.some(expected => equal(expected, candidate)))
    throw new Error('089 exact declared routine/FK/trigger/policy/ACL drift');
}
/** Even true-shaped approval/catalog flags cannot overcome an absent SOURCE strategy.
 * No inputs, callback, alternate model/provider or runtime-only escape hatch.
 */
export function requireWave4FinancialSourceComplete(): never {
  throw new Error(`089 SOURCE-refused: ${WAVE4_FINANCIAL_SOURCE_BLOCKERS.filter(b => b.layer === 'SOURCE').map(b => b.id).join(', ')}`);
}

export interface FinancialProvisioningQueryClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: unknown[]
  ): Promise<{ rows: T[]; command?: string; rowCount?: number | null }>;
}

export interface FinancialProvisioningClientLease {
  readonly client: FinancialProvisioningQueryClient;
  release(broken: boolean): void;
}

export type Wave4FinancialCatalogPhase = 'inert' | 'disabled-roles-and-catalog';

export class Wave4FinancialCommitUncertainError extends Error {
  constructor(message = 'Wave4 financial DBA COMMIT uncertain; discard lease and reconcile externally') {
    super(message);
    this.name = 'Wave4FinancialCommitUncertainError';
  }
}

const VALID_FINANCIAL_ROLE_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;
const FINANCIAL_SETTLER_ALLOWLIST = [
  'public.swat_apply_perps_reducing_receipt(uuid,text)',
  'public.w3_apply_financial_receipt()',
  'public.w3_perps_accounting_requires_application()',
  'public.swat_cancel_expired_financial_intent(uuid)',
  'public.w3_guard_perps_position_mutation()'
] as const;

function assertValidFinancialRoleName(role: string, kind: 'dba' | 'migrator' | 'restricted'): void {
  if (typeof role !== 'string' || !VALID_FINANCIAL_ROLE_PATTERN.test(role)) {
    throw new Error('089 invalid direct role identifier');
  }
  if (kind === 'dba' && role.startsWith('swat_')) {
    throw new Error('089 distinct direct external DBA identity required');
  }
  if (kind === 'migrator' && role !== 'swat_migrator') {
    throw new Error('089 direct swat_migrator identity required');
  }
  if (kind === 'restricted' && (!role.startsWith('swat_') || role === 'swat_migrator')) {
    throw new Error('089 restricted swat_* identity required');
  }
}

export async function assertWave4FinancialRoleWithClient(
  client: FinancialProvisioningQueryClient,
  role: string,
  kind: 'dba' | 'migrator' | 'restricted',
  clean = false
): Promise<number> {
  if (!client || typeof client.query !== 'function') {
    throw new Error('089 query client required');
  }
  assertValidFinancialRoleName(role, kind);
  const { rows } = await client.query<{
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
    throw new Error('089 direct role identity/session/RLS/membership/transaction check failed');
  }
  if (kind === 'dba') {
    if (r.superuser !== true) {
      throw new Error('089 authenticated direct external superuser DBA backend required');
    }
  } else {
    if (
      r.superuser !== false || r.bypass_rls !== false || r.inherit !== false
      || r.create_role !== false || r.create_db !== false || r.replication !== false
    ) {
      throw new Error('089 restricted role privilege escalation rejected');
    }
  }
  return r.backend;
}

export async function validateWave4FinancialCommittedCatalog(input: {
  client: FinancialProvisioningQueryClient;
  dbaRole: string;
  phase: Wave4FinancialCatalogPhase;
}): Promise<void> {
  if (input.phase !== 'inert' && input.phase !== 'disabled-roles-and-catalog') {
    throw new Error('089 catalog phase required');
  }
  await assertWave4FinancialRoleWithClient(input.client, input.dbaRole, 'dba');
  await input.client.query("SELECT set_config('search_path','pg_catalog',true)");

  const newRoleNames = Object.values(WAVE4_FINANCIAL_ROLES).map(r => r.role);
  const inspectedRoles = [...newRoleNames, 'swat_migrator', 'swat_app', 'swat_financial_settler'];
  const { rows: roleRows } = await input.client.query<{
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
    EXISTS(SELECT 1 FROM pg_catalog.pg_shdepend d WHERE d.refclassid='pg_catalog.pg_authid'::regclass AND d.refobjid=r.oid AND d.deptype='o') AS extra_ownership
    FROM pg_catalog.pg_roles r WHERE r.rolname = ANY($1::text[])`, [inspectedRoles]);

  if (input.phase === 'disabled-roles-and-catalog') {
    for (const name of newRoleNames) {
      if (!roleRows.some(r => r.rolname === name)) {
        throw new Error(`089 required disabled role missing: ${name}`);
      }
    }
  }
  for (const r of roleRows) {
    if (r.unsafe !== false || r.membership !== false) {
      throw new Error(`089 role unsafe flags/membership drift: ${r.rolname}`);
    }
    if ((newRoleNames as readonly string[]).includes(r.rolname)) {
      if (
        r.rolcanlogin !== false || r.owns !== false || r.extra_ownership !== false
        || r.can_create !== false || !Array.isArray(r.functions) || r.functions.length !== 0
      ) {
        throw new Error(`089 disabled role ownership/CREATE/login drift: ${r.rolname}`);
      }
    } else if (r.rolname === 'swat_financial_settler') {
      if (
        r.rolcanlogin !== false || r.owns !== false || r.can_create !== false
        || !Array.isArray(r.functions)
        || JSON.stringify([...r.functions].sort()) !== JSON.stringify([...FINANCIAL_SETTLER_ALLOWLIST].sort())
      ) {
        throw new Error('089 swat_financial_settler boundary drift');
      }
    }
  }

  const { rows: settings } = await input.client.query<{
    rolname: string;
    setdatabase: unknown;
    setconfig: unknown;
  }>(`SELECT r.rolname, s.setdatabase, s.setconfig FROM pg_catalog.pg_db_role_setting s
    JOIN pg_catalog.pg_roles r ON r.oid = s.setrole WHERE r.rolname = ANY($1::text[])`, [newRoleNames]);
  const allowedSettings = ['row_security=on', 'search_path=pg_catalog', 'search_path=pg_catalog, public'];
  for (const s of settings) {
    if (Number(s.setdatabase) !== 0 || !Array.isArray(s.setconfig) || s.setconfig.some(v => typeof v !== 'string' || !allowedSettings.includes(v))) {
      throw new Error(`089 role GUC settings drift: ${s.rolname}`);
    }
  }
  if (input.phase === 'disabled-roles-and-catalog') {
    for (const name of newRoleNames) {
      const setting = settings.find(s => s.rolname === name);
      if (
        !setting || !Array.isArray(setting.setconfig)
        || !setting.setconfig.includes('row_security=on')
        || !setting.setconfig.includes('search_path=pg_catalog')
      ) {
        throw new Error(`089 disabled role GUC defaults missing: ${name}`);
      }
    }
  }

  const { rows: nsRows } = await input.client.query<{
    nspname: string;
    owner: string;
    restricted_or_public_create: boolean;
  }>(`SELECT n.nspname, r.rolname AS owner,
    (has_schema_privilege('PUBLIC', n.oid, 'CREATE')
     OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles x WHERE x.rolname = ANY($1::text[]) AND has_schema_privilege(x.oid, n.oid, 'CREATE'))) AS restricted_or_public_create
    FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_roles r ON r.oid = n.nspowner
    WHERE n.nspname = 'public'`, [newRoleNames]);
  if (nsRows.length !== 1 || nsRows[0]!.owner !== 'swat_migrator' || nsRows[0]!.restricted_or_public_create !== false) {
    throw new Error('089 public namespace ownership or CREATE privilege drift');
  }

  const tableNames = WAVE4_FINANCIAL_RELATIONS.map(r => r.relation);
  const relationNames = [...tableNames, WAVE4_FINANCIAL_AUDIT_VIEW.relation];
  const { rows: relRows } = await input.client.query<{
    relation: string;
    owner: string;
    relkind: string;
    relrowsecurity: boolean;
    relforcerowsecurity: boolean;
    reloptions: string[] | null;
    public_or_grantable_acl: boolean;
  }>(`SELECT ('public.' || c.relname) AS relation, r.rolname AS owner, c.relkind, c.relrowsecurity, c.relforcerowsecurity, c.reloptions,
    (EXISTS(SELECT 1 FROM aclexplode(COALESCE(c.relacl, acldefault(CASE c.relkind WHEN 'v' THEN 'r' ELSE 'r' END, c.relowner))) a WHERE a.grantee = 0 OR a.is_grantable)
     OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute at CROSS JOIN LATERAL aclexplode(at.attacl) a
       WHERE at.attrelid = c.oid AND at.attnum > 0 AND NOT at.attisdropped AND (a.grantee = 0 OR a.is_grantable))) AS public_or_grantable_acl
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_roles r ON r.oid = c.relowner
    WHERE c.oid = ANY($1::regclass[])`, [relationNames]);
  if (relRows.length !== relationNames.length) {
    throw new Error('089 relation/view inventory missing');
  }
  for (const table of tableNames) {
    const actual = relRows.find(r => r.relation === table);
    if (
      !actual || actual.owner !== 'swat_migrator' || actual.relkind !== 'r'
      || actual.relrowsecurity !== true || actual.relforcerowsecurity !== true
      || actual.public_or_grantable_acl !== false
    ) {
      throw new Error(`089 table FORCE RLS/ownership/ACL drift: ${table}`);
    }
  }
  const view = relRows.find(r => r.relation === WAVE4_FINANCIAL_AUDIT_VIEW.relation);
  if (
    !view || view.owner !== 'swat_migrator' || view.relkind !== 'v'
    || !Array.isArray(view.reloptions)
    || !view.reloptions.includes('security_invoker=true')
    || !view.reloptions.includes('security_barrier=true')
    || view.public_or_grantable_acl !== false
  ) {
    throw new Error('089 wave4_custody_audit089 view security_invoker/security_barrier/owner/ACL drift');
  }

  const { rows: privRows } = await input.client.query<{
    observer_audit_select: boolean;
    app_grants_secret_select: boolean;
    app_admissions_secret_select: boolean;
  }>(`SELECT
    (has_table_privilege('PUBLIC', 'public.audit_log', 'SELECT')
     OR EXISTS(
       SELECT 1 FROM pg_catalog.pg_roles r
       WHERE r.rolname = 'swat_custody_observer'
         AND has_table_privilege(r.oid, 'public.audit_log', 'SELECT')
     )) AS observer_audit_select,
    has_column_privilege('swat_app', 'public.user_execution_grants', 'sealed_secret', 'SELECT') AS app_grants_secret_select,
    has_column_privilege('swat_app', 'public.custody_secret_admissions', 'sealed_secret', 'SELECT') AS app_admissions_secret_select`);
  if (
    privRows.length !== 1
    || privRows[0]!.observer_audit_select !== false
    || privRows[0]!.app_grants_secret_select !== false
    || privRows[0]!.app_admissions_secret_select !== false
  ) {
    throw new Error('089 forbidden audit_log or sealed_secret privilege widening detected');
  }

  const expectedSignatures = WAVE4_FINANCIAL_ROUTINES.map(r => r.signature);
  const { rows: procRows } = await input.client.query<{
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
    WHERE p.oid = ANY($1::regprocedure[])`, [expectedSignatures]);
  if (procRows.length !== WAVE4_FINANCIAL_ROUTINES.length) {
    throw new Error('089 routine catalog inventory missing');
  }
  const newRoleSet = new Set<string>(newRoleNames);
  const existingNewRoles = new Set(
    roleRows.map(r => r.rolname).filter(name => newRoleSet.has(name))
  );
  for (const expected of WAVE4_FINANCIAL_ROUTINES) {
    const actual = procRows.find(r => r.signature === expected.signature);
    const expectedGrantees = (
      input.phase === 'inert'
        ? expected.execute.filter(role => !newRoleSet.has(role) || existingNewRoles.has(role))
        : expected.execute
    ).slice().sort();
    const actualGrantees = Array.isArray(actual?.acl)
      ? actual.acl.map(a => a.grantee).sort()
      : [];
    if (
      !actual || actual.owner !== 'swat_migrator' || actual.prokind !== 'f'
      || actual.prosecdef !== false || actual.proisstrict !== false || actual.proleakproof !== false
      || actual.provolatile !== 'v' || actual.proparallel !== 'u'
      || actual.pronargdefaults !== 0 || actual.lanname !== expected.language
      || JSON.stringify(actual.proconfig) !== JSON.stringify(['search_path=pg_catalog'])
      || !Array.isArray(actual.acl)
      || actual.acl.some(a => typeof a?.grantee !== 'string' || a.grantee === 'PUBLIC' || a.grantable !== false || a.privilege !== 'EXECUTE' || a.grantor !== 'swat_migrator')
      || JSON.stringify(actualGrantees) !== JSON.stringify(expectedGrantees)
    ) {
      throw new Error(`089 routine owner/INVOKER/options/ACL drift: ${expected.signature}`);
    }
  }

  const policyTables = [
    ...tableNames,
    'public.user_execution_grants',
    'public.custody_secret_admissions',
    'public.lp_copy_subscriptions',
    'public.lp_guardrail_configs',
    'public.copy_execution_evidence',
    'public.copy_position_applications',
    'public.copy_executions',
    'public.copy_positions',
    'public.copy_position_master_lots'
  ];
  const { rows: policyRows } = await input.client.query<{
    relation: string;
    polname: string;
    polpermissive: boolean;
    roles: string[];
    using_expr: string | null;
    check_expr: string | null;
  }>(`SELECT ('public.' || c.relname) AS relation, p.polname, p.polpermissive,
    ARRAY(SELECT COALESCE(r0.rolname, 'PUBLIC') FROM unnest(p.polroles) o LEFT JOIN pg_catalog.pg_roles r0 ON r0.oid = o ORDER BY 1) AS roles,
    regexp_replace(pg_get_expr(p.polqual, p.polrelid), '[[:space:]]', '', 'g') AS using_expr,
    regexp_replace(pg_get_expr(p.polwithcheck, p.polrelid), '[[:space:]]', '', 'g') AS check_expr
    FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
    WHERE c.oid = ANY($1::regclass[])`, [policyTables]);
  for (const pol of policyRows) {
    if (
      pol.polpermissive && (
        pol.using_expr === 'true' || pol.using_expr === '(true)'
        || pol.check_expr === 'true' || pol.check_expr === '(true)'
        || (Array.isArray(pol.roles) && pol.roles.includes('PUBLIC'))
      )
    ) {
      throw new Error(`089 permissive RLS policy rejected on ${pol.relation}: ${pol.polname}`);
    }
  }
  for (const table of tableNames) {
    const tenantPol = policyRows.find(p => p.relation === table && p.polname === 'wave4_tenant089');
    if (!tenantPol || tenantPol.polpermissive !== false) {
      throw new Error(`089 missing restrictive wave4_tenant089 policy on ${table}`);
    }
  }
  for (const custodyTable of ['public.user_execution_grants', 'public.custody_secret_admissions']) {
    const scopePol = policyRows.find(p => p.relation === custodyTable && p.polname === 'wave4_execution_scope089');
    if (!scopePol || scopePol.polpermissive !== false || scopePol.check_expr !== 'false') {
      throw new Error(`089 missing restrictive WITH CHECK(false) wave4_execution_scope089 policy on ${custodyTable}`);
    }
  }

  const { rows: fkRows } = await input.client.query<{
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
    ARRAY(SELECT a.attname FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
      JOIN pg_catalog.pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum ORDER BY k.ord) AS columns,
    (tns.nspname || '.' || tcl.relname) AS target,
    ARRAY(SELECT a.attname FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
      JOIN pg_catalog.pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum ORDER BY k.ord) AS target_columns,
    con.confdeltype::text AS delete_action, con.confupdtype::text AS update_action,
    con.confmatchtype::text AS match_type, con.condeferrable AS deferrable,
    con.condeferred AS initially_deferred, con.convalidated AS validated
    FROM pg_catalog.pg_constraint con
    JOIN pg_catalog.pg_class cl ON cl.oid = con.conrelid
    JOIN pg_catalog.pg_namespace ns ON ns.oid = cl.relnamespace
    JOIN pg_catalog.pg_class tcl ON tcl.oid = con.confrelid
    JOIN pg_catalog.pg_namespace tns ON tns.oid = tcl.relnamespace
    WHERE con.contype = 'f' AND con.conrelid = ANY($1::regclass[])`, [tableNames]);
  for (const expectedFk of WAVE4_FINANCIAL_FOREIGN_KEYS) {
    const actual = fkRows.filter(
      f => f.relation === expectedFk.from
        && f.target === expectedFk.to
        && JSON.stringify(f.columns) === JSON.stringify(expectedFk.columns)
        && JSON.stringify(f.target_columns) === JSON.stringify(expectedFk.targetColumns)
    );
    if (
      actual.length !== 1
      || actual[0]!.delete_action !== 'r'
      || actual[0]!.update_action !== 'a'
      || actual[0]!.match_type !== 's'
      || actual[0]!.deferrable !== false
      || actual[0]!.initially_deferred !== false
      || actual[0]!.validated !== true
    ) {
      throw new Error(`089 FK catalog shape drift: ${expectedFk.from}(${expectedFk.columns.join(',')})->${expectedFk.to}`);
    }
  }

  const triggerTables = Array.from(new Set(WAVE4_FINANCIAL_TRIGGERS.map(t => t.relation)));
  const { rows: triggerRows } = await input.client.query<{
    relation: string;
    name: string;
    tgenabled: string;
    is_constraint: boolean;
    tgdeferrable: boolean;
    tginitdeferred: boolean;
  }>(`SELECT ('public.' || c.relname) AS relation, t.tgname AS name, t.tgenabled::text AS tgenabled,
    (t.tgconstraint <> 0) AS is_constraint, t.tgdeferrable, t.tginitdeferred
    FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
    WHERE c.oid = ANY($1::regclass[]) AND (NOT t.tgisinternal OR t.tgconstraint <> 0)`, [triggerTables]);
  for (const expectedTrg of WAVE4_FINANCIAL_TRIGGERS) {
    const actual = triggerRows.find(t => t.relation === expectedTrg.relation && t.name === expectedTrg.name);
    if (
      !actual || actual.tgenabled !== 'O'
      || actual.is_constraint !== expectedTrg.constraint
      || actual.tgdeferrable !== expectedTrg.deferrable
      || actual.tginitdeferred !== expectedTrg.initiallyDeferred
    ) {
      throw new Error(`089 trigger catalog drift: ${expectedTrg.relation}:${expectedTrg.name}`);
    }
  }
}

export async function validateWave4FinancialInstallation(input: {
  acquire: () => Promise<FinancialProvisioningClientLease>;
  dbaRole: string;
  phase: Wave4FinancialCatalogPhase;
}): Promise<void> {
  if (typeof input.acquire !== 'function') {
    throw new Error('089 owned external DBA lease required');
  }
  const lease = await input.acquire();
  let open = false, committing = false, broken = false;
  try {
    const backend = await assertWave4FinancialRoleWithClient(lease.client, input.dbaRole, 'dba', true);
    const begin = await lease.client.query('BEGIN READ ONLY');
    if (begin.command !== 'BEGIN') throw new Error('089 catalog BEGIN READ ONLY refused');
    open = true;
    await lease.client.query("SELECT set_config('statement_timeout','15000',true),set_config('lock_timeout','5000',true),set_config('idle_in_transaction_session_timeout','30000',true)");
    await validateWave4FinancialCommittedCatalog({ client: lease.client, dbaRole: input.dbaRole, phase: input.phase });
    if (await assertWave4FinancialRoleWithClient(lease.client, input.dbaRole, 'dba') !== backend) {
      throw new Error('089 catalog backend PID changed');
    }
    committing = true;
    const commit = await lease.client.query('COMMIT');
    if (commit.command !== 'COMMIT') throw new Wave4FinancialCommitUncertainError();
    open = false; committing = false;
  } catch (error) {
    broken = true;
    if (committing) {
      throw error instanceof Wave4FinancialCommitUncertainError ? error : new Wave4FinancialCommitUncertainError();
    }
    if (open) {
      try {
        const r = await lease.client.query('ROLLBACK');
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

export async function provisionWave4FinancialCompanion(input: {
  acquire: () => Promise<FinancialProvisioningClientLease>;
  dbaRole: string;
}): Promise<void> {
  if (typeof input.acquire !== 'function') {
    throw new Error('089 owned external DBA lease required');
  }
  const lease = await input.acquire();
  let open = false, committing = false, broken = false;
  try {
    const backend = await assertWave4FinancialRoleWithClient(lease.client, input.dbaRole, 'dba', true);
    const begin = await lease.client.query('BEGIN');
    if (begin.command !== 'BEGIN') throw new Error('089 DBA BEGIN refused');
    open = true;
    await lease.client.query("SELECT set_config('statement_timeout','15000',true),set_config('lock_timeout','5000',true),set_config('idle_in_transaction_session_timeout','30000',true)");
    await lease.client.query("SELECT set_config('search_path','pg_catalog',true)");
    await lease.client.query(
      `LOCK TABLE ${WAVE4_FINANCIAL_RELATIONS.map(r => r.relation).join(', ')} IN ACCESS EXCLUSIVE MODE`
    );
    await validateWave4FinancialCommittedCatalog({ client: lease.client, dbaRole: input.dbaRole, phase: 'inert' });
    const roleList = Object.values(WAVE4_FINANCIAL_ROLES).map(r => r.role);
    await lease.client.query(`DO $$ DECLARE r text; BEGIN
      FOREACH r IN ARRAY ARRAY['swat_wave4_authority_writer','swat_wave4_financial_writer','swat_lp_initializer','swat_custody_reader','swat_custody_observer'] LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = r) THEN
          EXECUTE format('CREATE ROLE %I NOLOGIN PASSWORD NULL NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEROLE NOCREATEDB NOREPLICATION', r);
        END IF;
      END LOOP;
    END $$`);
    for (const role of roleList) {
      await lease.client.query(`ALTER ROLE ${role} SET row_security=on`);
      await lease.client.query(`ALTER ROLE ${role} SET search_path=pg_catalog`);
    }
    await validateWave4FinancialCommittedCatalog({ client: lease.client, dbaRole: input.dbaRole, phase: 'disabled-roles-and-catalog' });
    if (await assertWave4FinancialRoleWithClient(lease.client, input.dbaRole, 'dba') !== backend) {
      throw new Error('089 DBA backend PID drift');
    }
    committing = true;
    const commit = await lease.client.query('COMMIT');
    if (commit.command !== 'COMMIT') throw new Wave4FinancialCommitUncertainError();
    open = false; committing = false;
  } catch (error) {
    broken = true;
    if (committing) {
      throw error instanceof Wave4FinancialCommitUncertainError ? error : new Wave4FinancialCommitUncertainError();
    }
    if (open) {
      try {
        const r = await lease.client.query('ROLLBACK');
        if (r.command === 'ROLLBACK') open = false;
      } catch {
        /* uncertain, discard broken lease without rollback claim */
      }
    }
    throw error;
  } finally {
    lease.release(broken || open);
  }

  await validateWave4FinancialInstallation({
    acquire: input.acquire,
    dbaRole: input.dbaRole,
    phase: 'disabled-roles-and-catalog'
  });
}
