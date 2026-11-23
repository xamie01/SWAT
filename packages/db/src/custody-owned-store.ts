import type { PoolClient } from 'pg';
export type { PoolClient };
import type { UserScope } from './tenancy.js';
import { recordAuditEventStrictWithClient } from './audit-log-owned.js';
import type { CustodyEnrollmentRecord } from './custody-enrollment.js';
import { createCustodyExecutionStore, type CustodySqlClient } from './custody-store.js';
import { assertCustodyBindingMatches, assertCustodyEnvelope, assertCustodyLifecycle,
  custodyGrantId, custodyIdentifier, custodyPolicyDigest, custodyPolicySnapshot, CustodyContractError,
  type CustodyGrantSnapshot } from './custody-contract.js';

export interface CustodySecretAdmission {
  readonly id: string;
  readonly userId: string;
  readonly record: CustodyEnrollmentRecord;
  readonly wrapperId: string;
  readonly serviceIdentity: string;
  readonly authenticatedReceipt: string;
  readonly acceptedAt: Date;
}
export interface CustodyAdmissionAuthentication {
  readonly wrapperId: string;
  readonly serviceIdentity: string;
  readonly authenticatedReceipt: string;
}
/** Approval/verifier implementations must authenticate the actual complete payload,
 * not trust the wrapper name, a shaped envelope, application labels or DB login. */
export interface CustodyAdmissionVerifier {
  verify(input: { readonly userId: string; readonly record: CustodyEnrollmentRecord;
    readonly authentication: CustodyAdmissionAuthentication; readonly payloadDigest: string }): Promise<{
      readonly accepted: boolean; readonly payloadDigest: string; readonly serviceIdentity: string;
    }>;
}
interface AdmissionRow {
  id: string; grant_id: string; user_id: string; chain: CustodyEnrollmentRecord['chain'];
  grant_kind: CustodyEnrollmentRecord['grantKind']; account_address: string; key_version: number;
  sealed_secret: string; secret_binding: NonNullable<CustodyEnrollmentRecord['secretBinding']>;
  scope_policy: unknown; expires_at: Date | null; wrapper_id: string; service_identity: string;
  authenticated_receipt: string; accepted_at: Date;
}
export const CUSTODY_ADMISSION_COLUMNS = `id, grant_id, user_id, chain, grant_kind, account_address,
  key_version, sealed_secret, secret_binding, scope_policy, expires_at, wrapper_id, service_identity,
  authenticated_receipt, accepted_at`;
function snapshotRecord(input: CustodyEnrollmentRecord): CustodyEnrollmentRecord {
  return { id: input.id, chain: input.chain, grantKind: input.grantKind, accountAddress: input.accountAddress,
    sealedSecret: input.sealedSecret, keyVersion: input.keyVersion, scopePolicy: custodyPolicySnapshot(input.scopePolicy),
    secretBinding: input.secretBinding ? structuredClone(input.secretBinding) : null,
    expiresAt: input.expiresAt ? new Date(input.expiresAt) : null };
}
function validateRecord(userId: string, input: CustodyEnrollmentRecord): void {
  custodyIdentifier(userId); custodyGrantId(input.id);
  if (!input.secretBinding || !input.sealedSecret || input.keyVersion === null) throw new CustodyContractError('custody-invalid');
  assertCustodyBindingMatches(input.secretBinding, { ...input, userId });
  assertCustodyEnvelope(input.sealedSecret, input.keyVersion);
}
export function custodyAdmissionPayloadDigest(userId: string, input: CustodyEnrollmentRecord): string {
  validateRecord(userId, input);
  return custodyPolicyDigest({ userId, record: { ...snapshotRecord(input), expiresAt: input.expiresAt?.toISOString() ?? null } });
}
function fromAdmission(row: AdmissionRow): CustodySecretAdmission {
  return { id: row.id, userId: row.user_id, record: { id: row.grant_id, chain: row.chain,
    grantKind: row.grant_kind, accountAddress: row.account_address, keyVersion: row.key_version,
    sealedSecret: row.sealed_secret, secretBinding: row.secret_binding, scopePolicy: row.scope_policy,
    expiresAt: row.expires_at }, wrapperId: row.wrapper_id, serviceIdentity: row.service_identity,
    authenticatedReceipt: row.authenticated_receipt, acceptedAt: row.accepted_at };
}
export function requireCustodySecretAdmission(admission: CustodySecretAdmission | null, userId: string,
  record: CustodyEnrollmentRecord, authentication?: CustodyAdmissionAuthentication): asserts admission is CustodySecretAdmission {
  validateRecord(userId, record);
  if (!admission || admission.userId !== userId ||
    custodyAdmissionPayloadDigest(admission.userId, admission.record) !== custodyAdmissionPayloadDigest(userId, record) ||
    !(admission.acceptedAt instanceof Date) || !Number.isFinite(admission.acceptedAt.getTime()) ||
    (record.expiresAt !== null && !(record.expiresAt.getTime() > admission.acceptedAt.getTime())) ||
    !admission.authenticatedReceipt || !admission.serviceIdentity ||
    admission.wrapperId !== record.sealedSecret!.split('.')[1] ||
    (authentication && (admission.wrapperId !== authentication.wrapperId ||
      admission.serviceIdentity !== authentication.serviceIdentity || admission.authenticatedReceipt !== authentication.authenticatedReceipt))) {
    throw new CustodyContractError('custody-invalid');
  }
}
/** Reads only the precise tenant/grant/version; never synthesizes approval from a grant. */
export async function loadCustodySecretAdmissionWithClient(client: CustodySqlClient, scope: UserScope,
  grantId: string, keyVersion: number): Promise<CustodySecretAdmission | null> {
  custodyIdentifier(scope.userId); custodyGrantId(grantId);
  if (!Number.isSafeInteger(keyVersion) || keyVersion < 1) throw new CustodyContractError('custody-invalid');
  const rows = await client.query<AdmissionRow>(`SELECT ${CUSTODY_ADMISSION_COLUMNS}
    FROM custody_secret_admissions WHERE grant_id = $1::uuid AND user_id = $2::uuid AND key_version = $3`,
  [grantId, scope.userId, keyVersion]);
  if (rows.rows.length > 1) throw new CustodyContractError('custody-conflict');
  return rows.rows[0] ? fromAdmission(rows.rows[0]) : null;
}
/** Captures request before acquisition. No transaction control, pool, grants, key
 * generation or provisional accepted_at. Caller publishes only after checked COMMIT. */
export function prepareCustodySecretAdmission(input: {
  readonly scope: UserScope; readonly record: CustodyEnrollmentRecord;
  readonly authentication: CustodyAdmissionAuthentication; readonly verifier: CustodyAdmissionVerifier;
  readonly now: () => Date;
}): (client: CustodySqlClient) => Promise<CustodySecretAdmission> {
  const userId = input.scope.userId, record = snapshotRecord(input.record);
  const authentication = { ...input.authentication }, verifier = input.verifier, now = input.now;
  validateRecord(userId, record); custodyIdentifier(authentication.wrapperId);
  assertCustodyEnvelope(record.sealedSecret!, record.keyVersion!, authentication.wrapperId);
  if (typeof authentication.serviceIdentity !== 'string' || authentication.serviceIdentity.length < 1 || authentication.serviceIdentity.length > 256 ||
    typeof authentication.authenticatedReceipt !== 'string' || authentication.authenticatedReceipt.length < 1 || authentication.authenticatedReceipt.length > 4096 ||
    typeof verifier?.verify !== 'function' || typeof now !== 'function') throw new CustodyContractError('custody-unavailable');
  const payloadDigest = custodyAdmissionPayloadDigest(userId, record);
  return async client => {
    const time = now();
    if (!Number.isFinite(time.getTime()) || (record.expiresAt && record.expiresAt.getTime() <= time.getTime())) throw new CustodyContractError('custody-stale');
    const verified = await verifier.verify({ userId, record: snapshotRecord(record), authentication: { ...authentication }, payloadDigest });
    if (!verified?.accepted || verified.payloadDigest !== payloadDigest || verified.serviceIdentity !== authentication.serviceIdentity) {
      throw new CustodyContractError('custody-unavailable');
    }
    const identity = await client.query<{ authenticated_role: string; runtime_role: string; tenant: string | null; bypass: string | null }>(
      `SELECT session_user AS authenticated_role, current_user AS runtime_role,
        current_setting('app.current_user_id',true) AS tenant, current_setting('app.bypass_rls',true) AS bypass`, []);
    const row = identity.rows[0];
    if (identity.rows.length !== 1 || row?.authenticated_role !== 'swat_custody_writer' || row.runtime_role !== 'swat_custody_writer' ||
      row.tenant !== userId || row.bypass !== 'off') throw new CustodyContractError('custody-unavailable');
    const latest = now();
    if (!Number.isFinite(latest.getTime()) || (record.expiresAt && record.expiresAt.getTime() <= latest.getTime())) throw new CustodyContractError('custody-stale');
    const inserted = await client.query<AdmissionRow>(`INSERT INTO custody_secret_admissions
      (grant_id,user_id,chain,grant_kind,account_address,key_version,sealed_secret,secret_binding,scope_policy,expires_at,
        wrapper_id,service_identity,authenticated_receipt)
      VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13)
      ON CONFLICT (grant_id,key_version) DO NOTHING RETURNING ${CUSTODY_ADMISSION_COLUMNS}`,
    [record.id, userId, record.chain, record.grantKind, record.accountAddress, record.keyVersion, record.sealedSecret,
      JSON.stringify(record.secretBinding), JSON.stringify(record.scopePolicy), record.expiresAt,
      authentication.wrapperId, authentication.serviceIdentity, authentication.authenticatedReceipt]);
    if (inserted.rows.length > 1) throw new CustodyContractError('custody-conflict');
    const admission = inserted.rows[0] ? fromAdmission(inserted.rows[0]) :
      await loadCustodySecretAdmissionWithClient(client, { userId } as UserScope, record.id, record.keyVersion!);
    requireCustodySecretAdmission(admission, userId, record, authentication);
    return structuredClone(admission);
  };
}
/** Lock the real grant, then reuse the canonical execution SQL mapper on this
 * SAME client. DB lock protects local lifecycle; it is not remote nonce proof. */
export async function lockCustodyGrantWithClient(client: CustodySqlClient, scope: UserScope,
  grantId: string): Promise<CustodyGrantSnapshot> {
  const userId = scope.userId; custodyIdentifier(userId); custodyGrantId(grantId);
  const lock = await client.query<{ id: string; user_id: string }>(`SELECT id,user_id FROM user_execution_grants
    WHERE id = $1::uuid AND user_id = $2::uuid FOR UPDATE`, [grantId, userId]);
  if (lock.rows.length !== 1 || lock.rows[0]!.id !== grantId || lock.rows[0]!.user_id !== userId) throw new CustodyContractError('custody-stale');
  const grant = await createCustodyExecutionStore(async (_scope, action) => action(client)).load({ userId } as UserScope, grantId);
  if (!grant || grant.id !== grantId || grant.userId !== userId) throw new CustodyContractError('custody-stale');
  return structuredClone(grant);
}
/** Narrow lifecycle CAS. SQL081 owns revision/tombstone/terminal guards. Neither
 * caller nor adapter can clear a tombstone or fabricate an activated version. */
export async function transitionCustodyGrantWithClient(client: CustodySqlClient, scope: UserScope, input: {
  readonly grantId: string; readonly expectedLifecycleRevision: string;
  readonly status: 'retired' | 'revoked' | 'compromised'; readonly now: Date;
}): Promise<CustodyGrantSnapshot> {
  const userId = scope.userId, grantId = input.grantId, revision = input.expectedLifecycleRevision,
    status = input.status, now = new Date(input.now);
  if (!['retired','revoked','compromised'].includes(status)) throw new CustodyContractError('custody-invalid');
  const previous = await lockCustodyGrantWithClient(client, { userId } as UserScope, grantId);
  assertCustodyLifecycle(previous, now);
  if (previous.lifecycleRevision !== revision || previous.status === 'compromised') throw new CustodyContractError('custody-stale');
  const changed = await client.query<{ id: string }>(`UPDATE user_execution_grants SET status = $3
    WHERE id = $1::uuid AND user_id = $2::uuid AND lifecycle_revision = $4::bigint AND status <> 'compromised' RETURNING id`,
  [grantId, userId, status, revision]);
  if (changed.rows.length !== 1 || changed.rows[0]!.id !== grantId) throw new CustodyContractError('custody-stale');
  const current = await lockCustodyGrantWithClient(client, { userId } as UserScope, grantId);
  assertCustodyLifecycle(current, now);
  if (current.status !== status || BigInt(current.lifecycleRevision) !== BigInt(revision) + 1n ||
    (previous.revocationTombstone && (!current.revocationTombstone || current.revocationTombstone < previous.revocationTombstone)) ||
    (status !== 'retired' && (!current.revokedAt || !current.revocationTombstone))) throw new CustodyContractError('custody-conflict');
  await recordAuditEventStrictWithClient({ actorType: 'user', actorId: userId, event: `grant.locally_${status}`,
    targetType: 'execution_grant', targetId: grantId, metadata: { chain: current.chain, grantKind: current.grantKind,
      previousLifecycleRevision: revision, lifecycleRevision: current.lifecycleRevision, localOnly: true } }, client);
  return current;
}
/** Fresh, independently admitted replacement only; stage+activate are atomic on
 * the caller transaction. A same-version ABA, keyless resurrection and a
 * compromised row are refused. No admission is minted by this function. */
export async function replaceCustodyGrantWithClient(client: CustodySqlClient, scope: UserScope, input: {
  readonly expectedLifecycleRevision: string; readonly record: CustodyEnrollmentRecord; readonly now: Date;
}): Promise<CustodyGrantSnapshot> {
  const userId = scope.userId, record = snapshotRecord(input.record), revision = input.expectedLifecycleRevision, now = new Date(input.now);
  validateRecord(userId, record);
  const previous = await lockCustodyGrantWithClient(client, { userId } as UserScope, record.id);
  assertCustodyLifecycle(previous, now);
  if (previous.lifecycleRevision !== revision || previous.status === 'compromised' || previous.chain !== record.chain ||
    previous.accountAddress !== record.accountAddress || previous.keyVersion === null || record.keyVersion! <= previous.keyVersion ||
    !Number.isFinite(now.getTime()) || (record.expiresAt && record.expiresAt.getTime() <= now.getTime())) throw new CustodyContractError('custody-stale');
  const admission = await loadCustodySecretAdmissionWithClient(client, { userId } as UserScope, record.id, record.keyVersion!);
  requireCustodySecretAdmission(admission, userId, record);
  if (previous.revocationTombstone && admission.acceptedAt <= previous.revocationTombstone) throw new CustodyContractError('custody-stale');
  const staged = await client.query<{ id: string }>(`UPDATE user_execution_grants SET grant_kind=$3,sealed_secret=$4,
    key_version=$5,secret_binding=$6::jsonb,scope_policy=$7::jsonb,expires_at=$8,status='retired'
    WHERE id=$1::uuid AND user_id=$2::uuid AND lifecycle_revision=$9::bigint AND status <> 'compromised' RETURNING id`,
  [record.id, userId, record.grantKind, record.sealedSecret, record.keyVersion, JSON.stringify(record.secretBinding),
    JSON.stringify(record.scopePolicy), record.expiresAt, revision]);
  if (staged.rows.length !== 1 || staged.rows[0]!.id !== record.id) throw new CustodyContractError('custody-conflict');
  const activated = await client.query<{ id: string }>(`UPDATE user_execution_grants SET status='active',revoked_at=NULL
    WHERE id=$1::uuid AND user_id=$2::uuid AND lifecycle_revision=$3::bigint AND status='retired' RETURNING id`,
  [record.id, userId, (BigInt(revision) + 1n).toString()]);
  if (activated.rows.length !== 1 || activated.rows[0]!.id !== record.id) throw new CustodyContractError('custody-conflict');
  const current = await lockCustodyGrantWithClient(client, { userId } as UserScope, record.id);
  assertCustodyBindingMatches(current.secretBinding!, current);
  if (current.status !== 'active' || current.revokedAt !== null || current.lifecycleRevision !== (BigInt(revision) + 2n).toString() ||
    current.revocationTombstone?.getTime() !== previous.revocationTombstone?.getTime() ||
    custodyAdmissionPayloadDigest(userId, { ...current }) !== custodyAdmissionPayloadDigest(userId, record)) throw new CustodyContractError('custody-conflict');
  await recordAuditEventStrictWithClient({ actorType: 'user', actorId: userId, event: 'grant.locally_replaced',
    targetType: 'execution_grant', targetId: record.id, metadata: { chain: record.chain, grantKind: record.grantKind,
      previousLifecycleRevision: revision, lifecycleRevision: current.lifecycleRevision, localOnly: true } }, client);
  return current;
}
