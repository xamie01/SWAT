import { createCustodyEnrollment, type CustodyEnrollmentInput } from '@swat/db/dist/custody-enrollment.js';
import { createCustodyExecutionAccess } from '@swat/db/dist/custody-execution.js';
import { buildCustodySecretBinding, custodyBindingAad, CustodyContractError } from '@swat/db/dist/custody-contract.js';
import { createCustodyEnrollmentStore, createCustodyExecutionStore, type CustodyTenantTransaction } from '@swat/db/dist/custody-store.js';
import type { UserScope } from '@swat/db/dist/tenancy.js';
import { createOwnedCustodyComposition, type CustodyOwnedCompositionPorts, type OwnedCustodyComposition } from './custody-owned-composition.js';
import { custodyJournalHash, requireCustodyJournal, requireCustodyRollback, type CustodyJournal } from './custody-journal.js';
import type { CustodyEnrollmentRecord } from '@swat/db/dist/custody-enrollment.js';
import type { CustodyAdmissionAuthentication, CustodySecretAdmission } from '@swat/db/dist/custody-owned-store.js';
import type { AuthoritySigningRequest, ExecutionAuthorityRequest } from '../../../apps/trade-executor/src/execution-authority.js';

export const custodySourceBoundary = Object.freeze({ sourceImplemented: true, runtimeAccepted: false,
  liveCapabilityAccepted: false, productionReady: false } as const);
export const custodySourceBlockers = Object.freeze([
  'distinct deployed enrollment wrap and execution unwrap service identities unqualified',
  'restricted admission and owned lifecycle adapters require actual SQL RLS lifecycle commit proof',
  'verified deployed delegation and atomic execution-boundary revalidation unqualified; no signing permitted'
]);
export type CustodyEnrollmentPorts = Parameters<typeof createCustodyEnrollment>[0];
export type CustodyExecutionPorts = Parameters<typeof createCustodyExecutionAccess>[0];
function check(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(`Custody qualification: ${reason}`);
}
/** No fallback transaction, authority provisioning, key generation, signature or submission. */
export function custodySqlStores(transaction: CustodyTenantTransaction) {
  check(typeof transaction === 'function', 'owned transaction required');
  return { enrollment: createCustodyEnrollmentStore(transaction), execution: createCustodyExecutionStore(transaction) };
}
/** Fixture bytes are supplied explicitly; source is not permission to consume real execution material. */
export async function qualifyCustodyBinding(enrollmentPorts: CustodyEnrollmentPorts, executionPorts: CustodyExecutionPorts,
  scope: UserScope, syntheticInput: CustodyEnrollmentInput) {
  check(syntheticInput.secret instanceof Uint8Array && syntheticInput.secret.length > 0, 'explicit synthetic bytes required');
  const expected = Uint8Array.from(syntheticInput.secret);
  try {
    const grant = await createCustodyEnrollment(enrollmentPorts).enroll(scope, syntheticInput);
    check(!('sealedSecret' in grant) && !('plaintext' in grant) && grant.hasSealedSecret, 'public grant must not expose execution material');
    const snapshot = await executionPorts.store.load(scope, grant.id);
    check(snapshot && snapshot.userId === scope.userId && snapshot.id === grant.id && snapshot.status === 'active'
      && snapshot.chain === syntheticInput.chain && snapshot.grantKind === syntheticInput.grantKind
      && snapshot.keyVersion !== null && snapshot.secretBinding && snapshot.sealedSecret, 'current authenticated grant required');
    const binding = buildCustodySecretBinding({ deploymentId: executionPorts.deploymentId,
      chainId: executionPorts.chainIds[snapshot.chain] ?? '', userId: scope.userId, grantId: grant.id,
      chain: snapshot.chain, grantKind: snapshot.grantKind, accountAddress: syntheticInput.accountAddress,
      keyVersion: snapshot.keyVersion, scopePolicy: syntheticInput.scopePolicy, expiresAt: syntheticInput.expiresAt ?? null });
    check(custodyBindingAad(binding) === custodyBindingAad(snapshot.secretBinding), 'independent entire binding AAD');
    const session = await createCustodyExecutionAccess(executionPorts).session(scope, grant.id);
    let retained: Uint8Array | undefined;
    await session.use(async (bytes, boundary) => {
      retained = bytes;
      check(bytes.length === expected.length && bytes.every((value, index) => value === expected[index]), 'synthetic roundtrip differs');
      check(boundary.grantId === grant.id && boundary.lifecycleRevision === snapshot.lifecycleRevision
        && boundary.revocationTombstone?.getTime() === snapshot.revocationTombstone?.getTime()
        && boundary.expiresAt?.getTime() === snapshot.expiresAt?.getTime(), 'pinned lifecycle boundary differs');
    });
    check(retained && retained.every(value => value === 0), 'session-owned bytes not zeroed');
    try { await session.use(async () => { throw new Error('one-use violated'); }); }
    catch (error) {
      check(error instanceof CustodyContractError && error.code === 'custody-stale', 'one-use retry must refuse');
      return { scenario: 'custody-synthetic-binding-single-use', boundary: custodySourceBoundary,
        blocked: [...custodySourceBlockers], evidence: { grantId: grant.id, lifecycleRevision: snapshot.lifecycleRevision,
          chain: snapshot.chain, grantKind: snapshot.grantKind, secretProjected: false } };
    }
    throw new Error('Custody qualification: session retry unexpectedly succeeded');
  } finally { expected.fill(0); }
}

export interface CustodyOwnedLifecycleScenario {
  readonly scope: UserScope;
  readonly syntheticInput: CustodyEnrollmentInput;
  readonly grantId: string;
  /** Independent snapshot observer, never an enrolling/executing callback log. */
  readonly observe: () => Promise<CustodyJournal>;
  /** Independently specified durable snapshots for each exact stage, including
   * immutable accepted admissions and persistent lifecycle tombstone. */
  readonly expected: {
    readonly enrolled: CustodyJournal; readonly revoked: CustodyJournal;
    readonly retired: CustodyJournal; readonly reactivated: CustodyJournal;
  };
  readonly request: ExecutionAuthorityRequest;
  readonly payload: AuthoritySigningRequest;
  readonly replacement: {
    readonly record: CustodyEnrollmentRecord; readonly authentication: CustodyAdmissionAuthentication;
    readonly admission: CustodySecretAdmission;
  };
  readonly rollback: {
    /** Owned injection prepares a deterministic SQL/COMMIT refusal. It may not
     * fabricate results or perform an unrelated writer transaction. */
    readonly arm: () => Promise<void>;
    readonly input: Parameters<OwnedCustodyComposition['transition']>[1];
  };
}
/** Concrete caller-owned scenario factory. Every operation below invokes the
 * production bodies through the owned composition. Provider/DB approval and
 * independent observer are mandatory external capabilities, not mock fallbacks.
 * Returned evidence is NONSECRET and cannot promote runtime qualification. */
export function createCustodyScenarioFactory(ports: CustodyOwnedCompositionPorts) {
  const custody = createOwnedCustodyComposition(ports);
  return { custody, async lifecycle(input: CustodyOwnedLifecycleScenario) {
    const scenario = { ...input, scope: { userId: input.scope.userId } as UserScope,
      expected: structuredClone(input.expected), replacement: structuredClone(input.replacement),
      request: structuredClone(input.request), payload: structuredClone(input.payload) };
    check(scenario.syntheticInput.secret instanceof Uint8Array && scenario.syntheticInput.secret.length > 0,
      'explicit inert synthetic bytes required');
    const grant = await custody.enroll(scenario.scope, scenario.syntheticInput);
    check(grant.id === scenario.grantId && !('sealedSecret' in grant), 'exact redacted enrolled grant');
    const enrolled = await scenario.observe(); requireCustodyJournal(enrolled, scenario.expected.enrolled);
    const stale = await custody.session(scenario.scope, grant.id, grant.chain);
    const authority = custody.authority(scenario.scope, grant.id);
    const verdict = await authority.authorize(scenario.request);
    check(verdict.kind === 'granted', 'independently deployed exact effect must authorize');
    const signed = await verdict.authority.sign(scenario.payload);
    check(signed.kind === 'signed', 'checked scoped execution result required');
    const replay = await verdict.authority.sign(scenario.payload);
    check(replay.kind === 'refused', 'one-use delegated authorization must refuse replay');
    // Signature bytes are deliberately never published as qualification evidence.
    const current = enrolled.grant!;
    await custody.transition(scenario.scope, { grantId: grant.id, chain: grant.chain,
      expectedLifecycleRevision: current.lifecycleRevision, status: 'revoked', now: ports.now() });
    const revoked = await scenario.observe(); requireCustodyJournal(revoked, scenario.expected.revoked);
    await custody.transition(scenario.scope, { grantId: grant.id, chain: grant.chain,
      expectedLifecycleRevision: revoked.grant!.lifecycleRevision, status: 'retired', now: ports.now() });
    const retired = await scenario.observe(); requireCustodyJournal(retired, scenario.expected.retired);
    // Prior version cannot reactivate through staged ABA. No app admission write.
    try { await custody.replace(scenario.scope, { expectedLifecycleRevision: retired.grant!.lifecycleRevision,
      record: { ...retired.grant! }, now: ports.now() }); throw new Error('same-version ABA succeeded'); }
    catch (error) { check(error instanceof CustodyContractError, 'same-version ABA must be a typed refusal'); }
    requireCustodyRollback(retired, await scenario.observe());
    const admission = await custody.admitReplacement(scenario.scope, scenario.replacement.record, scenario.replacement.authentication);
    check(admission.id === scenario.replacement.admission.id, 'exact independently authenticated replacement admission');
    const admitted = await scenario.observe(); requireCustodyRollback(retired, admitted, scenario.replacement.admission);
    await custody.replace(scenario.scope, { expectedLifecycleRevision: retired.grant!.lifecycleRevision,
      record: scenario.replacement.record, now: ports.now() });
    const reactivated = await scenario.observe(); requireCustodyJournal(reactivated, scenario.expected.reactivated);
    let consumed = false;
    try { await stale.use(async () => { consumed = true; }); throw new Error('stale session ABA succeeded'); }
    catch (error) { check(error instanceof CustodyContractError && error.code === 'custody-stale', 'old session must refuse after fresh activation'); }
    check(!consumed, 'stale session must never consume material');
    await scenario.rollback.arm();
    try { await custody.transition(scenario.scope, scenario.rollback.input); throw new Error('armed rollback unexpectedly committed'); }
    catch (error) { check(error instanceof CustodyContractError, 'rollback must suppress successful transition'); }
    requireCustodyRollback(reactivated, await scenario.observe());
    return { scenario: 'custody-owned-enrollment-delegation-revocation-retirement-fresh-activation-rollback',
      boundary: custodySourceBoundary, blocked: [...custodySourceBlockers], evidence: {
        grantId: grant.id, lifecycleRevisions: [enrolled, revoked, retired, reactivated].map(j => j.grant!.lifecycleRevision),
        journalHashes: [enrolled, revoked, retired, reactivated].map(custodyJournalHash),
        delegatedReplayRefused: true, staleAbaRefused: true, rollbackConserved: true, secretProjected: false } };
  } };
}
