/** SOURCE ONLY. Pure inventory/consistency/proposal seams; no client, pool, imports with
 * side effects, SQL execution, hashing, migration selection or LOGIN activation.
 * Exact caller-supplied UTF-8 bytes are captured, not blessed by a digest, role
 * label, audit-reference string or this module. SQL088 is unreviewed/unselected/
 * unapplied. Local consistency is NOT P3 catalog closure or runtime authorization. */
export const PIPELINE_PROVISIONING_STATUS = Object.freeze({
  sourceComplete: false, runtimeAccepted: false, liveCapabilityAccepted: false,
  productionReady: false, reviewed: false, selected: false, applied: false,
  executesSql: false, activatesLogin: false, authenticatesExternalApproval: false
} as const);
export const PIPELINE_SOURCE_FILES = Object.freeze({
  sql088: 'packages/db/sql/088_wave4_protected_pipeline.sql',
  sql080: 'packages/db/sql/080_immutable_valuation_corrections.sql',
  soleRuntimeCapability: 'packages/db/src/obligation-runtime-owned.ts'
});
export const PIPELINE_PURPOSE_ROLES = Object.freeze({
  'source-register': 'swat_source_provider_writer', 'source-intake': 'swat_source_provider_writer',
  'source-verify': 'swat_source_provider_writer', fanout: 'swat_fanout',
  'worker-register': 'swat_capability_writer', 'risk-write': 'swat_risk_writer',
  'valuation-register': 'swat_valuation_writer', 'valuation-write': 'swat_valuation_writer',
  'paper-valuation': 'swat_valuation_writer', 'paper-receipt': 'swat_worker_receipt_writer'
} as const);
export type PipelineProvisioningPurpose = keyof typeof PIPELINE_PURPOSE_ROLES;
export const PIPELINE_WORKER_ROUTINES = Object.freeze([
  'public.swat_pipeline_register_worker_capability(uuid,jsonb)',
  'public.swat_pipeline_write_risk_policy(uuid,jsonb)',
  'public.swat_pipeline_register_worker_valuation_authority(text,jsonb)',
  'public.swat_pipeline_record_trusted_worker_valuation(text,jsonb)',
  'public.swat_pipeline_paper_valuation(uuid)',
  'public.swat_pipeline_record_worker_paper_receipt(uuid,bigint,jsonb)',
  'public.swat_pipeline_worker_paper_receipt(uuid,bigint,text)'
] as const);
export const PIPELINE_NEW_LOOKUP_ROUTINES = Object.freeze([
  'public.swat_pipeline_backend_capability(text,text)',
  'public.swat_pipeline_exact_follower_balance(uuid,text,text,text,text)'
] as const);
/** Descriptive boundary only: these original seven079082 transfers stay sealed.
 * New088 ownership must never pass through or expand that broker/allowlist. */
export const PIPELINE_EXISTING_BROKER_BOUNDARY = Object.freeze([
  'public.swat_claim_runtime_capability(uuid)', 'public.has_worker_execution_capability(uuid)',
  'public.swat_apply_perps_reducing_receipt(uuid,text)', 'public.w3_apply_financial_receipt()',
  'public.w3_perps_accounting_requires_application()', 'public.swat_cancel_expired_financial_intent(uuid)',
  'public.w3_guard_perps_position_mutation()'
] as const);
export const PIPELINE_SOURCE_BLOCKERS = Object.freeze([
  'Exact independently authenticated external enrollment and committed catalog evidence are not supplied by source bytes or audit labels.',
  'Lookup SELECT/FOR SHARE lock privileges and exact FORCE RLS on backend/follower relations, pg_control_system access and backend observation remain independently reviewed prerequisites; no stats or membership shortcut.',
  'Global-control, current policy/control rereads, capacity and source/fanout/worker lock closure remain missing source work; ownership alone cannot supply them.',
  'Canonical SQL080 risk/accounting/settlement scoped caller ACL, RLS, lock and immutable nullable-original economics closure remain missing source work; no broad grants or synthetic zero economics.',
  'Exact forward074 worker policy capture/current-control integration remains missing source work; existing lookup is solely obligation-runtime-owned.ts / swat_claim_runtime_capability(uuid).',
  'Exact persisted observer run/backend/namespace/asset enrollment, scoped SELECT RLS and worker_correction_authorized privilege remain absent; role labels, namespace patterns and stats are not observer scope authority.',
  'Twelve088 local touching FKs are NOT full P3 incoming-FK/trigger/index/dependency closure against canonical001-087 or unselected089/090.',
  'Preserve SQL083, refused084 and087 source pins, prior47-constraint/188-enforcement-path baseline and exactly seven079082 broker transfers; installation/migration integration remains separately gated.',
  'Independent consumed-source review/freeze and separately authorized disposable-runtime I1-I8 proof remain required; no auto selection, provisioning, LOGIN, activation or production acceptance.'
] as const);
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(child => freeze(child)); Object.freeze(value);
  }
  return value;
}
type Field = Readonly<{ name: string; type: string }>;
const fields = (spec: string): readonly Field[] => spec ? spec.split(',').map(part => {
  const tokens = part.trim().split(/\s+/), [name, type] = tokens;
  if (tokens.length !== 2 || !name || !/^[a-z][a-z0-9_]*$/.test(name) || !type
    || !/^(?:public\.)?[a-z][a-z0-9_]*(?:\[\])?$/.test(type)) throw new Error('Pipeline fixed field declaration malformed');
  return { name, type };
}) : [];
export type PipelineRoutineInventoryEntry = Readonly<{
  signature: string; arguments: readonly Field[]; outputs: readonly Field[];
  result: 'boolean' | 'trigger' | 'jsonb' | 'text' | 'record'; returnsSet: boolean;
  language: 'sql' | 'plpgsql'; securityDefiner: boolean; volatility: 'v';
  searchPath: 'search_path=pg_catalog'; inertOwner: 'swat_migrator';
}>;
function routine(name: string, args: string, result: PipelineRoutineInventoryEntry['result'],
  language: PipelineRoutineInventoryEntry['language'] = 'plpgsql', outputs = ''): PipelineRoutineInventoryEntry {
  const arguments_ = fields(args);
  return { signature: `public.${name}(${arguments_.map(a => a.type).join(',')})`, arguments: arguments_,
    outputs: fields(outputs), result, returnsSet: result === 'record', language,
    securityDefiner: result === 'record', volatility: 'v', searchPath: 'search_path=pg_catalog', inertOwner: 'swat_migrator' };
}
/** Explicit independent declaration inventory, NOT inferred expected signatures.
 * Both new lookup routines are plpgsql VOLATILE/default; exact output names/types
 * preserve TABLE modes. All seven worker APIs are INVOKER scalar JSONB. */
export const PIPELINE_ROUTINE_INVENTORY: readonly PipelineRoutineInventoryEntry[] = freeze([
  routine('swat_pipeline_external_dba', '', 'boolean', 'sql'),
  routine('swat_pipeline_external_enrollment', '', 'trigger'),
  routine('swat_pipeline_backend_capability', 'requested_purpose text,requested_authority text', 'record', 'plpgsql',
    'capability_id uuid,revision text,purpose text,authority_id text,runtime_role text,database_oid oid,system_identifier text,server_address text,server_port integer,backend_identity text,approved_terms jsonb,approved_terms_digest text,valid_from timestamptz,expires_at timestamptz,revoked_at timestamptz,provider_id text,chain text,network text,verifier_version text,identity_digest text,provider_valid_until timestamptz'),
  routine('swat_pipeline_approved', 'requested_purpose text,requested_selector text', 'jsonb'),
  routine('swat_pipeline_canonical_json', 'j jsonb', 'text'),
  routine('swat_pipeline_ordered_json', 'j jsonb,keys text[]', 'text'),
  routine('swat_pipeline_exact_follower_balance', 'requested_user uuid,requested_chain text,requested_target text,requested_token text,requested_mode text', 'record', 'plpgsql',
    'authority_id text,provider_id text,provider_identity text,enabled boolean,revoked_at timestamptz,user_id uuid,chain text,network text,target_account text,token_mint text,execution_mode text,evidence_id text,evidence_digest text,raw_available_usd text,usd_scale integer,available_usd text,observed_at timestamptz,expires_at timestamptz,provider_valid_until timestamptz,database_now timestamptz'),
  routine('swat_pipeline_worker_scope', 'requested_execution uuid,terms jsonb', 'boolean'),
  routine('swat_pipeline_register_worker_capability', 'requested_execution uuid,terms jsonb', 'jsonb'),
  routine('swat_pipeline_registry_guard', '', 'trigger'),
  routine('swat_pipeline_write_risk_policy', 'requested_execution uuid,terms jsonb', 'jsonb'),
  routine('swat_pipeline_valuation_authority_terms', 'a public.worker_valuation_authorities', 'jsonb', 'sql'),
  routine('guard_worker_valuation_authority', '', 'trigger'),
  routine('swat_pipeline_trusted_valuation_terms', 'v public.trusted_worker_valuations', 'jsonb', 'sql'),
  routine('guard_trusted_worker_valuation', '', 'trigger'),
  routine('swat_pipeline_register_worker_valuation_authority', 'requested_authority text,terms jsonb', 'jsonb'),
  routine('swat_pipeline_record_trusted_worker_valuation', 'requested_valuation text,terms jsonb', 'jsonb'),
  routine('swat_pipeline_paper_evidence_guard', '', 'trigger'),
  routine('swat_pipeline_paper_valuation', 'requested_execution uuid', 'jsonb'),
  routine('swat_pipeline_receipt_valid', 'requested_execution uuid,requested_fence bigint,terms jsonb', 'boolean'),
  routine('swat_pipeline_paper_receipt_guard', '', 'trigger'),
  routine('swat_pipeline_record_worker_paper_receipt', 'requested_execution uuid,requested_fence bigint,terms jsonb', 'jsonb'),
  routine('swat_pipeline_worker_paper_receipt', 'requested_execution uuid,requested_fence bigint,requested_evidence text', 'jsonb')
]);
export type PipelineColumnInventoryEntry = Readonly<{ name: string; type: string; notNull: boolean; defaultExpression: string | null }>;
function columns(spec: string): readonly PipelineColumnInventoryEntry[] {
  return spec.split(',').map(part => {
    const [name, type, nullable, defaultExpression] = part.trim().split(/\s+/);
    return { name: name!, type: type!, notNull: nullable !== '?', defaultExpression: defaultExpression ?? null };
  });
}
export const PIPELINE_RELATION_INVENTORY = freeze([
  { relation: 'public.pipeline_backend_approvals', columns: columns(
    'capability_id uuid,revision text,system_identifier text,database_name text,database_oid oid,server_address text,server_port integer,runtime_role name,purpose text,authority_id text,backend_identity text,approved_terms jsonb,approved_terms_canonical text,approved_terms_digest text,provider_id text ?,chain text ?,network text ?,verifier_version text ?,identity_digest text ?,provider_valid_until timestamptz ?,valid_from timestamptz,expires_at timestamptz,enrolled_by name,enrolled_at timestamptz,revoked_at timestamptz ?,revoked_by name ?') },
  { relation: 'public.pipeline_follower_authorities', columns: columns(
    'authority_id text,provider_id text,provider_identity text,chain text,network text,enabled boolean ! false,valid_until timestamptz,enrolled_by name,enrolled_at timestamptz,revoked_at timestamptz ?,revoked_by name ?') },
  { relation: 'public.pipeline_exact_follower_evidence', columns: columns(
    'evidence_id text,authority_id text,user_id uuid,chain text,network text,target_account text,token_mint text,execution_mode text,raw_available_usd text,usd_scale integer,available_usd text,observed_at timestamptz,expires_at timestamptz,evidence_digest text,evidence_canonical text,enrolled_by name,enrolled_at timestamptz,enabled boolean ! true,revoked_at timestamptz ?,revoked_by name ?') },
  { relation: 'public.pipeline_worker_registrations', columns: columns(
    'execution_id uuid,capability_id uuid,terms jsonb,registered_at timestamptz ! statement_timestamp()') },
  { relation: 'public.pipeline_paper_valuation_evidence', columns: columns(
    'evidence_id text,execution_id uuid,user_id uuid,authority_id text,source_trade_id uuid,source_evidence_id text,evidence_digest text,terms jsonb,recorded_at timestamptz ! statement_timestamp()') },
  { relation: 'public.pipeline_worker_paper_receipts', columns: columns(
    'receipt_id text,execution_id uuid,user_id uuid,worker_fence bigint,evidence_id text,paper_valuation_evidence_id text,terms jsonb,recorded_at timestamptz ! statement_timestamp()') }
]);
export type PipelineLocalForeignKey = Readonly<{
  relation: string; name: string; columns: readonly string[]; target: string; targetColumns: readonly string[];
  deleteAction: 'r'; updateAction: 'a'; matchType: 's'; deferrable: false; initiallyDeferred: false; validated: true;
}>;
function fk(table: string, column: string, target: string, targetColumn: string): PipelineLocalForeignKey {
  return { relation: `public.${table}`, name: `${table}_${column}_fkey`, columns: [column], target: `public.${target}`,
    targetColumns: [targetColumn], deleteAction: 'r', updateAction: 'a', matchType: 's', deferrable: false,
    initiallyDeferred: false, validated: true };
}
/** Exactly twelve local edges touching the six NEW088 relations. There is NO
 * evidence_id -> copy_execution_evidence FK on paper receipts and NO fabricated
 * original_evidence_id on prefill evidence. Canonical external-child dependencies
 * that touch only users/copy_executions/etc are outside this bounded inventory. */
export const PIPELINE_LOCAL_FK_INVENTORY: readonly PipelineLocalForeignKey[] = freeze([
  fk('pipeline_exact_follower_evidence', 'authority_id', 'pipeline_follower_authorities', 'authority_id'),
  fk('pipeline_exact_follower_evidence', 'user_id', 'users', 'id'),
  fk('pipeline_worker_registrations', 'execution_id', 'copy_executions', 'id'),
  fk('pipeline_worker_registrations', 'capability_id', 'worker_runtime_capabilities', 'capability_id'),
  fk('pipeline_paper_valuation_evidence', 'execution_id', 'copy_executions', 'id'),
  fk('pipeline_paper_valuation_evidence', 'user_id', 'users', 'id'),
  fk('pipeline_paper_valuation_evidence', 'authority_id', 'worker_valuation_authorities', 'authority_id'),
  fk('pipeline_paper_valuation_evidence', 'source_trade_id', 'source_trades', 'id'),
  fk('pipeline_paper_valuation_evidence', 'source_evidence_id', 'source_verified_evidence', 'evidence_id'),
  fk('pipeline_worker_paper_receipts', 'execution_id', 'copy_executions', 'id'),
  fk('pipeline_worker_paper_receipts', 'user_id', 'users', 'id'),
  fk('pipeline_worker_paper_receipts', 'paper_valuation_evidence_id', 'pipeline_paper_valuation_evidence', 'evidence_id')
]);
export const PIPELINE_ROLE_INVENTORY = freeze([
  { role: 'swat_source_provider_writer', ownership: [] as string[], purposes: ['source-register','source-intake','source-verify'] },
  { role: 'swat_fanout', ownership: [] as string[], purposes: ['fanout'] },
  { role: 'swat_capability_writer', ownership: [] as string[], purposes: ['worker-register'] },
  { role: 'swat_risk_writer', ownership: [] as string[], purposes: ['risk-write'] },
  { role: 'swat_valuation_writer', ownership: [] as string[], purposes: ['valuation-register','valuation-write','paper-valuation'] },
  { role: 'swat_worker_receipt_writer', ownership: [] as string[], purposes: ['paper-receipt'] },
  { role: 'swat_runtime_lookup', ownership: ['public.swat_claim_runtime_capability(uuid)', 'public.has_worker_execution_capability(uuid)'], purposes: [] as string[] }
]);
/** Unavailable exact permissions to be independently reviewed with current control,
 * tenant RLS and canonical joins. Exporting this list does NOT emit GRANTs or
 * complete the rest of the invoker settlement/lock/read closure. */
export const PIPELINE_RECEIPT_PERMISSION_PREREQUISITES = freeze({
  role: 'swat_worker_receipt_writer', canLogin: false, ownsObjects: false,
  execute: ['public.swat_pipeline_backend_capability(text,text)', 'public.swat_pipeline_approved(text,text)',
    'public.swat_pipeline_canonical_json(jsonb)', 'public.swat_pipeline_worker_scope(uuid,jsonb)',
    'public.swat_pipeline_receipt_valid(uuid,bigint,jsonb)', 'public.swat_pipeline_record_worker_paper_receipt(uuid,bigint,jsonb)'],
  insert: { relation: 'public.pipeline_worker_paper_receipts', columns:
    ['receipt_id','execution_id','user_id','worker_fence','evidence_id','paper_valuation_evidence_id','terms'] },
  unavailable: true, emitsGrants: false, scopedReadLockAndRlsClosureComplete: false
} as const);
export type PipelineSourceBytes = Readonly<{ sql088: Uint8Array; sql080: Uint8Array }>;
export type PipelineSourceBinding = Readonly<{
  sql088Bytes: readonly number[]; sql080Bytes: readonly number[];
  routines: readonly Readonly<{ signature: string; body: string; declaration: string }>[];
  status: typeof PIPELINE_PROVISIONING_STATUS; blockers: typeof PIPELINE_SOURCE_BLOCKERS;
}>;
function decode(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) throw new Error('Exact nonempty supplied source bytes required');
  // Preserve BOM/CRLF/whitespace. Reject malformed/non-roundtripping UTF-8, no hash.
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const encoded = new TextEncoder().encode(text);
  if (encoded.length !== bytes.length || encoded.some((v, i) => v !== bytes[i])) throw new Error('Exact UTF-8 source bytes required');
  return text;
}
function same(a: unknown, b: unknown): boolean {
  const ordered = (value: unknown): unknown => Array.isArray(value) ? value.map(ordered)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, ordered(child)])) : value;
  return JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));
}
/** Deliberately bounded SQL088 declaration reader, NOT a PostgreSQL parser or
 * installer. Unknown syntax refuses; no executable expression is evaluated.
 * Bodies remain byte-exact including whitespace, and are not security reviewed. */
function declarations(sql: string) {
  const pattern = /^CREATE (?:OR REPLACE )?FUNCTION public\.(\w+)\(([^)]*)\) RETURNS ([\s\S]*?) AS \$\$([\s\S]*?)\$\$;/gm;
  return [...sql.matchAll(pattern)].map(m => {
    const header = m[3]!.replace(/--[^\r\n]*/g, '').trim();
    const options = /^(TABLE\(([\s\S]*?)\)|boolean|trigger|jsonb|text)\s+LANGUAGE (sql|plpgsql) SECURITY (DEFINER|INVOKER) SET search_path=pg_catalog$/.exec(header);
    if (!options) throw new Error(`Pipeline signature/options drift: public.${m[1]}`);
    const args = fields(m[2]!);
    const entry = routine(m[1]!, m[2]!, options[1]!.startsWith('TABLE(') ? 'record' : options[1] as PipelineRoutineInventoryEntry['result'],
      options[3] as PipelineRoutineInventoryEntry['language'], options[2] ?? '');
    return { ...entry, securityDefiner: options[4] === 'DEFINER', body: m[4]!, declaration: m[0]!, offset: m.index!,
      signature: `public.${m[1]}(${args.map(a => a.type).join(',')})` };
  });
}
function splitTopLevel(text: string): string[] {
  const result: string[] = []; let start = 0, depth = 0, quoted = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "'") {
      if (quoted && text[i + 1] === "'") { i++; continue; }
      quoted = !quoted;
    } else if (!quoted) {
      if (text[i] === '(') depth++;
      if (text[i] === ')') depth--;
      if (depth < 0) throw new Error('Pipeline relation declaration unsupported');
      if (text[i] === ',' && depth === 0) { result.push(text.slice(start, i).trim()); start = i + 1; }
    }
  }
  if (quoted || depth !== 0) throw new Error('Pipeline relation declaration unsupported');
  result.push(text.slice(start).trim()); return result;
}
function relationDeclarations(sql: string) {
  return [...sql.matchAll(/^CREATE TABLE public\.(\w+) \(([\s\S]*?)\n\);/gm)].map(m => {
    const parts = splitTopLevel(m[2]!);
    const columnParts = parts.filter(p => !/^(?:CONSTRAINT|CHECK|UNIQUE|PRIMARY KEY|FOREIGN KEY)\b/.test(p));
    const parsedColumns = columnParts.map(p => {
      const c = /^(\w+) (uuid|text|oid|integer|name|jsonb|timestamptz|boolean|bigint)\b/.exec(p);
      if (!c) throw new Error('Pipeline relation column drift');
      const defaultMatch = /\bDEFAULT (statement_timestamp\(\)|false|true)(?=\s|$)/.exec(p);
      if (/\bDEFAULT\b/.test(p) && !defaultMatch) throw new Error('Pipeline relation default drift');
      return { name: c[1]!, type: c[2]!, notNull: /\b(?:NOT NULL|PRIMARY KEY)\b/.test(p), defaultExpression: defaultMatch?.[1] ?? null };
    });
    const fks = columnParts.filter(p => /\bREFERENCES\b/.test(p)).map(p => {
      const ref = /^(\w+) [\s\S]*? REFERENCES public\.(\w+)\((\w+)\) ON DELETE RESTRICT$/.exec(p);
      if (!ref) throw new Error('Pipeline local FK declaration drift');
      return fk(m[1]!, ref[1]!, ref[2]!, ref[3]!);
    });
    if (parts.some(p => /^(?:FOREIGN KEY|CONSTRAINT\b[\s\S]*?FOREIGN KEY)\b/.test(p))) throw new Error('Pipeline extra local FK declaration drift');
    return { relation: `public.${m[1]}`, columns: parsedColumns, fks };
  });
}
function validatePredecessors(sql088: string, sql080: string, found: ReturnType<typeof declarations>): void {
  for (const [name, tag] of [['guard_worker_valuation_authority','old080authority'], ['guard_trusted_worker_valuation','old080trusted']] as const) {
    const original = [...sql080.matchAll(/^CREATE FUNCTION public\.(guard_worker_valuation_authority|guard_trusted_worker_valuation)\(\) RETURNS trigger\s+LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS \$\$([\s\S]*?)\$\$;/gm)].filter(m => m[1] === name);
    const replacement = found.filter(p => p.signature === `public.${name}()`);
    const delimiter = `$${tag}$`;
    const first = sql088.indexOf(delimiter), last = sql088.indexOf(delimiter, first + delimiter.length);
    if (original.length !== 1 || replacement.length !== 1 || first < 0 || last < 0
      || sql088.indexOf(delimiter, last + delimiter.length) !== -1
      || sql088.slice(first + delimiter.length, last) !== original[0]![2]
      || last >= replacement[0]!.offset || sql088.indexOf('END $pin080$;') <= last
      || sql088.indexOf('END $pin080$;') >= replacement[0]!.offset) {
      throw new Error(`Pipeline predecessor-body/order drift: ${name}`);
    }
  }
  const enrollment = found.find(p => p.signature === 'public.swat_pipeline_external_enrollment()');
  const creation = sql088.indexOf('CREATE TABLE public.pipeline_follower_authorities (');
  if (!enrollment || creation < 0 || enrollment.offset >= creation
    || !/DECLARE follower record;/.test(enrollment.body)
    || /\b(?:public\.)?pipeline_follower_authorities\s*(?:%ROWTYPE)?\s*;/.test(enrollment.body)) {
    throw new Error('Pipeline premature follower rowtype/order drift');
  }
}
export function bindPipelineProvisioningSource(source: PipelineSourceBytes): PipelineSourceBinding {
  const sql088 = decode(source.sql088), sql080 = decode(source.sql080);
  const found = declarations(sql088);
  if (found.length !== PIPELINE_ROUTINE_INVENTORY.length
    || (sql088.match(/^CREATE (?:OR REPLACE )?FUNCTION\b/gm) ?? []).length !== found.length) throw new Error('Pipeline routine inventory drift');
  for (const expected of PIPELINE_ROUTINE_INVENTORY) {
    const actual = found.filter(p => p.signature === expected.signature);
    if (actual.length !== 1) throw new Error(`Pipeline signature drift: ${expected.signature}`);
    const { body: _body, declaration: _declaration, offset: _offset, ...shape } = actual[0]!;
    if (!same(shape, expected)) throw new Error(`Pipeline signature/options drift: ${expected.signature}`);
  }
  validatePredecessors(sql088, sql080, found);
  const relations = relationDeclarations(sql088);
  if (relations.length !== PIPELINE_RELATION_INVENTORY.length
    || (sql088.match(/^CREATE TABLE\b/gm) ?? []).length !== relations.length) throw new Error('Pipeline relation inventory drift');
  for (const expected of PIPELINE_RELATION_INVENTORY) {
    const actual = relations.filter(r => r.relation === expected.relation);
    if (actual.length !== 1 || !same(actual[0]!.columns, expected.columns)) throw new Error(`Pipeline relation/terms column drift: ${expected.relation}`);
    for (const flag of ['ENABLE','FORCE']) {
      if (!sql088.includes(`ALTER TABLE ${expected.relation} ${flag} ROW LEVEL SECURITY;`)) throw new Error('Pipeline FORCE RLS declaration missing');
    }
  }
  validatePipelineLocalForeignKeys(relations.flatMap(r => r.fks));
  return freeze({ sql088Bytes: Array.from(source.sql088), sql080Bytes: Array.from(source.sql080),
    routines: found.map(p => ({ signature: p.signature, body: p.body, declaration: p.declaration })),
    status: PIPELINE_PROVISIONING_STATUS, blockers: PIPELINE_SOURCE_BLOCKERS });
}
/** Caller-supplied facts are unauthenticated consistency input. Include EVERY FK
 * touching either end of a new088 relation, not just child-selected rows. Unrelated
 * canonical edges may coexist but cannot bless an incoming088 edge. Full P3
 * internal RI triggers/ownership/operators/dependencies remain explicit blockers. */
export function validatePipelineLocalForeignKeys(observed: readonly PipelineLocalForeignKey[]): void {
  if (!Array.isArray(observed)) throw new Error('Pipeline local FK inventory required');
  const boundary = PIPELINE_RELATION_INVENTORY.map(r => r.relation);
  const touching = observed.filter(f => boundary.includes(f.relation) || boundary.includes(f.target));
  if (touching.length !== PIPELINE_LOCAL_FK_INVENTORY.length) throw new Error('Pipeline local touching FK inventory drift');
  for (const expected of PIPELINE_LOCAL_FK_INVENTORY) {
    const actual = touching.filter(f => f.relation === expected.relation && f.name === expected.name);
    if (actual.length !== 1 || !same(actual[0], expected)) throw new Error(`Pipeline local FK shape drift: ${expected.name}`);
  }
}
export type PipelineInertRelationFact = Readonly<{
  relation: string; owner: 'swat_migrator'; kind: 'r'; rowSecurity: true; forceRowSecurity: true;
  columns: readonly PipelineColumnInventoryEntry[]; inheritanceParents: 0; inheritanceChildren: 0;
  partition: false;
}>;
/** Unauthenticated local shape facts only, not a check/index/ACL/policy-expression
 * or trigger dependency verifier. Exact physical terms must survive unchanged;
 * global catalog/incoming-FK and scoped invoker/observer closure stay blocked. */
export function validatePipelineInertRelationFacts(observed: readonly PipelineInertRelationFact[]): void {
  if (!Array.isArray(observed) || observed.length !== PIPELINE_RELATION_INVENTORY.length) throw new Error('Pipeline inert relation facts inventory drift');
  for (const expected of PIPELINE_RELATION_INVENTORY) {
    const rows = observed.filter(r => r.relation === expected.relation);
    const wanted: PipelineInertRelationFact = { relation: expected.relation, owner: 'swat_migrator', kind: 'r',
      rowSecurity: true, forceRowSecurity: true, columns: expected.columns, inheritanceParents: 0,
      inheritanceChildren: 0, partition: false };
    if (rows.length !== 1 || !same(rows[0], wanted)) throw new Error(`Pipeline inert relation/terms/owner/FORCE RLS facts drift: ${expected.relation}`);
  }
}
export function validatePipelineSourceBinding(binding: PipelineSourceBinding, current: PipelineSourceBytes): void {
  const fresh = bindPipelineProvisioningSource(current);
  if (!same(binding, fresh)) throw new Error('Pipeline exact supplied source bytes/binding drift');
}
export type PipelineRoutineFact = Readonly<{
  signature: string; body: string; owner: string; language: string; securityDefiner: boolean;
  resultType: string; argumentTypes: readonly string[]; argumentNames: readonly string[] | null;
  allArgumentTypes: readonly string[] | null; argumentModes: readonly string[] | null;
  returnsSet: boolean; searchPath: readonly string[]; kind: 'f'; volatility: 'v'; parallel: 'u';
  strict: false; leakproof: false; support: 0; variadic: 0; defaultCount: 0; defaults: null;
  cost: 100; rows: number; binary: null; sqlBody: null;
}>;
const catalogType = (type: string): string => type.startsWith('public.') ? type : `pg_catalog.${({
  integer: 'int4', bigint: 'int8', boolean: 'bool'
} as Record<string,string>)[type] ?? type}`;
/** EXACT inert local routine facts only; not a connection/transaction/catalog ACL
 * verifier, not disabled installation approval. Type identities use canonical
 * catalog names, including TABLE all-argument types/modes and scalar rows=0. */
export function validatePipelineInertRoutineFacts(binding: PipelineSourceBinding, current: PipelineSourceBytes,
  observed: readonly PipelineRoutineFact[]): void {
  validatePipelineSourceBinding(binding, current);
  if (!Array.isArray(observed) || observed.length !== PIPELINE_ROUTINE_INVENTORY.length) throw new Error('Pipeline inert routine facts inventory drift');
  for (const expected of PIPELINE_ROUTINE_INVENTORY) {
    const pins = binding.routines.find(r => r.signature === expected.signature)!;
    const rows = observed.filter(r => r.signature === expected.signature);
    const inputs = expected.arguments.map(a => catalogType(a.type)), outputs = expected.outputs.map(a => catalogType(a.type));
    const names = [...expected.arguments, ...expected.outputs].map(a => a.name);
    const wanted: PipelineRoutineFact = { signature: expected.signature, body: pins.body, owner: 'swat_migrator',
      language: expected.language, securityDefiner: expected.securityDefiner, resultType: catalogType(expected.result),
      argumentTypes: inputs, argumentNames: names.length ? names : null,
      allArgumentTypes: expected.returnsSet ? [...inputs, ...outputs] : null,
      argumentModes: expected.returnsSet ? [...inputs.map(() => 'i'), ...outputs.map(() => 't')] : null,
      returnsSet: expected.returnsSet, searchPath: ['search_path=pg_catalog'], kind: 'f', volatility: 'v', parallel: 'u',
      strict: false, leakproof: false, support: 0, variadic: 0, defaultCount: 0, defaults: null,
      cost: 100, rows: expected.returnsSet ? 1000 : 0, binary: null, sqlBody: null };
    if (rows.length !== 1 || !same(rows[0], wanted)) throw new Error(`Pipeline inert signature/body/options/owner facts drift: ${expected.signature}`);
  }
}
export type PipelineDisabledRoleFact = Readonly<{
  role: string; canLogin: false; superuser: false; bypassRls: false; inherit: false;
  createRole: false; createDb: false; replication: false; membershipsIn: 0; membershipsOut: 0;
  relationOwnership: 0; schemaOwnership: 0; databaseOwnership: 0; otherOwnership: 0;
  schemaCreate: false; databaseCreate: false; ownedFunctions: readonly string[];
}>;
export function validatePipelineDisabledRoleFacts(observed: readonly PipelineDisabledRoleFact[],
  phase: 'inert' | 'backend-owner-committed' | 'both-lookup-owners-committed'): void {
  if (!['inert','backend-owner-committed','both-lookup-owners-committed'].includes(phase)
    || !Array.isArray(observed) || observed.length !== PIPELINE_ROLE_INVENTORY.length) throw new Error('Pipeline disabled role facts inventory drift');
  for (const expected of PIPELINE_ROLE_INVENTORY) {
    const rows = observed.filter(r => r.role === expected.role);
    const extra = expected.role !== 'swat_runtime_lookup' || phase === 'inert' ? [] :
      phase === 'backend-owner-committed' ? [PIPELINE_NEW_LOOKUP_ROUTINES[0]] : [...PIPELINE_NEW_LOOKUP_ROUTINES];
    const wanted: PipelineDisabledRoleFact = { role: expected.role, canLogin: false, superuser: false, bypassRls: false,
      inherit: false, createRole: false, createDb: false, replication: false, membershipsIn: 0, membershipsOut: 0,
      relationOwnership: 0, schemaOwnership: 0, databaseOwnership: 0, otherOwnership: 0, schemaCreate: false,
      databaseCreate: false, ownedFunctions: [...expected.ownership, ...extra].sort() };
    if (rows.length !== 1 || !same({ ...rows[0], ownedFunctions: [...rows[0]!.ownedFunctions].sort() }, wanted)) throw new Error(`Pipeline disabled flags/ownership/membership facts drift: ${expected.role}`);
  }
}
export type PipelineExternalAuditReferences = Readonly<{ receiptWriter: string; backendLookup: string; followerLookup: string }>;
export type PipelineProvisioningProposal = Readonly<{
  source: PipelineSourceBinding; status: typeof PIPELINE_PROVISIONING_STATUS;
  separateExternalDbaCommits: readonly Readonly<{
    stage: 'disabled-receipt-writer' | 'backend-lookup-owner' | 'follower-lookup-owner';
    auditReference: string; proposedStatements: readonly string[]; readyToExecute: false;
    requires: readonly string[];
  }>[];
  blockers: typeof PIPELINE_SOURCE_BLOCKERS;
}>;
/** Three SEPARATE externally audited DBA commits, never a migration/broker step.
 * These statements are an UNREVIEWED proposal, NOT guarded executable provisioning.
 * Direct external DBA must independently authenticate its lease, exact catalog,
 * source review, role flags/ownership and absent unsafe grants before any use.
 * There are deliberately NO grant/policy/credential/enrollment/LOGIN statements. */
export function createPipelineProvisioningProposal(source: PipelineSourceBytes, references: PipelineExternalAuditReferences): PipelineProvisioningProposal {
  const binding = bindPipelineProvisioningSource(source);
  const refs = [references?.receiptWriter, references?.backendLookup, references?.followerLookup];
  if (refs.some(ref => typeof ref !== 'string' || ref.trim() !== ref || ref.length < 8 || ref.length > 512 || /[\u0000-\u001f]/.test(ref))
    || new Set(refs).size !== 3) throw new Error('Three distinct external audit references required; labels are not approval');
  return freeze({ source: binding, status: PIPELINE_PROVISIONING_STATUS, blockers: PIPELINE_SOURCE_BLOCKERS,
    separateExternalDbaCommits: [
      { stage: 'disabled-receipt-writer', auditReference: references.receiptWriter, readyToExecute: false,
        proposedStatements: [
          'CREATE ROLE swat_worker_receipt_writer NOLOGIN PASSWORD NULL NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEROLE NOCREATEDB NOREPLICATION;',
          'ALTER ROLE swat_worker_receipt_writer SET row_security=on;',
          'ALTER ROLE swat_worker_receipt_writer SET search_path=pg_catalog;'
        ], requires: ['Inert exact088 migration committed separately; receipt role absent, not a reused runtime/financial writer.',
          'Authenticated direct external DBA; independently reviewed absent PUBLIC/default ACL, CREATE, ownership and all memberships.',
          'Commit disabled nonowning role separately; exact permission prerequisites remain unavailable; no LOGIN or automatic grants.'] },
      { stage: 'backend-lookup-owner', auditReference: references.backendLookup, readyToExecute: false,
        proposedStatements: ['ALTER FUNCTION public.swat_pipeline_backend_capability(text,text) OWNER TO swat_runtime_lookup;'],
        requires: ['Inert exact088 committed; disabled receipt-role DBA commit audited; broker retired without expanding old seven079082.',
          'Authenticate direct external DBA and compare exact supplied body/signature/options/current migrator owner/ACL/catalog dependencies.',
          'Disabled lookup owns exactly old079 pair beforehand; independently review lookup read/FOR SHARE/RLS/pg_control_system prerequisites.',
          'Separate audited COMMIT; ownership-only does not grant writer execution, SELECT, UPDATE lock rights or tenant policies.'] },
      { stage: 'follower-lookup-owner', auditReference: references.followerLookup, readyToExecute: false,
        proposedStatements: ['ALTER FUNCTION public.swat_pipeline_exact_follower_balance(uuid,text,text,text,text) OWNER TO swat_runtime_lookup;'],
        requires: ['Backend ownership committed and independently audited; lookup owns exactly old079 pair plus backend088 beforehand.',
          'Authenticate direct external DBA and compare exact supplied follower body, plpgsql/default-volatility, input/output modes and migrator owner/ACL.',
          'Independently review follower authority/evidence FOR SHARE, advisory scope lock, fixed-order digest and post-wait time/expiry closure.',
          'Separate audited COMMIT; final four lookup functions only. NO broker, GRANT, observer enrollment, LOGIN or automatic activation.'] }
    ] });
}

export interface PipelineQueryClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: unknown[]
  ): Promise<{ rows: T[]; command?: string; rowCount?: number | null }>;
}

export interface PipelineClientLease {
  readonly client: PipelineQueryClient;
  release(broken: boolean): void;
}

export type PipelineCatalogPhase =
  | 'inert'
  | 'disabled-receipt-writer'
  | 'backend-owner-committed'
  | 'both-lookup-owners-committed';

export class PipelineCommitUncertainError extends Error {
  constructor(message = 'Pipeline DBA COMMIT uncertain; discard lease and reconcile externally') {
    super(message);
    this.name = 'PipelineCommitUncertainError';
  }
}

const VALID_ROLE_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;
const PIPELINE_PHASES: readonly PipelineCatalogPhase[] = [
  'inert',
  'disabled-receipt-writer',
  'backend-owner-committed',
  'both-lookup-owners-committed'
];
const PIPELINE_BROKER_LOOKUP_PAIR = [
  'public.swat_claim_runtime_capability(uuid)',
  'public.has_worker_execution_capability(uuid)'
] as const;

function assertValidPipelineRoleName(role: string, kind: 'dba' | 'migrator' | 'restricted'): void {
  if (typeof role !== 'string' || !VALID_ROLE_PATTERN.test(role)) {
    throw new Error('Pipeline invalid direct role identifier');
  }
  if (kind === 'dba' && role.startsWith('swat_')) {
    throw new Error('Pipeline distinct direct external DBA identity required');
  }
  if (kind === 'migrator' && role !== 'swat_migrator') {
    throw new Error('Pipeline direct swat_migrator identity required');
  }
  if (kind === 'restricted' && (!role.startsWith('swat_') || role === 'swat_migrator')) {
    throw new Error('Pipeline restricted swat_* identity required');
  }
}

export async function assertWave4PipelineRoleWithClient(
  client: PipelineQueryClient,
  role: string,
  kind: 'dba' | 'migrator' | 'restricted',
  clean = false
): Promise<number> {
  if (!client || typeof client.query !== 'function') {
    throw new Error('Pipeline query client required');
  }
  assertValidPipelineRoleName(role, kind);
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
    throw new Error('Pipeline direct role identity/session/RLS/membership/transaction check failed');
  }
  if (kind === 'dba') {
    if (r.superuser !== true) {
      throw new Error('Pipeline authenticated direct external superuser DBA backend required');
    }
  } else {
    if (
      r.superuser !== false || r.bypass_rls !== false || r.inherit !== false
      || r.create_role !== false || r.create_db !== false || r.replication !== false
    ) {
      throw new Error('Pipeline restricted role privilege escalation rejected');
    }
  }
  return r.backend;
}

function expectedPipelineLookupFunctions(phase: PipelineCatalogPhase): string[] {
  if (phase === 'inert' || phase === 'disabled-receipt-writer') {
    return [...PIPELINE_BROKER_LOOKUP_PAIR].sort();
  }
  if (phase === 'backend-owner-committed') {
    return [...PIPELINE_BROKER_LOOKUP_PAIR, PIPELINE_NEW_LOOKUP_ROUTINES[0]].sort();
  }
  return [...PIPELINE_BROKER_LOOKUP_PAIR, ...PIPELINE_NEW_LOOKUP_ROUTINES].sort();
}

function expectedPipelineRoutineOwner(signature: string, phase: PipelineCatalogPhase): string {
  if (signature === PIPELINE_NEW_LOOKUP_ROUTINES[0] && (phase === 'backend-owner-committed' || phase === 'both-lookup-owners-committed')) {
    return 'swat_runtime_lookup';
  }
  if (signature === PIPELINE_NEW_LOOKUP_ROUTINES[1] && phase === 'both-lookup-owners-committed') {
    return 'swat_runtime_lookup';
  }
  return 'swat_migrator';
}

export const PIPELINE_ROUTINE_NON_OWNER_GRANTEES: Readonly<Record<string, readonly string[]>> = freeze({
  'public.swat_pipeline_external_dba()': [],
  'public.swat_pipeline_external_enrollment()': [],
  'public.swat_pipeline_backend_capability(text,text)': [],
  'public.swat_pipeline_approved(text,text)': [
    'swat_source_provider_writer',
    'swat_fanout',
    'swat_capability_writer',
    'swat_risk_writer',
    'swat_valuation_writer'
  ],
  'public.swat_pipeline_canonical_json(jsonb)': [
    'swat_source_provider_writer',
    'swat_fanout',
    'swat_capability_writer',
    'swat_risk_writer',
    'swat_valuation_writer'
  ],
  'public.swat_pipeline_ordered_json(jsonb,text[])': [
    'swat_source_provider_writer',
    'swat_fanout',
    'swat_runtime_lookup'
  ],
  'public.swat_pipeline_exact_follower_balance(uuid,text,text,text,text)': [],
  'public.swat_pipeline_worker_scope(uuid,jsonb)': [
    'swat_capability_writer',
    'swat_risk_writer',
    'swat_valuation_writer'
  ],
  'public.swat_pipeline_register_worker_capability(uuid,jsonb)': ['swat_capability_writer'],
  'public.swat_pipeline_registry_guard()': [],
  'public.swat_pipeline_write_risk_policy(uuid,jsonb)': ['swat_risk_writer'],
  'public.swat_pipeline_valuation_authority_terms(public.worker_valuation_authorities)': ['swat_valuation_writer'],
  'public.guard_worker_valuation_authority()': [],
  'public.swat_pipeline_trusted_valuation_terms(public.trusted_worker_valuations)': ['swat_valuation_writer'],
  'public.guard_trusted_worker_valuation()': [],
  'public.swat_pipeline_register_worker_valuation_authority(text,jsonb)': ['swat_valuation_writer'],
  'public.swat_pipeline_record_trusted_worker_valuation(text,jsonb)': ['swat_valuation_writer'],
  'public.swat_pipeline_paper_evidence_guard()': [],
  'public.swat_pipeline_paper_valuation(uuid)': ['swat_valuation_writer'],
  'public.swat_pipeline_receipt_valid(uuid,bigint,jsonb)': ['swat_app'],
  'public.swat_pipeline_paper_receipt_guard()': [],
  'public.swat_pipeline_record_worker_paper_receipt(uuid,bigint,jsonb)': [],
  'public.swat_pipeline_worker_paper_receipt(uuid,bigint,text)': ['swat_app']
});

export function expectedPipelineRoutineExecuteGrantees(signature: string, phase: PipelineCatalogPhase): string[] {
  if (!Object.hasOwn(PIPELINE_ROUTINE_NON_OWNER_GRANTEES, signature)) {
    throw new Error(`Unknown pipeline routine signature: ${signature}`);
  }
  const expectedOwner = expectedPipelineRoutineOwner(signature, phase);
  const nonOwner = PIPELINE_ROUTINE_NON_OWNER_GRANTEES[signature]!;
  return Array.from(new Set([expectedOwner, ...nonOwner])).sort();
}

export async function validateWave4PipelineCommittedCatalog(input: {
  client: PipelineQueryClient;
  dbaRole: string;
  source: PipelineSourceBytes;
  phase: PipelineCatalogPhase;
}): Promise<void> {
  if (!PIPELINE_PHASES.includes(input.phase)) {
    throw new Error('Pipeline catalog phase required');
  }
  const binding = bindPipelineProvisioningSource(input.source);
  await assertWave4PipelineRoleWithClient(input.client, input.dbaRole, 'dba');
  await input.client.query("SELECT set_config('search_path','pg_catalog',true)");

  const roleNames = PIPELINE_ROLE_INVENTORY.map(r => r.role);
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
    EXISTS(SELECT 1 FROM pg_catalog.pg_shdepend d WHERE d.refclassid='pg_catalog.pg_authid'::regclass AND d.refobjid=r.oid AND d.deptype='o'
      AND NOT(d.dbid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND d.classid='pg_proc'::regclass
        AND d.objsubid=0 AND d.objid=ANY($2::regprocedure[]))) AS extra_ownership
    FROM pg_catalog.pg_roles r WHERE r.rolname = ANY($1::text[])`, [roleNames, [...PIPELINE_BROKER_LOOKUP_PAIR, ...PIPELINE_NEW_LOOKUP_ROUTINES]]);

  const requiredInPhase = input.phase === 'inert'
    ? roleNames.filter(name => name !== 'swat_worker_receipt_writer')
    : roleNames;
  for (const name of requiredInPhase) {
    if (!roleRows.some(r => r.rolname === name)) {
      throw new Error(`Pipeline required role missing: ${name}`);
    }
  }
  const expectedLookupFuncs = expectedPipelineLookupFunctions(input.phase);
  for (const r of roleRows) {
    if (!roleNames.includes(r.rolname)) {
      throw new Error(`Pipeline unexpected role row: ${r.rolname}`);
    }
    const expectedFuncs = r.rolname === 'swat_runtime_lookup' ? expectedLookupFuncs : [];
    if (
      r.rolcanlogin !== false || r.unsafe !== false || r.membership !== false
      || r.owns !== false || r.extra_ownership !== false || r.can_create !== false
      || !Array.isArray(r.functions)
      || JSON.stringify([...r.functions].sort()) !== JSON.stringify(expectedFuncs)
    ) {
      throw new Error(`Pipeline role flags/ownership/CREATE/membership drift: ${r.rolname}`);
    }
  }

  const { rows: settings } = await input.client.query<{
    rolname: string;
    setdatabase: unknown;
    setconfig: unknown;
  }>(`SELECT r.rolname, s.setdatabase, s.setconfig FROM pg_catalog.pg_db_role_setting s
    JOIN pg_catalog.pg_roles r ON r.oid = s.setrole WHERE r.rolname = ANY($1::text[])`, [roleNames]);
  const allowedSettings = ['row_security=on', 'search_path=pg_catalog', 'search_path=pg_catalog, public'];
  for (const s of settings) {
    if (Number(s.setdatabase) !== 0 || !Array.isArray(s.setconfig) || s.setconfig.some(v => typeof v !== 'string' || !allowedSettings.includes(v))) {
      throw new Error(`Pipeline role GUC settings drift: ${s.rolname}`);
    }
  }
  if (input.phase !== 'inert') {
    const receiptSetting = settings.find(s => s.rolname === 'swat_worker_receipt_writer');
    if (
      !receiptSetting || !Array.isArray(receiptSetting.setconfig)
      || !receiptSetting.setconfig.includes('row_security=on')
      || !receiptSetting.setconfig.includes('search_path=pg_catalog')
    ) {
      throw new Error('Pipeline swat_worker_receipt_writer GUC defaults missing');
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
    WHERE n.nspname = 'public'`, [roleNames]);
  if (nsRows.length !== 1 || nsRows[0]!.owner !== 'swat_migrator' || nsRows[0]!.restricted_or_public_create !== false) {
    throw new Error('Pipeline public namespace ownership or CREATE privilege drift');
  }

  const relationNames = PIPELINE_RELATION_INVENTORY.map(r => r.relation);
  const { rows: relRows } = await input.client.query<{
    relation: string;
    owner: string;
    relkind: string;
    relrowsecurity: boolean;
    relforcerowsecurity: boolean;
    public_or_grantable_acl: boolean;
  }>(`SELECT ('public.' || c.relname) AS relation, r.rolname AS owner, c.relkind, c.relrowsecurity, c.relforcerowsecurity,
    (EXISTS(SELECT 1 FROM aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a WHERE a.grantee = 0 OR a.is_grantable)
     OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute at CROSS JOIN LATERAL aclexplode(at.attacl) a
       WHERE at.attrelid = c.oid AND at.attnum > 0 AND NOT at.attisdropped AND (a.grantee = 0 OR a.is_grantable))) AS public_or_grantable_acl
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_roles r ON r.oid = c.relowner
    WHERE c.oid = ANY($1::regclass[])`, [relationNames]);
  if (relRows.length !== relationNames.length) {
    throw new Error('Pipeline relation inventory missing');
  }
  for (const expectedRel of relationNames) {
    const actual = relRows.find(r => r.relation === expectedRel);
    if (
      !actual || actual.owner !== 'swat_migrator' || actual.relkind !== 'r'
      || actual.relrowsecurity !== true || actual.relforcerowsecurity !== true
      || actual.public_or_grantable_acl !== false
    ) {
      throw new Error(`Pipeline relation FORCE RLS/ownership/ACL drift: ${expectedRel}`);
    }
  }

  const expectedSignatures = PIPELINE_ROUTINE_INVENTORY.map(r => r.signature);
  const { rows: procRows } = await input.client.query<{
    signature: string;
    owner: string;
    prosrc: string;
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
  }>(`SELECT p.oid::regprocedure::text AS signature, r.rolname AS owner, p.prosrc, p.prokind, p.prosecdef,
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
  if (procRows.length !== PIPELINE_ROUTINE_INVENTORY.length) {
    throw new Error('Pipeline routine catalog inventory missing');
  }
  for (const expected of PIPELINE_ROUTINE_INVENTORY) {
    const pin = binding.routines.find(r => r.signature === expected.signature)!;
    const actual = procRows.find(r => r.signature === expected.signature);
    const expectedOwner = expectedPipelineRoutineOwner(expected.signature, input.phase);
    const expectedGrantees = expectedPipelineRoutineExecuteGrantees(expected.signature, input.phase);
    if (
      !actual || actual.owner !== expectedOwner || actual.prosrc !== pin.body
      || actual.prokind !== 'f' || actual.prosecdef !== expected.securityDefiner
      || actual.proisstrict !== false || actual.proleakproof !== false
      || actual.provolatile !== 'v' || actual.proparallel !== 'u'
      || actual.pronargdefaults !== 0 || actual.lanname !== expected.language
      || JSON.stringify(actual.proconfig) !== JSON.stringify(['search_path=pg_catalog'])
      || !Array.isArray(actual.acl)
      || actual.acl.some(a => typeof a?.grantee !== 'string' || a.grantee === 'PUBLIC' || a.grantable !== false || a.privilege !== 'EXECUTE' || a.grantor !== expectedOwner)
      || JSON.stringify(actual.acl.map(a => a.grantee).sort()) !== JSON.stringify(expectedGrantees)
    ) {
      throw new Error(`Pipeline routine catalog signature/body/owner/ACL drift: ${expected.signature}`);
    }
  }

  const { rows: brokerRows } = await input.client.query<{
    signature: string;
    owner: string;
  }>(`SELECT p.oid::regprocedure::text AS signature, r.rolname AS owner
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
    WHERE p.oid = ANY($1::regprocedure[])`, [[...PIPELINE_EXISTING_BROKER_BOUNDARY]]);
  if (
    brokerRows.length !== PIPELINE_EXISTING_BROKER_BOUNDARY.length
    || brokerRows.some(b => (PIPELINE_ROUTINE_INVENTORY as readonly { signature: string }[]).some(r => r.signature === b.signature))
  ) {
    throw new Error('Pipeline existing 079/082 broker boundary drift');
  }

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
    WHERE c.oid = ANY($1::regclass[])`, [relationNames]);
  for (const pol of policyRows) {
    if (
      pol.polpermissive && (
        pol.using_expr === 'true' || pol.using_expr === '(true)'
        || pol.check_expr === 'true' || pol.check_expr === '(true)'
        || (Array.isArray(pol.roles) && pol.roles.includes('PUBLIC'))
      )
    ) {
      throw new Error(`Pipeline permissive policy rejected on ${pol.relation}: ${pol.polname}`);
    }
  }

  const { rows: fkRows } = await input.client.query<{
    relation: string;
    name: string;
    columns: string[];
    target: string;
    target_columns: string[];
    delete_action: string;
    update_action: string;
    match_type: string;
    deferrable: boolean;
    initially_deferred: boolean;
    validated: boolean;
  }>(`SELECT (ns.nspname || '.' || cl.relname) AS relation, con.conname AS name,
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
    WHERE con.contype = 'f' AND (con.conrelid = ANY($1::regclass[]) OR con.confrelid = ANY($1::regclass[]))`, [relationNames]);
  if (fkRows.length !== PIPELINE_LOCAL_FK_INVENTORY.length) {
    throw new Error('Pipeline local touching FK count drift');
  }
  for (const expectedFk of PIPELINE_LOCAL_FK_INVENTORY) {
    const actual = fkRows.filter(f => f.relation === expectedFk.relation && f.name === expectedFk.name);
    if (
      actual.length !== 1
      || actual[0]!.target !== expectedFk.target
      || JSON.stringify(actual[0]!.columns) !== JSON.stringify(expectedFk.columns)
      || JSON.stringify(actual[0]!.target_columns) !== JSON.stringify(expectedFk.targetColumns)
      || actual[0]!.delete_action !== expectedFk.deleteAction
      || actual[0]!.update_action !== expectedFk.updateAction
      || actual[0]!.match_type !== expectedFk.matchType
      || actual[0]!.deferrable !== expectedFk.deferrable
      || actual[0]!.initially_deferred !== expectedFk.initiallyDeferred
      || actual[0]!.validated !== expectedFk.validated
    ) {
      throw new Error(`Pipeline local FK catalog shape drift: ${expectedFk.name}`);
    }
  }
}

export async function validateWave4PipelineInstallation(input: {
  acquire: () => Promise<PipelineClientLease>;
  dbaRole: string;
  source: PipelineSourceBytes;
  phase: PipelineCatalogPhase;
}): Promise<void> {
  bindPipelineProvisioningSource(input.source);
  if (typeof input.acquire !== 'function') {
    throw new Error('Pipeline owned external DBA lease required');
  }
  const lease = await input.acquire();
  let open = false, committing = false, broken = false;
  try {
    const backend = await assertWave4PipelineRoleWithClient(lease.client, input.dbaRole, 'dba', true);
    const begin = await lease.client.query('BEGIN READ ONLY');
    if (begin.command !== 'BEGIN') throw new Error('Pipeline catalog BEGIN READ ONLY refused');
    open = true;
    await lease.client.query("SELECT set_config('statement_timeout','15000',true),set_config('lock_timeout','5000',true),set_config('idle_in_transaction_session_timeout','30000',true)");
    await validateWave4PipelineCommittedCatalog({ client: lease.client, dbaRole: input.dbaRole, source: input.source, phase: input.phase });
    if (await assertWave4PipelineRoleWithClient(lease.client, input.dbaRole, 'dba') !== backend) {
      throw new Error('Pipeline catalog backend PID changed');
    }
    committing = true;
    const commit = await lease.client.query('COMMIT');
    if (commit.command !== 'COMMIT') throw new PipelineCommitUncertainError();
    open = false; committing = false;
  } catch (error) {
    broken = true;
    if (committing) {
      throw error instanceof PipelineCommitUncertainError ? error : new PipelineCommitUncertainError();
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

export async function provisionWave4PipelineCompanion(input: {
  acquire: () => Promise<PipelineClientLease>;
  dbaRole: string;
  source: PipelineSourceBytes;
  stage?: 'disabled-receipt-writer' | 'backend-lookup-owner' | 'follower-lookup-owner' | 'all';
}): Promise<void> {
  bindPipelineProvisioningSource(input.source);
  if (typeof input.acquire !== 'function') {
    throw new Error('Pipeline owned external DBA lease required');
  }
  const stage = input.stage ?? 'all';
  if (!['disabled-receipt-writer', 'backend-lookup-owner', 'follower-lookup-owner', 'all'].includes(stage)) {
    throw new Error('Pipeline provisioning stage unsupported');
  }
  const prereqPhase: PipelineCatalogPhase =
    stage === 'backend-lookup-owner' ? 'disabled-receipt-writer'
      : stage === 'follower-lookup-owner' ? 'backend-owner-committed'
      : 'inert';
  const targetPhase: PipelineCatalogPhase =
    stage === 'disabled-receipt-writer' ? 'disabled-receipt-writer'
      : stage === 'backend-lookup-owner' ? 'backend-owner-committed'
      : 'both-lookup-owners-committed';

  const lease = await input.acquire();
  let open = false, committing = false, broken = false;
  try {
    const backend = await assertWave4PipelineRoleWithClient(lease.client, input.dbaRole, 'dba', true);
    const begin = await lease.client.query('BEGIN');
    if (begin.command !== 'BEGIN') throw new Error('Pipeline DBA BEGIN refused');
    open = true;
    await lease.client.query("SELECT set_config('statement_timeout','15000',true),set_config('lock_timeout','5000',true),set_config('idle_in_transaction_session_timeout','30000',true)");
    await lease.client.query("SELECT set_config('search_path','pg_catalog',true)");
    await lease.client.query(
      'LOCK TABLE public.pipeline_backend_approvals, public.pipeline_follower_authorities, public.pipeline_exact_follower_evidence, public.pipeline_worker_registrations, public.pipeline_paper_valuation_evidence, public.pipeline_worker_paper_receipts IN ACCESS EXCLUSIVE MODE'
    );
    await validateWave4PipelineCommittedCatalog({ client: lease.client, dbaRole: input.dbaRole, source: input.source, phase: prereqPhase });

    if (stage === 'disabled-receipt-writer' || stage === 'all') {
      await lease.client.query(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'swat_worker_receipt_writer') THEN
          CREATE ROLE swat_worker_receipt_writer NOLOGIN PASSWORD NULL NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEROLE NOCREATEDB NOREPLICATION;
        END IF;
      END $$`);
      await lease.client.query('ALTER ROLE swat_worker_receipt_writer SET row_security=on');
      await lease.client.query('ALTER ROLE swat_worker_receipt_writer SET search_path=pg_catalog');
    }

    const transferRoutines: string[] = [];
    if (stage === 'backend-lookup-owner' || stage === 'all') {
      transferRoutines.push(PIPELINE_NEW_LOOKUP_ROUTINES[0]);
    }
    if (stage === 'follower-lookup-owner' || stage === 'all') {
      transferRoutines.push(PIPELINE_NEW_LOOKUP_ROUTINES[1]);
    }
    if (transferRoutines.length > 0) {
      await lease.client.query('GRANT CREATE ON SCHEMA public TO swat_runtime_lookup');
      for (const sig of transferRoutines) {
        await lease.client.query(`ALTER FUNCTION ${sig} OWNER TO swat_runtime_lookup`);
        await lease.client.query(
          `REVOKE ALL ON FUNCTION ${sig} FROM PUBLIC, swat_app, swat_fanout, swat_source_provider_writer, swat_capability_writer, swat_risk_writer, swat_valuation_writer, swat_worker_receipt_writer, swat_migrator`
        );
      }
      await lease.client.query('REVOKE CREATE ON SCHEMA public FROM swat_runtime_lookup');
    }

    await validateWave4PipelineCommittedCatalog({ client: lease.client, dbaRole: input.dbaRole, source: input.source, phase: targetPhase });
    if (await assertWave4PipelineRoleWithClient(lease.client, input.dbaRole, 'dba') !== backend) {
      throw new Error('Pipeline DBA backend PID drift');
    }
    committing = true;
    const commit = await lease.client.query('COMMIT');
    if (commit.command !== 'COMMIT') throw new PipelineCommitUncertainError();
    open = false; committing = false;
  } catch (error) {
    broken = true;
    if (committing) {
      throw error instanceof PipelineCommitUncertainError ? error : new PipelineCommitUncertainError();
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

  await validateWave4PipelineInstallation({
    acquire: input.acquire,
    dbaRole: input.dbaRole,
    source: input.source,
    phase: targetPhase
  });
}
