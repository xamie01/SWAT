import { createCustodyEnrollment, type CustodyEnrollmentInput } from '../../../packages/db/src/custody-enrollment.js';
import { createCustodyExecutionAccess } from '../../../packages/db/src/custody-execution.js';
import { buildCustodySecretBinding, custodyBindingAad, CustodyContractError } from '../../../packages/db/src/custody-contract.js';
import { createCustodyEnrollmentStore, createCustodyExecutionStore, type CustodyTenantTransaction } from '../../../packages/db/src/custody-store.js';
import type { UserScope } from '../../../packages/db/src/tenancy.js';

export const custodySourceBoundary = Object.freeze({ sourceImplemented: true, runtimeAccepted: false,
  liveCapabilityAccepted: false, productionReady: false } as const);
export const custodySourceBlockers = Object.freeze([
  'distinct deployed enrollment wrap and execution unwrap service identities unqualified',
  'restricted independent custody-secret admission and actual SQL RLS lifecycle commit proof unavailable',
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
