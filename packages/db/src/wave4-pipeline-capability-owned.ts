import type { PoolClient } from 'pg';
import { createCheckedPipelineTransaction, readPipelineBackendApproval, pipelineRequire, pipelineText,
  pipelineTime, pipelineUuid, type PipelineClientLease, type PipelineProtectedRole,
  type PipelineProtectedPurpose } from './wave4-pipeline-source-owned.js';

/** Forward SOURCE contracts, not installed-schema claims. All routines below are
 * migrator-owned SECURITY INVOKER: do not add an eighth SQL079082 broker transfer.
 * Each writer routine must independently rejoin the shared protected approval,
 * canonical execution/obligation/policy and exact payload under FORCE RLS. */
export const PIPELINE_WORKER_ROUTINES = Object.freeze({
  register: { signature: 'public.swat_pipeline_register_worker_capability(uuid,jsonb)', role: 'swat_capability_writer' },
  risk: { signature: 'public.swat_pipeline_write_risk_policy(uuid,jsonb)', role: 'swat_risk_writer' },
  authority: { signature: 'public.swat_pipeline_register_worker_valuation_authority(text,jsonb)', role: 'swat_valuation_writer' },
  valuation: { signature: 'public.swat_pipeline_record_trusted_worker_valuation(text,jsonb)', role: 'swat_valuation_writer' },
  paper: { signature: 'public.swat_pipeline_paper_valuation(uuid)', role: 'swat_valuation_writer' },
  receiptWrite: { signature: 'public.swat_pipeline_record_worker_paper_receipt(uuid,bigint,jsonb)', role: 'swat_worker_receipt_writer' },
  receiptRead: { signature: 'public.swat_pipeline_worker_paper_receipt(uuid,bigint,text)', role: 'swat_app' }
} as const);
export type PipelineWorkerRoutine = keyof typeof PIPELINE_WORKER_ROUTINES;
export async function requirePipelineWorkerRoutine(client: PoolClient, routine: PipelineWorkerRoutine): Promise<void> {
  const expected = PIPELINE_WORKER_ROUTINES[routine];
  const result = await client.query(`SELECT p.prosecdef,p.proconfig,p.prokind,p.provolatile,p.proretset,
    p.pronargdefaults,p.provariadic,p.proleakproof,p.proisstrict,p.prorettype='pg_catalog.jsonb'::regtype AS json_result,
    owner.rolname AS owner_role,owner.rolsuper,owner.rolbypassrls,owner.rolinherit,
    owner.rolcreaterole,owner.rolcreatedb,owner.rolreplication,
    EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=owner.oid OR roleid=owner.oid) AS memberships,
    current_user::text AS runtime_role,session_user::text AS session_role,current_setting('role') AS role_setting,
    current_setting('row_security') AS row_security,
    has_function_privilege(current_user,p.oid,'EXECUTE') AS executable,
    (SELECT count(*) FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner)))) AS acl_count,
    NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
      WHERE a.grantor<>p.proowner OR a.is_grantable OR a.privilege_type<>'EXECUTE'
        OR a.grantee NOT IN(p.proowner,(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=$2))) AS exact_acl
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles owner ON owner.oid=p.proowner
    WHERE p.oid=to_regprocedure($1)`, [expected.signature,expected.role]);
  const r = result.rows[0];
  pipelineRequire(result.rows.length === 1 && r.prosecdef === false && r.owner_role === 'swat_migrator'
    && r.prokind === 'f' && r.provolatile === 'v' && r.proretset === false && r.pronargdefaults === 0
    && r.provariadic === 0 && r.proleakproof === false && r.proisstrict === false && r.json_result === true
    && Array.isArray(r.proconfig) && r.proconfig.length === 1 && r.proconfig[0] === 'search_path=pg_catalog'
    && r.runtime_role === expected.role && r.session_role === expected.role && r.role_setting === 'none'
    && r.row_security === 'on' && r.executable === true && r.exact_acl === true && Number(r.acl_count) === 2
    && ['rolsuper','rolbypassrls','rolinherit','rolcreaterole','rolcreatedb','rolreplication','memberships']
      .every(k => r[k] === false), `${routine} fixed protected function/source ACL unavailable`);
}

/** Plain immutable exact JSON only. No getters, serialization hooks or labels
 * can change an approved payload after lease acquisition. Stable field ordering
 * is also used for exact replay and provider/receipt evidence digests. */
export function pipelinePayload<T>(value: T): T {
  const seen = new Set<object>();
  function capture(input: unknown): unknown {
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input === 'string') { pipelineRequire(!/[\u0000-\u001f]/.test(input),'control character in payload'); return input; }
    if (typeof input === 'number') { pipelineRequire(Number.isSafeInteger(input),'non-integer payload number'); return input; }
    pipelineRequire(input && typeof input === 'object' && !seen.has(input),'plain acyclic payload required');
    const object = input as object;
    pipelineRequire(Object.getPrototypeOf(object) === Object.prototype || Array.isArray(object),'plain payload required');
    seen.add(object);
    const output: Record<string,unknown> | unknown[] = Array.isArray(object) ? [] : {};
    for (const key of Object.keys(object).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(object,key)!;
      pipelineRequire('value' in descriptor && descriptor.value !== undefined,'payload accessor/undefined refused');
      Object.defineProperty(output,key,{ value: capture(descriptor.value),enumerable: true,writable: false,configurable: false });
    }
    seen.delete(object); return Object.freeze(output);
  }
  return capture(value) as T;
}
export function pipelineSame(left: unknown, right: unknown): boolean {
  return JSON.stringify(pipelinePayload(left)) === JSON.stringify(pipelinePayload(right));
}
export function pipelineFields(value: unknown, keys: readonly string[]): asserts value is Record<string,unknown> {
  pipelineRequire(value && typeof value === 'object' && !Array.isArray(value)
    && pipelineSame(Object.keys(value).sort(),[...keys].sort()),'exact protected payload fields required');
}
export function pipelineIso(value: unknown): asserts value is string {
  pipelineRequire(typeof value === 'string' && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value,'canonical ISO time required');
}
export function pipelineDigest(value: unknown): asserts value is string {
  pipelineRequire(typeof value === 'string' && /^[0-9a-f]{64}$/.test(value),'SHA256 evidence digest required');
}
export function pipelineChain(value: unknown): asserts value is 'solana' | 'polygon' | 'robinhood-chain' {
  pipelineRequire(['solana','polygon','robinhood-chain'].includes(value as string),'canonical chain required');
}
export function pipelineScope(value: { userId: string | null; chain: string; tokenMint: string; targetAccount: string }) {
  if (value.userId !== null) pipelineUuid(value.userId);
  pipelineChain(value.chain);
  pipelineRequire([value.tokenMint,value.targetAccount].every(v => pipelineText(v,100)
    && v.startsWith(`${value.chain}:`) && v.length > value.chain.length + 1),'exact canonical asset/account scope required');
}
export async function requirePipelineApprovedPayload(client: PoolClient, purpose: PipelineProtectedPurpose,
  selector: string, candidate: unknown) {
  const approval = await readPipelineBackendApproval(client,purpose,selector);
  pipelineRequire(pipelineSame(approval.terms,candidate),'candidate differs from independent persisted protected approval');
  return approval;
}
export function pipelineWriterTransaction(acquire: () => Promise<PipelineClientLease>, purpose: PipelineProtectedPurpose, selector: string) {
  return createCheckedPipelineTransaction({ acquire,purpose,authorityId: selector });
}
export interface PipelineWorkerCapabilityRegistration {
  readonly capabilityId: string; readonly revision: string; readonly executionId: string;
  readonly runtimeRole: 'swat_app'; readonly databaseOid: string; readonly serverAddress: string;
  readonly serverPort: number; readonly backendIdentity: string; readonly validFrom: string; readonly expiresAt: string;
  readonly userId: string; readonly chain: 'solana' | 'polygon' | 'robinhood-chain'; readonly tokenMint: string;
  readonly targetAccount: string; readonly executionMode: 'paper'; readonly obligationKind: 'fanout' | 'lot-exit';
  readonly obligationId: string; readonly policyId: string; readonly policyRevision: string;
}
export function preparePipelineWorkerCapability(candidate: PipelineWorkerCapabilityRegistration) {
  const value = pipelinePayload(candidate);
  pipelineFields(value,['capabilityId','revision','executionId','runtimeRole','databaseOid','serverAddress','serverPort',
    'backendIdentity','validFrom','expiresAt','userId','chain','tokenMint','targetAccount','executionMode',
    'obligationKind','obligationId','policyId','policyRevision']);
  pipelineUuid(value.capabilityId); pipelineUuid(value.executionId); pipelineUuid(value.userId); pipelineScope(value);
  pipelineIso(value.validFrom); pipelineIso(value.expiresAt);
  pipelineRequire(value.runtimeRole === 'swat_app' && value.executionMode === 'paper'
    && ['fanout','lot-exit'].includes(value.obligationKind) && /^[1-9]\d*$/.test(value.databaseOid)
    && pipelineText(value.serverAddress) && Number.isInteger(value.serverPort) && value.serverPort >= 0 && value.serverPort <= 65535
    && [value.revision,value.obligationId,value.policyId,value.policyRevision].every(v => pipelineText(v,128))
    && pipelineText(value.backendIdentity,512) && value.backendIdentity.endsWith('|swat_app')
    && value.validFrom < value.expiresAt,'exact immutable paper capability terms required');
  return value;
}
export async function registerPipelineWorkerCapabilityWithClient(client: PoolClient, candidate: PipelineWorkerCapabilityRegistration) {
  const value = preparePipelineWorkerCapability(candidate);
  const approval = await requirePipelineApprovedPayload(client,'worker-register',value.executionId,value);
  pipelineRequire(approval.runtimeRole === 'swat_capability_writer' && approval.databaseOid === value.databaseOid
    && approval.serverAddress === value.serverAddress && approval.serverPort === value.serverPort
    && pipelineTime(approval.expiresAt) && new Date(value.expiresAt) <= approval.expiresAt,'registry/backend scope mismatch');
  await requirePipelineWorkerRoutine(client,'register');
  const result = await client.query('SELECT public.swat_pipeline_register_worker_capability($1::uuid,$2::jsonb) AS result',
    [value.executionId,JSON.stringify(value)]);
  pipelineRequire(result.rows.length === 1 && pipelineSame(result.rows[0].result,value),'protected canonical registry write/replay refused');
  return value;
}
export function createProtectedPipelineWorkerRegistry(input: { acquire: () => Promise<PipelineClientLease> }) {
  pipelineRequire(typeof input.acquire === 'function','registry physical lease required');
  const acquire = input.acquire;
  return { register(candidate: PipelineWorkerCapabilityRegistration) {
    const value = preparePipelineWorkerCapability(candidate);
    return pipelineWriterTransaction(acquire,'worker-register',value.executionId)(client => registerPipelineWorkerCapabilityWithClient(client,value));
  } };
}
export type { PipelineClientLease, PipelineProtectedRole };
