import { createHash } from 'node:crypto';
import { loadCustodySecretAdmissionWithClient, requireCustodySecretAdmission,
  type CustodySecretAdmission } from '@swat/db/dist/custody-owned-store.js';
import { createCustodyExecutionStore, type CustodySqlClient } from '@swat/db/dist/custody-store.js';
import { assertCustodyBindingMatches, assertCustodyLifecycle, custodyGrantId, custodyIdentifier,
  custodyPolicyDigest, type CustodyGrantSnapshot } from '@swat/db/dist/custody-contract.js';
import type { UserScope } from '@swat/db/dist/tenancy.js';
import type { CustodyCheckedTransaction, CustodyOwnedCompositionPorts } from './custody-owned-composition.js';

export interface CustodyJournalScope {
  readonly runId: string; readonly userId: string; readonly grantId: string;
  readonly chain: CustodyGrantSnapshot['chain']; readonly observerIdentity: string;
  readonly deploymentId: string; readonly chainId: string;
}
export interface CustodyJournal {
  readonly scope: CustodyJournalScope;
  readonly observedAt: string;
  readonly grant: CustodyGrantSnapshot | null;
  readonly admissions: readonly CustodySecretAdmission[];
  readonly history: readonly { readonly event: string; readonly actorType: string; readonly actorId: string | null;
    readonly targetType: string | null; readonly targetId: string | null; readonly metadata: unknown; readonly createdAt: string }[];
}
export interface CustodyJournalObserverPorts {
  readonly scope: CustodyJournalScope;
  readonly transaction: CustodyCheckedTransaction;
  readonly admission: CustodyOwnedCompositionPorts['admissions'];
  readonly check: () => void;
}
function requireValue(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(`Custody journal: ${reason}`);
}
function json(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(json).join(',')}]`;
  requireValue(value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype, 'inert JSON only');
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${json((value as Record<string, unknown>)[key])}`).join(',')}}`;
}
/** Secret-bearing internal journal is compared in memory, NEVER serialized into
 * evidence output. Published hash authenticates ciphertext/admissions, not bytes. */
export function custodyJournalHash(journal: CustodyJournal): string {
  return createHash('sha256').update(json(journal)).digest('hex');
}
export function requireCustodyJournal(actual: CustodyJournal, expected: CustodyJournal): void {
  requireValue(json(actual) === json(expected), 'exact identity/admission/lifecycle/history differs or extra rows');
  const s = actual.scope;
  custodyGrantId(s.runId); custodyGrantId(s.userId); custodyGrantId(s.grantId); custodyIdentifier(s.deploymentId);
  requireValue(s.observerIdentity !== 'swat_app' && s.observerIdentity !== 'swat_custody_writer' &&
    Number.isFinite(Date.parse(actual.observedAt)), 'separate observer and finite snapshot time required');
  const versions = new Set<number>();
  for (const admission of actual.admissions) {
    requireValue(admission.userId === s.userId && admission.record.id === s.grantId && admission.record.chain === s.chain &&
      !versions.has(admission.record.keyVersion!) && admission.acceptedAt.getTime() <= Date.parse(actual.observedAt), 'exact unique admission tenant/version/chronology');
    requireCustodySecretAdmission(admission, s.userId, admission.record);
    assertCustodyBindingMatches(admission.record.secretBinding!, { ...admission.record, userId: s.userId },
      { deploymentId: s.deploymentId, chainId: s.chainId });
    versions.add(admission.record.keyVersion!);
  }
  if (actual.grant) {
    const grant = actual.grant;
    requireValue(grant.id === s.grantId && grant.userId === s.userId && grant.chain === s.chain, 'exact current grant scope');
    assertCustodyLifecycle(grant, new Date(actual.observedAt));
    if (grant.secretBinding) {
      assertCustodyBindingMatches(grant.secretBinding, grant, { deploymentId: s.deploymentId, chainId: s.chainId });
      const admission = actual.admissions.find(row => row.record.keyVersion === grant.keyVersion) ?? null;
      requireCustodySecretAdmission(admission, s.userId, grant);
      if (grant.status === 'active' && grant.revocationTombstone) requireValue(admission.acceptedAt > grant.revocationTombstone, 'fresh post-revocation admission');
    }
  }
  for (const event of actual.history) requireValue(event.targetType === 'execution_grant' && event.targetId === s.grantId &&
    (event.actorId === s.userId || event.actorId === null) && Number.isFinite(Date.parse(event.createdAt)), 'audit scope/chronology differs');
}
/** Refusal/rollback cannot silently alter grant/history/accepted admissions.
 * If an independent admission committed before app rollback, pass its EXACT
 * expected durable row as retainedAdmission; it is not an orphan-cleanup grant. */
export function requireCustodyRollback(before: CustodyJournal, after: CustodyJournal,
  retainedAdmission?: CustodySecretAdmission): void {
  const expected: CustodyJournal = { ...before, observedAt: after.observedAt,
    admissions: retainedAdmission ? [...before.admissions, retainedAdmission] : before.admissions };
  requireCustodyJournal(after, expected);
}
/** Separately owned read-only repeatable-read/snapshot transaction, not a writer
 * callback journal. Observer identity/ACL approval is mandatory and independently
 * verified. No pool/acquisition, DDL, credentials or synthesized success. */
export function createCustodyJournalObserver(ports: CustodyJournalObserverPorts) {
  const scope = { ...ports.scope }, check = ports.check;
  requireValue(typeof ports.transaction === 'function' && typeof ports.admission?.authorize === 'function' && typeof check === 'function', 'mandatory observer ports');
  custodyGrantId(scope.runId); custodyGrantId(scope.userId); custodyGrantId(scope.grantId);
  return async (): Promise<CustodyJournal> => {
    check();
    // The general custody admission vocabulary deliberately has no writer-like
    // observer power. Observer approval authenticates read-only execution-secret
    // observation and cannot mint a secret admission or publish execution.
    const request = { capability: 'execution-secret-read' as const, identity: scope.observerIdentity,
      userId: scope.userId, grantId: scope.grantId, deploymentId: scope.deploymentId, chain: scope.chain,
      chainId: scope.chainId, payloadDigest: custodyPolicyDigest(scope) };
    const approved = structuredClone(await ports.admission.authorize({ ...request })); check();
    requireValue(approved?.approved && json(approved.request) === json(request) &&
      approved.capabilities.length === 1 && approved.capabilities[0] === 'execution-secret-read', 'exact read-only observer approval');
    const outcome = await ports.transaction({ userId: scope.userId } as UserScope, async client => {
      const identity = await client.query<{ authenticated_role: string; runtime_role: string; tenant: string | null; bypass: string | null;
        observed_at: Date; isolation: string; read_only: string; admission_write: boolean; grant_write: boolean }>(
      `SELECT session_user AS authenticated_role,current_user AS runtime_role,
        current_setting('app.current_user_id',true) AS tenant,current_setting('app.bypass_rls',true) AS bypass,
        statement_timestamp() AS observed_at,current_setting('transaction_isolation') AS isolation,
        current_setting('transaction_read_only') AS read_only,
        has_table_privilege(current_user,'public.custody_secret_admissions','INSERT,UPDATE,DELETE') AS admission_write,
        has_table_privilege(current_user,'public.user_execution_grants','INSERT,UPDATE,DELETE') AS grant_write`);
      const row = identity.rows[0];
      requireValue(identity.rows.length === 1 && row?.authenticated_role === scope.observerIdentity && row.runtime_role === scope.observerIdentity &&
        row.tenant === scope.userId && row.bypass === 'off' && row.read_only === 'on' &&
        ['repeatable read','serializable'].includes(row.isolation) && row.admission_write === false && row.grant_write === false &&
        row.observed_at instanceof Date && approved.validUntil > row.observed_at, 'independent snapshot identity/ACL/isolation/expiry');
      const grant = await createCustodyExecutionStore(async (_s, action) => action(client as CustodySqlClient))
        .load({ userId: scope.userId } as UserScope, scope.grantId);
      const versions = await client.query<{ key_version: number }>(`SELECT key_version FROM custody_secret_admissions
        WHERE grant_id=$1::uuid AND user_id=$2::uuid ORDER BY key_version`, [scope.grantId, scope.userId]);
      const admissions: CustodySecretAdmission[] = [];
      for (const version of versions.rows) {
        check();
        const admission = await loadCustodySecretAdmissionWithClient(client as CustodySqlClient,
          { userId: scope.userId } as UserScope, scope.grantId, version.key_version);
        requireValue(admission, 'snapshot version vanished'); admissions.push(admission);
      }
      const events = await client.query<{ event: string; actor_type: string; actor_id: string | null;
        target_type: string | null; target_id: string | null; metadata: unknown; created_at: Date }>(
        `SELECT event,actor_type,actor_id,target_type,target_id,metadata,occurred_at AS created_at FROM audit_log
          WHERE target_type='execution_grant' AND target_id=$1 ORDER BY occurred_at,id`, [scope.grantId]);
      check();
      return { scope, observedAt: row.observed_at.toISOString(), grant, admissions,
        history: events.rows.map(event => ({ event: event.event, actorType: event.actor_type, actorId: event.actor_id,
          targetType: event.target_type, targetId: event.target_id, metadata: event.metadata, createdAt: event.created_at.toISOString() })) };
    });
    check(); requireValue(outcome?.outcome === 'committed', 'observer COMMIT uncertain/failed');
    requireCustodyJournal(outcome.value, outcome.value); return outcome.value;
  };
}
