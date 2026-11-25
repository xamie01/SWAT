import type { PoolClient } from 'pg';
import type { UserScope } from './tenancy.js';
import type { CustodySecretBinding } from './custody-contract.js';
import type { LpOwnedBinding, LpOwnedPurpose, LpOwnedProtectedRecord, LpOwnedProtectedSource, LpOwnedInitialization } from './lp-paper-owned.js';
import { lpExactHash, lpSnapshot } from './lp-exact.js';
import { recordCopyExecutionEvidenceWithClient, type RecordCopyExecutionEvidenceInput } from './copy-trade-lifecycle-owned.js';
import { exactRaw, financialHash, financialTime, requireFinancial, type FinancialAttempt, type FinancialReceipt,
  type FinancialRecord, type WithdrawalIntent, type WithdrawalSqlClient } from './withdrawal-contract.js';
import { decimalToRaw, type ReducingIntent, type ReducingAccountingPort } from './reducing-contract.js';
import { workerMoney } from './worker-valuation-corrections.js';
import { multiplyDecimalText } from './quote-valuation.js';

/** Source-only module: no pool, ambient transaction, environment, key, login or IO on import.
 * Clients MUST belong to an independently checked primary transaction. A return value
 * from a WithClient writer is provisional until its owner acknowledges real COMMIT. */
export const WAVE4_FINANCIAL_BACKING_STATUS = Object.freeze({ sourceImplemented: false, sourceComplete: false, reviewed: false,
  installed: false, qualified: false, runtimeAccepted: false, liveAccepted: false, liveCapabilityAccepted: false,
  productionReady: false, frozen: true } as const);
export const WAVE4_FINANCIAL_BACKING_GAPS = Object.freeze([
  'Canonical withdrawal funding/transfer/fee account journal writer does not exist in the copy lot-exit ledger; withdrawal accounting remains refused.',
  'Canonical copy evidence requires positive baseQuantity; fee-only spot accounting remains refused, not synthesized as a fill.',
  'No genuine protected foreign-role backend observation strategy exists here; database authority admission and custody reader/observer scope fail closed without pg_read_all_stats or client labels.',
  'Scoped invoker custody audit underlying ACL/RLS source strategy is missing; audit_log remains unscoped and no broad SELECT is granted.',
  'SQL081 invoker SELECT * admission guard and canonical app loadCustodySecretAdmission/lifecycle still require forbidden ciphertext read; separate metadata-only public projection repair closes only that projection dependency.',
  'Custody journal must use the scoped audit view adapter instead of raw audit_log; its prior unscoped SELECT is not granted.',
  'Remote wrap attestation verification, decrypt, deployed policy inspection and atomic nonce/effect execution remain external.',
  'Frozen SQL089 nested LP NULL/type/economics, post-wait chronology and complete canonical lock/privilege closure are unfinished; bounded adapter checks do not repair hostile direct SQL insertion.',
  'Custody lookup adapter now takes wave4_direct089 financial tenant lock first; frozen direct SQL custody lookup still lacks that serialization.',
  'Shared selection, role lifecycle, installed catalog/dependency inventories and composition wiring remain coordinator-owned.'
] as const);
export type Wave4BackingClient = WithdrawalSqlClient;
export type Wave4CustodyCapability = 'wrap-only' | 'secret-admission' | 'grant-enrollment' | 'execution-secret-read'
  | 'execution-unwrap' | 'grant-lifecycle' | 'deployed-inspection' | 'scoped-execution';
export interface Wave4CustodyRequest {
  readonly capability: Wave4CustodyCapability; readonly identity: string; readonly userId: string; readonly grantId: string;
  readonly deploymentId: string; readonly chain: CustodySecretBinding['chain']; readonly chainId: string; readonly payloadDigest: string;
}
export interface Wave4CustodyAdmissionPort {
  authorize(request: Wave4CustodyRequest): Promise<{ readonly request: Wave4CustodyRequest; readonly approved: true;
    readonly validUntil: Date; readonly capabilities: readonly Wave4CustodyCapability[] } | null>;
}
function canonical(value: unknown, ancestors = new Set<object>()): string {
  if (value instanceof Date) {
    requireFinancial(Object.getPrototypeOf(value) === Date.prototype && Reflect.ownKeys(value).length === 0,
      '089-inert-plain-date-required');
    requireFinancial(Number.isFinite(Date.prototype.getTime.call(value)), '089-inert-valid-date-required');
    return JSON.stringify(Date.prototype.toISOString.call(value));
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') { requireFinancial(Number.isFinite(value), '089-inert-finite-json-required'); return JSON.stringify(value); }
  requireFinancial(value && typeof value === 'object' && (Array.isArray(value)
    || Object.getPrototypeOf(value) === Object.prototype), '089-inert-json-required');
  requireFinancial(!ancestors.has(value), '089-inert-acyclic-json-required');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  requireFinancial(Object.getOwnPropertySymbols(value).length === 0
    && Object.values(descriptors).every(d => 'value' in d), '089-inert-data-properties-required');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      requireFinancial(Object.getPrototypeOf(value) === Array.prototype && Object.keys(descriptors).length === value.length + 1
        && Array.from({ length: value.length }, (_, i) => descriptors[String(i)])
          .every(d => d && d.enumerable), '089-inert-dense-array-required');
      return `[${Array.from({ length: value.length }, (_, i) => canonical(descriptors[String(i)]!.value, ancestors)).join(',')}]`;
    }
    requireFinancial(Object.values(descriptors).every(d => d.enumerable), '089-inert-enumerable-json-required');
    return `{${Object.keys(descriptors).sort().map(k => `${JSON.stringify(k)}:${canonical(descriptors[k]!.value, ancestors)}`).join(',')}}`;
  } finally { ancestors.delete(value); }
}
function captured<T>(value: T): T { return JSON.parse(canonical(value)) as T; }
function exact<T>(actual: T, expected: T, code: string): void { requireFinancial(canonical(actual) === canonical(expected), code); }
function mandatory(client: Wave4BackingClient): void { requireFinancial(typeof client?.query === 'function', '089-primary-client-required'); }
const directRoles = ['swat_app','swat_lp_admitter','swat_custody_writer','swat_financial_receipt_writer',
  'swat_wave4_authority_writer','swat_wave4_financial_writer','swat_lp_initializer','swat_custody_reader','swat_custody_observer'] as const;
export async function assertWave4BackingClientWithClient(client: Wave4BackingClient, userId: string, role: string): Promise<void> {
  mandatory(client);
  requireFinancial(directRoles.some(r => r === role), '089-fixed-direct-role-required');
  const { rows } = await client.query<{ allowed: boolean }>('SELECT public.wave4_direct089($1,$2::uuid) AS allowed', [role,userId]);
  requireFinancial(rows.length === 1 && rows[0]?.allowed === true, '089-approved-direct-client-required');
}
/** Captures one SAME client; lifetime/COMMIT ownership remains with its mandatory caller.
 * Does not grant capability from the supplied identity string. Registry lookup must find
 * independently persisted complete request and current authority, or returns null. */
export function createWave4CustodyCapabilityAdmissionWithClient(client: Wave4BackingClient): Wave4CustodyAdmissionPort {
  mandatory(client);
  return Object.freeze({ async authorize(request: Wave4CustodyRequest) {
    const input = captured(request);
    // SQL lookup itself lacks this lock; adapter alignment does not repair direct SQL callers.
    const { rows: identities } = await client.query<{ role: string }>('SELECT current_user::text AS role');
    requireFinancial(identities.length === 1 && ['swat_app','swat_custody_writer','swat_custody_reader','swat_custody_observer']
      .includes(identities[0]!.role), '089-custody-fixed-reader-required');
    await assertWave4BackingClientWithClient(client,input.userId,identities[0]!.role);
    const { rows } = await client.query<{ admission: null | { request: Wave4CustodyRequest; approved: boolean;
      validUntil: string; capabilities: Wave4CustodyCapability[] } }>(
      'SELECT public.wave4_custody_lookup089($1::uuid,$2::jsonb) AS admission', [input.userId,canonical(input)]);
    requireFinancial(rows.length === 1, '089-custody-lookup-cardinality');
    const row = rows[0]!.admission; if (row === null) return null;
    const persisted = captured(row);
    exact(persisted.request,input,'089-custody-exact-request-mismatch');
    requireFinancial(persisted.approved === true && Array.isArray(persisted.capabilities) && persisted.capabilities.includes(input.capability),
      '089-custody-persisted-approval-mismatch');
    financialTime(persisted.validUntil);
    return { request: captured(persisted.request), approved: true as const, validUntil: new Date(persisted.validUntil), capabilities: [...persisted.capabilities] };
  } });
}
/** No optional client argument/fallback: exactly implements LpOwnedProtectedSource.read. */
export function createWave4LpProtectedSource(): LpOwnedProtectedSource {
  return Object.freeze({ async read<T>(client: PoolClient, binding: LpOwnedBinding, purpose: LpOwnedPurpose, selector: string) {
    mandatory(client); const b = captured(binding);
    const { rows } = await client.query<{ record: LpOwnedProtectedRecord<T> | null }>(
      'SELECT public.wave4_lp_lookup089($1::uuid,$2,$3,$4,$5,$6) AS record', [b.userId,b.accountId,b.chain,b.networkId,purpose,selector]);
    requireFinancial(rows.length === 1,'089-lp-lookup-cardinality');
    const row = rows[0]!.record; if (row === null) return null;
    const record = captured(row);
    exact(record.binding,b,'089-lp-exact-binding-mismatch');
    requireFinancial(record.purpose===purpose && record.selector===selector && record.revokedAt===null
      && record.payloadHash===lpExactHash(record.payload),'089-lp-complete-persisted-payload-mismatch');
    financialTime(record.admittedAt); financialTime(record.expiresAt);
    requireFinancial(record.expiresAt>record.admittedAt,'089-lp-persisted-chronology-mismatch');
    return lpSnapshot(record);
  } });
}
export interface Wave4AuthorityRecord {
  readonly userId: string; readonly identityId: string; readonly revision: string; readonly domain: 'custody' | 'lp' | 'spot';
  readonly serviceIdentity: string; readonly providerId: string; readonly identityKind: 'database' | 'external';
  readonly databaseRole: string | null; readonly databaseOid: string | null; readonly backendPid: number | null;
  /** Exact PostgreSQL microsecond backend_start (not a JS millisecond truncation). */
  readonly backendStart: string | null;
  readonly accountId: string; readonly chain: string; readonly networkId: string; readonly deploymentId: string;
  readonly grantId: string | null; readonly capabilities: readonly string[]; readonly authenticatedAt: string; readonly expiresAt: string;
}
export interface Wave4AuthorityAuthentication {
  readonly issuer: string; readonly receiptId: string; readonly payloadHash: string; readonly verifiedAt: string;
}
/** An independently authenticated approving service writes already-verified evidence.
 * This is not a verifier implementation and cannot be passed to app input routes. */
export async function admitWave4AuthorityWithClient(client: Wave4BackingClient, authority: Wave4AuthorityRecord,
  authentication: Wave4AuthorityAuthentication): Promise<void> {
  const a = captured(authority), proof = captured(authentication); const bytes = canonical(a);
  requireFinancial(a.identityKind==='external' && a.databaseRole===null && a.databaseOid===null
    && a.backendPid===null && a.backendStart===null,'089-genuine-protected-cross-role-backend-strategy-unavailable');
  await assertWave4BackingClientWithClient(client,a.userId,'swat_wave4_authority_writer');
  requireFinancial(proof.payloadHash===financialHash(a) && proof.verifiedAt===a.authenticatedAt,'089-authority-authentication-mismatch');
  await client.query(`INSERT INTO public.wave4_authorities089(user_id,identity_id,revision,domain,service_identity,provider_id,identity_kind,
    database_role,database_oid,backend_pid,backend_start,account_id,chain,network_id,deployment_id,grant_id,capabilities,
    authority,authority_canonical,authority_hash,authentication,authenticated_at,expires_at)
    VALUES($1::uuid,$2::uuid,$3::bigint,$4,$5,$6,$7,$8::name,$9::oid,$10,$11::timestamptz,$12,$13,$14,$15,$16::uuid,$17::text[],
      $18::jsonb,$19,$20,$21::jsonb,$22::timestamptz,$23::timestamptz)`,
    [a.userId,a.identityId,a.revision,a.domain,a.serviceIdentity,a.providerId,a.identityKind,a.databaseRole,a.databaseOid,a.backendPid,a.backendStart,
      a.accountId,a.chain,a.networkId,a.deploymentId,a.grantId,[...a.capabilities],bytes,bytes,financialHash(a),canonical(proof),a.authenticatedAt,a.expiresAt]);
}
export async function admitWave4CustodyRequestWithClient(client: Wave4BackingClient, input: {
  readonly id: string; readonly identityId: string; readonly authorityRevision: string; readonly request: Wave4CustodyRequest; readonly expiresAt: string;
}): Promise<void> {
  const q = captured(input), r=q.request;
  await assertWave4BackingClientWithClient(client,r.userId,'swat_wave4_authority_writer');
  await client.query(`INSERT INTO public.wave4_custody_requests089(id,user_id,identity_id,authority_revision,request,request_canonical,request_hash,grant_id,capability,payload_digest,expires_at)
    VALUES($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::jsonb,$6,$7,$8::uuid,$9,$10,$11::timestamptz)`,
    [q.id,r.userId,q.identityId,q.authorityRevision,canonical(r),canonical(r),financialHash(r),r.grantId,r.capability,r.payloadDigest,q.expiresAt]);
}
export async function revokeWave4AuthorityWithClient(client: Wave4BackingClient, input: {
  readonly userId: string; readonly identityId: string; readonly revision: string; readonly reason: string;
}): Promise<void> {
  const q=captured(input); await assertWave4BackingClientWithClient(client,q.userId,'swat_wave4_authority_writer');
  await client.query(`INSERT INTO public.wave4_authority_revocations089(user_id,identity_id,revision,reason) VALUES($1::uuid,$2::uuid,$3::bigint,$4)`,
    [q.userId,q.identityId,q.revision,q.reason]);
}
export async function revokeWave4RecordWithClient(client: Wave4BackingClient, input: {
  readonly domain: 'custody' | 'lp'; readonly userId: string; readonly id: string; readonly reason: string;
}): Promise<void> {
  const q=captured(input); await assertWave4BackingClientWithClient(client,q.userId,'swat_wave4_authority_writer');
  // Closed literal SQL inventory, never a generic table/executor parameter.
  const sql=q.domain==='custody'
    ? 'INSERT INTO public.wave4_custody_revocations089(user_id,request_id,reason) VALUES($1::uuid,$2::uuid,$3)'
    : 'INSERT INTO public.wave4_lp_revocations089(user_id,record_id,reason) VALUES($1::uuid,$2::uuid,$3)';
  requireFinancial(q.domain==='custody'||q.domain==='lp','089-revocation-domain-refused');
  await client.query(sql,[q.userId,q.id,q.reason]);
}
export interface Wave4LpAdmission<T> {
  readonly id: string; readonly binding: LpOwnedBinding; readonly identityId: string; readonly authorityRevision: string;
  readonly revision: string; readonly purpose: LpOwnedPurpose; readonly selector: string;
  readonly actions: readonly ('acquire'|'copy'|'rebalance'|'close'|'recover')[]; readonly payload: T;
  readonly observedAt: string; readonly expiresAt: string;
}
export async function admitWave4LpRecordWithClient<T>(client: Wave4BackingClient, input: Wave4LpAdmission<T>): Promise<void> {
  const q=captured(input), b=q.binding;
  requireFinancial(['initialization','secret','quote','receipt','master','risk','quote-context','settlement-context'].includes(q.purpose),
    '089-fixed-lp-purpose-required');
  const initialization = q.purpose==='initialization' ? q.payload as unknown as LpOwnedInitialization : null;
  requireFinancial(q.purpose!=='initialization' || initialization && initialization.subscription && typeof initialization.subscription.id === 'string',
    '089-complete-initialization-subscription-required');
  const subscription=initialization ? initialization.subscription.id : null;
  await assertWave4BackingClientWithClient(client,b.userId,q.purpose==='initialization'?'swat_wave4_authority_writer':'swat_wave4_financial_writer');
  await client.query(`INSERT INTO public.wave4_lp_records089(id,user_id,identity_id,authority_revision,revision,purpose,selector,account_id,chain,network_id,
    actions,payload,payload_canonical,payload_hash,observed_at,expires_at,subscription_id)
    VALUES($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::bigint,$6,$7,$8,$9,$10,$11::text[],$12::jsonb,$13,$14,$15::timestamptz,$16::timestamptz,$17::uuid)`,
    [q.id,b.userId,q.identityId,q.authorityRevision,q.revision,q.purpose,q.selector,b.accountId,b.chain,b.networkId,[...q.actions],canonical(q.payload),
      canonical(q.payload),lpExactHash(q.payload),q.observedAt,q.expiresAt,subscription]);
}
/** Budget and cap SQL text use exactly six decimal places; canonical store derives
 * subscription revision from those strings. This is pure inert authoring utility. */
export function wave4LpInitialSubscriptionRevision(input: { status: 'active'; budgetMicroUsd: string; capMicroUsd: string; createdAt: string }): string {
  const six=(raw:string)=> { exactRaw(raw,true); const s=raw.padStart(7,'0'); return `${s.slice(0,-6)}.${s.slice(-6)}`; };
  return lpExactHash({status:input.status,budget:six(input.budgetMicroUsd),cap:six(input.capMicroUsd),updatedAt:input.createdAt});
}
/** Requires an independently committed approver initialization record, then writes
 * canonical subscription/config + exact FK closure on the initializer's SAME client. */
export async function initializeWave4LpWithClient(client: Wave4BackingClient, userId: string, recordId: string): Promise<LpOwnedInitialization> {
  await assertWave4BackingClientWithClient(client,userId,'swat_lp_initializer');
  const {rows}=await client.query<{initialization:LpOwnedInitialization}>('SELECT public.wave4_lp_initialize089($1::uuid,$2::uuid) AS initialization',[userId,recordId]);
  requireFinancial(rows.length===1&&rows[0]?.initialization,'089-exact-initialization-unavailable'); return lpSnapshot(rows[0].initialization);
}
/** No callback/label can certify the absent invoker audit ACL/RLS source strategy. */
export async function readWave4CustodyAuditWithClient(_client: Wave4BackingClient, _userId: string, _grantId: string, maximumRows=100): Promise<never> {
  requireFinancial(Number.isInteger(maximumRows)&&maximumRows>0&&maximumRows<=1000,'089-bounded-audit-required');
  throw new Error('089-genuine-scoped-invoker-audit-acl-rls-strategy-unavailable');
}
export interface Wave4SpotEvidence extends Omit<RecordCopyExecutionEvidenceInput,'occurredAt'|'observedAt'|'baseQuantity'|'priceUsd'|'feeUsd'|'quoteLeg'> {
  readonly baseQuantity:string; readonly priceUsd:string; readonly feeUsd:string;
  readonly quoteLeg: { readonly amount: string; readonly currency: NonNullable<RecordCopyExecutionEvidenceInput['quoteLeg']>['currency']; readonly nativeUsdPrice?: string };
  readonly occurredAt:string; readonly observedAt:string;
}
export interface Wave4SpotEconomics {
  readonly feeAssetId:string; readonly feeAssetScale:number; readonly feeFundingAccountId:string; readonly feeRaw:string;
  readonly feeUnitUsd:string; readonly feeUsd:string; readonly quoteAssetId:string; readonly quoteAssetScale:number;
  readonly quoteAccountId:string; readonly quoteRaw:string; readonly quoteCurrency:string;
}
export interface Wave4SpotAdmission {
  readonly identityId:string; readonly authorityRevision:string; readonly lotId:string; readonly executionId:string;
  readonly evidence:Wave4SpotEvidence; readonly economics:Wave4SpotEconomics;
}
function spotDecimal(value: unknown, positive = false): asserts value is string {
  requireFinancial(typeof value==='string' && value.length<=128
    && /^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value) && (!positive || /[1-9]/.test(value)), '089-exact-spot-decimal-required');
}
/** Preserve admitted text; validation never rounds or substitutes zero for unknown.
 * Canonical base/position NUMERIC is unconstrained, unlike the money domain. */
function spotEvidence(e: Wave4SpotEvidence, assetScale: number, deltaRaw: string): void {
  spotDecimal(e.baseQuantity,true);
  requireFinancial(decimalToRaw(e.baseQuantity,assetScale)===exactRaw(deltaRaw,true), '089-exact-spot-base-delta-mismatch');
  spotDecimal(e.priceUsd,true); workerMoney(e.priceUsd);
  spotDecimal(e.feeUsd); workerMoney(e.feeUsd);
  requireFinancial(e.quoteLeg && ['USD','SOL','ETH','BNB'].includes(e.quoteLeg.currency), '089-exact-spot-quote-required');
  spotDecimal(e.quoteLeg.amount,true); workerMoney(e.quoteLeg.amount);
  if (e.quoteLeg.currency!=='USD' || e.quoteLeg.nativeUsdPrice!==undefined) {
    spotDecimal(e.quoteLeg.nativeUsdPrice,true); workerMoney(e.quoteLeg.nativeUsdPrice);
  }
  if (e.quoteLeg.currency!=='USD') workerMoney(multiplyDecimalText(e.quoteLeg.amount,e.quoteLeg.nativeUsdPrice!));
}
/** PostgreSQL NUMERIC*power may print an integral value with a zero fraction.
 * Drop ONLY that fraction, then apply the unchanged exactRaw digit/length gate. */
function scaledRaw(value: unknown): string {
  requireFinancial(typeof value==='string' && /^(0|[1-9][0-9]*)(\.0+)?$/.test(value), '089-exact-integral-scaled-raw-required');
  return exactRaw(value.split('.')[0]);
}
export async function admitWave4SpotAccountingWithClient(client: Wave4BackingClient, record: FinancialRecord<ReducingIntent>,
  attempt: FinancialAttempt, receipt: FinancialReceipt, deltaRaw:string, deltaFeeRaw:string, input:Wave4SpotAdmission):Promise<string> {
  const rec=captured(record), a=captured(attempt), r=captured(receipt), q=captured(input), i=rec.intent;
  requireFinancial(i.venue==='spot'&&i.positionSide==='LONG'&&i.side==='SELL','089-spot-long-lot-exit-required');
  exactRaw(deltaRaw,true); exactRaw(deltaFeeRaw);
  requireFinancial(rec.userId===i.userId && rec.intentHash===financialHash(i) && a.userId===rec.userId && a.intentId===rec.id
    && a.intentHash===rec.intentHash && !a.terminal && r.intentId===rec.id && r.intentHash===rec.intentHash
    && r.attemptId===a.id && r.clientOrderId===a.clientOrderId && r.outcome==='fill', '089-complete-spot-receipt-attempt-mismatch');
  requireFinancial(BigInt(exactRaw(r.cumulativeRaw))-BigInt(exactRaw(a.completedRaw))===BigInt(deltaRaw)
    && BigInt(exactRaw(r.feeRaw))-BigInt(exactRaw(a.completedFeeRaw))===BigInt(deltaFeeRaw), '089-spot-cumulative-delta-mismatch');
  requireFinancial(q.executionId===q.evidence.executionId,'089-explicit-execution-binding-required');
  const e=q.evidence, economics=q.economics;
  spotEvidence(e,i.assetScale,deltaRaw);
  financialTime(e.occurredAt); financialTime(e.observedAt); financialTime(r.observedAt);
  requireFinancial(e.observedAt===r.observedAt && e.occurredAt<=e.observedAt && e.confirmationState==='finalized'
    && e.completesExecution===r.terminal && e.evidenceType===(i.mode==='paper'?'paper_simulation':'chain_receipt')
    && decimalToRaw(e.baseQuantity,i.assetScale)===deltaRaw,'089-exact-spot-evidence-scope-mismatch');
  requireFinancial(economics.feeAssetId===i.feeAssetId && economics.feeAssetScale===i.feeAssetScale
    && economics.feeFundingAccountId===i.feeFundingAccountId && exactRaw(economics.feeRaw)===deltaFeeRaw
    && r.feeAssetId===i.feeAssetId && r.feeAssetScale===i.feeAssetScale && r.feeFundingAccountId===i.feeFundingAccountId
    && economics.quoteAccountId===i.accountId && economics.quoteCurrency===e.quoteLeg.currency
    && decimalToRaw(e.quoteLeg.amount,economics.quoteAssetScale)===exactRaw(economics.quoteRaw,true),
    '089-exact-spot-economics-scope-mismatch');
  spotDecimal(economics.feeUnitUsd); workerMoney(economics.feeUnitUsd);
  spotDecimal(economics.feeUsd); workerMoney(economics.feeUsd);
  requireFinancial(workerMoney(economics.feeUsd)===workerMoney(e.feeUsd), '089-exact-spot-fee-value-mismatch');
  // SQL owns exact valuation equations and persisted lot/receipt closure; these
  // input checks do not claim to fix frozen SQL NULL/ACL/lock/source-pin gaps.
  await assertWave4BackingClientWithClient(client,rec.userId,'swat_financial_receipt_writer');
  const reference=`spot:${q.executionId}:${r.receiptId}`;
  const binding={id:a.id,intentId:a.intentId,userId:a.userId,clientOrderId:a.clientOrderId,intentHash:a.intentHash};
  await client.query(`INSERT INTO public.wave4_spot_admissions089(user_id,receipt_id,intent_id,attempt_id,identity_id,authority_revision,execution_id,lot_id,position_id,
    chain,network_id,mode,account_id,asset_id,asset_scale,fee_asset_id,fee_asset_scale,fee_account_id,delta_raw,delta_fee_raw,
    intent,intent_hash,attempt_binding,receipt,receipt_hash,evidence_input,evidence_canonical,evidence_hash,economics,economics_canonical,economics_hash,accounting_reference)
    VALUES($1::uuid,$2,$3::uuid,$4::uuid,$5::uuid,$6::bigint,$7::uuid,$8::uuid,$9::uuid,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::numeric,$20::numeric,
      $21::jsonb,$22,$23::jsonb,$24::jsonb,$25,$26::jsonb,$27,$28,$29::jsonb,$30,$31,$32)`,
    [rec.userId,r.receiptId,rec.id,a.id,q.identityId,q.authorityRevision,q.executionId,q.lotId,i.positionId,i.chain,i.network,i.mode,i.accountId,i.assetId,i.assetScale,
      i.feeAssetId,i.feeAssetScale,i.feeFundingAccountId,deltaRaw,deltaFeeRaw,canonical(i),rec.intentHash,canonical(binding),canonical(r),financialHash(r),canonical(q.evidence),
      canonical(q.evidence),financialHash(q.evidence),canonical(q.economics),canonical(q.economics),financialHash(q.economics),reference]);
  await client.query(`INSERT INTO public.withdrawal_reducing_accounting_admissions(receipt_id,user_id,intent_id,delta_raw,delta_fee_raw,accounting_reference)
    VALUES($1,$2::uuid,$3::uuid,$4::numeric,$5::numeric,$6)`,[r.receiptId,rec.userId,rec.id,deltaRaw,deltaFeeRaw,reference]);
  return reference;
}
/** Concrete ReducingAccountingPort. Explicit immutable binding is independently
 * admitted before this call; no positionId/clientOrderId->executionId inference.
 * Calls canonical evidence settlement ON THE SUPPLIED CLIENT, not a ledger clone.
 * Any rejection after canonical writes MUST roll back the caller's transaction;
 * this adapter neither commits nor rolls back and never returns a mismatch. */
export function createWave4SpotSettler(): ReducingAccountingPort {
  return async (client,suppliedRecord,suppliedReceipt,deltaRaw,deltaFeeRaw) => {
    const record=captured(suppliedRecord),receipt=captured(suppliedReceipt);
    const i=record.intent; requireFinancial(i.venue==='spot'&&i.positionSide==='LONG'&&i.side==='SELL','089-canonical-spot-required');
    exactRaw(deltaRaw,true); exactRaw(deltaFeeRaw);
    await assertWave4BackingClientWithClient(client,record.userId,'swat_app');
    const {rows}=await client.query<{execution_id:string;lot_id:string;position_id:string;accounting_reference:string;evidence_input:Wave4SpotEvidence;
      evidence_hash:string;economics_hash:string;before_raw:string}>(`SELECT p.execution_id,p.lot_id,p.position_id,p.accounting_reference,p.evidence_input,p.evidence_hash,p.economics_hash,
        (position.confirmed_quantity*power(10::numeric,p.asset_scale))::text AS before_raw
      FROM public.wave4_spot_admissions089 p JOIN public.copy_positions position ON position.id=p.position_id AND position.user_id=p.user_id
      JOIN public.withdrawal_reducing_accounting_admissions admission ON admission.receipt_id=p.receipt_id AND admission.user_id=p.user_id
      JOIN public.withdrawal_reducing_attempts attempt ON attempt.id=p.attempt_id AND attempt.intent_id=p.intent_id AND attempt.user_id=p.user_id
      WHERE p.user_id=$1::uuid AND p.intent_id=$2::uuid AND p.receipt_id=$3 AND p.receipt_hash=$4 AND p.intent_hash=$5
        AND p.delta_raw=$6::numeric AND p.delta_fee_raw=$7::numeric AND p.position_id=$8::uuid
        AND admission.accounting_reference=p.accounting_reference AND admission.delta_raw=p.delta_raw AND admission.delta_fee_raw=p.delta_fee_raw
        AND NOT attempt.terminal AND (p.receipt->>'cumulativeRaw')::numeric-attempt.completed_raw=p.delta_raw
        AND (p.receipt->>'feeRaw')::numeric-attempt.completed_fee_raw=p.delta_fee_raw FOR UPDATE OF position`,
      [record.userId,record.id,receipt.receiptId,financialHash(receipt),record.intentHash,deltaRaw,deltaFeeRaw,i.positionId]);
    requireFinancial(rows.length===1,'089-persisted-canonical-spot-binding-unavailable'); const p=captured(rows[0]!);
    requireFinancial(financialHash(p.evidence_input)===p.evidence_hash&&p.evidence_input.executionId===p.execution_id,'089-complete-spot-evidence-mismatch');
    const beforeRaw=scaledRaw(p.before_raw), e=p.evidence_input;
    requireFinancial(BigInt(beforeRaw)>=BigInt(deltaRaw), '089-canonical-before-insufficient-raw');
    spotEvidence(e,i.assetScale,deltaRaw);
    // This cast bridges only pg query typing; it does NOT acquire a client or pool.
    const result=await recordCopyExecutionEvidenceWithClient(client as PoolClient,{...e,occurredAt:new Date(e.occurredAt),observedAt:new Date(e.observedAt)});
    requireFinancial(result.execution.id===p.execution_id&&result.position.id===p.position_id,'089-canonical-returned-execution-position-mismatch');
    const after=await client.query<{after_raw:string;evidence_id:string}>(`SELECT (position.confirmed_quantity*power(10::numeric,$4::integer))::text AS after_raw,e.id AS evidence_id
      FROM public.copy_positions position JOIN public.copy_execution_evidence e ON e.execution_id=$3::uuid
      WHERE position.id=$1::uuid AND position.user_id=$2::uuid AND e.evidence_type=$5 AND e.evidence_id=$6`,
      [p.position_id,record.userId,p.execution_id,i.assetScale,e.evidenceType,e.evidenceId]);
    requireFinancial(after.rows.length===1,'089-canonical-evidence-result-unavailable'); const a=captured(after.rows[0]!);
    const afterRaw=scaledRaw(a.after_raw);
    requireFinancial(BigInt(beforeRaw)-BigInt(afterRaw)===BigInt(deltaRaw),'089-canonical-aggregate-conservation-mismatch');
    await client.query(`INSERT INTO public.wave4_spot_settlements089(user_id,receipt_id,evidence_id,accounting_reference,before_raw,after_raw)
      VALUES($1::uuid,$2,$3::uuid,$4,$5::numeric,$6::numeric)`,[record.userId,receipt.receiptId,a.evidence_id,p.accounting_reference,beforeRaw,afterRaw]);
    return {accountingReference:p.accounting_reference,positionId:p.position_id,positionSide:'LONG',beforeRaw,afterRaw,
      economicsReference:`spot-economics:${p.economics_hash}`};
  };
}
/** Cannot turn transfer receipt labels into a custody cash journal or lot exit. */
export async function refuseWave4WithdrawalAccountingWithClient(_client: Wave4BackingClient, _record: FinancialRecord<WithdrawalIntent>): Promise<never> {
  throw new Error('089-canonical-withdrawal-account-journal-unavailable');
}
export type { PoolClient, UserScope };
