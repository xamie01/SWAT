import { createHash } from 'node:crypto';
import { buildCustodySecretBinding, custodyBindingAad, type CustodySecretBinding } from './custody-contract.js';

/** Minimal structural equivalent of the existing resource-bound shared v2 context. */
export interface CustodyEnvelopeContext {
  readonly contextVersion: 2;
  readonly deploymentId: string;
  readonly userId: string;
  readonly chainKind: 'evm';
  readonly chainId: string;
  readonly accountAddress: string;
  readonly grantId: string;
  readonly grantKind: string;
  readonly purpose: string;
  readonly keyVersion: number;
}
/**
 * Bridge existing v2 envelope primitives WITHOUT importing their key wrappers
 * into enrollment. Policy/expiry/scope version are authenticated in purpose's
 * digest, not just stored as adjacent JSON labels. The approved wrap/open
 * service must both use this mapping; old purpose='execution-grant' envelopes
 * are not silently upgraded. This helper performs no encryption or generation.
 */
export function custodyEnvelopeContext(binding: CustodySecretBinding): CustodyEnvelopeContext {
  // Validate all fields/unknown extras through the same canonical context.
  const canonical = buildCustodySecretBinding({ deploymentId: binding.deploymentId, userId: binding.userId,
    chainId: binding.chainId, grantId: binding.grantId, chain: binding.chain, grantKind: binding.grantKind,
    accountAddress: binding.accountAddress, keyVersion: binding.keyVersion,
    // Rebuild cannot recover the policy itself; retain authenticated digest below.
    scopePolicy: null, expiresAt: binding.expiresAt === null ? null : new Date(binding.expiresAt) });
  if (!/^[0-9a-f]{64}$/.test(binding.policyDigest) ||
    custodyBindingAad({ ...canonical, policyDigest: binding.policyDigest }) !== custodyBindingAad(binding)) {
    throw new Error('custody-invalid');
  }
  const digest = createHash('sha256').update(custodyBindingAad(binding)).digest('hex');
  return Object.freeze({ contextVersion: 2, deploymentId: binding.deploymentId, userId: binding.userId,
    chainKind: 'evm', chainId: binding.chainId, accountAddress: binding.accountAddress,
    grantId: binding.grantId, grantKind: binding.grantKind, keyVersion: binding.keyVersion,
    purpose: `execution-grant:scope-v1:${digest}` });
}
