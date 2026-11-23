import { withTransaction } from './transaction.js';
import { isCrossTenant, type UserScope } from './tenancy.js';
import type { FanoutCandidate } from './fanout-eligibility.js';
import { prepareListFanoutCandidates, type ListFanoutCandidatesInput } from './fanout-candidates-owned.js';
export type { ListFanoutCandidatesInput } from './fanout-candidates-owned.js';

/** Compatibility facade only. The wildcard marker is NOT DB authorization;
 * the caller transaction still needs a separately reviewed protected identity.
 * The owned leaf is the sole canonical SQL/mapping body for production and tests.
 */
export async function listFanoutCandidates(
  scope: UserScope, input: ListFanoutCandidatesInput
): Promise<FanoutCandidate[]> {
  if (!isCrossTenant(scope)) {
    throw new Error('listFanoutCandidates spans tenants; pass crossTenantScope(reason)');
  }
  const read = prepareListFanoutCandidates(input);
  return withTransaction(read);
}
