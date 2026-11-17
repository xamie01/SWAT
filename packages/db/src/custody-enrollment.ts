import type { Chain } from '@swat/shared';
import type { ExecutionGrant, GrantKind } from './execution-grants.js';
import type { UserScope } from './tenancy.js';
import {
  assertCustodyBindingMatches, assertCustodyChainKind, assertCustodyEnvelope, buildCustodySecretBinding,
  canonicalCustodyAccount, custodyGrantId, custodyIdentifier, custodyPolicySnapshot, custodyPolicyDigest, custodyReadiness, CustodyContractError,
  type CustodyReadiness, type CustodySecretBinding
} from './custody-contract.js';

/** Enrollment has no decrypt/sign/generate method. A real service identity is a separate gate. */
export interface CustodyEnrollmentWrapPort {
  readonly wrapperId: string;
  readonly keyVersion: number;
  /** Must authenticate the entire binding AAD; any inner envelope purpose must include its digest. */
  seal(input: { readonly plaintext: Uint8Array; readonly binding: CustodySecretBinding }): Promise<string>;
}
export interface CustodyEnrollmentRecord {
  readonly id: string;
  readonly chain: Chain;
  readonly grantKind: GrantKind;
  readonly accountAddress: string;
  readonly sealedSecret: string | null;
  readonly keyVersion: number | null;
  readonly secretBinding: CustodySecretBinding | null;
  readonly scopePolicy: unknown;
  readonly expiresAt: Date | null;
}
export interface CustodyEnrollmentStore {
  /** Must commit tenant ownership/conflict checks and record atomically before returning. */
  record(scope: UserScope, input: CustodyEnrollmentRecord): Promise<ExecutionGrant>;
}
export interface CustodyEnrollmentInput {
  readonly chain: Chain;
  readonly grantKind: GrantKind;
  readonly accountAddress: string;
  readonly secret?: Uint8Array | null;
  readonly scopePolicy?: unknown;
  readonly expiresAt?: Date | null;
}
export interface CustodyEnrollment {
  readiness(): CustodyReadiness;
  enroll(scope: UserScope, input: CustodyEnrollmentInput): Promise<ExecutionGrant>;
}
function publicGrant(grant: ExecutionGrant): ExecutionGrant {
  // Explicit allowlist, not spreading a storage row or a malicious injected result.
  return { id: grant.id, userId: grant.userId, chain: grant.chain, grantKind: grant.grantKind,
    accountAddress: grant.accountAddress, hasSealedSecret: grant.hasSealedSecret, keyVersion: grant.keyVersion,
    scopePolicy: grant.scopePolicy, expiresAt: grant.expiresAt, revokedAt: grant.revokedAt,
    status: grant.status, createdAt: grant.createdAt };
}
export function createCustodyEnrollment(deps: {
  readonly deploymentId: string;
  readonly chainIds: Readonly<Partial<Record<Chain, string>>>;
  /** Trusted ID allocation, separate from user input. Never an account/key generator. */
  readonly allocateGrantId: () => Promise<string>;
  readonly store: CustodyEnrollmentStore;
  readonly wrap?: CustodyEnrollmentWrapPort;
  readonly now: () => Date;
}): CustodyEnrollment {
  return {
    readiness: () => custodyReadiness(!!deps.wrap),
    async enroll(scope, input) {
      // Snapshot request/principal before the first async boundary.
      scope = { userId: scope.userId } as UserScope;
      const chain = input.chain, grantKind = input.grantKind;
      input = { ...input, chain, grantKind };
      custodyIdentifier(scope.userId);
      assertCustodyChainKind(input.chain, input.grantKind);
      const accountAddress = canonicalCustodyAccount(input.chain, input.accountAddress);
      const scopePolicy = custodyPolicySnapshot(input.scopePolicy);
      const expiresAt = input.expiresAt == null ? null : new Date(input.expiresAt.getTime());
      const now = deps.now();
      if (!Number.isFinite(now.getTime()) || (expiresAt !== null && !(expiresAt.getTime() > now.getTime())) ||
        ((input.grantKind === 'eip7702' || input.grantKind === 'session_key_4337') && expiresAt === null)) {
        throw new CustodyContractError('custody-invalid');
      }
      const keyless = input.grantKind === 'solana_vault';
      if (keyless && input.secret != null) throw new CustodyContractError('custody-invalid');
      if (!keyless && (!(input.secret instanceof Uint8Array) || input.secret.byteLength === 0 || input.secret.byteLength > 8192)) {
        throw new CustodyContractError('custody-invalid');
      }
      if (!keyless && !deps.wrap) throw new CustodyContractError('custody-unavailable');
      // Copy before the first await. The caller cannot swap the secret or policy while wrapping.
      const plaintext = keyless ? null : Uint8Array.from(input.secret!);
      try {
        const id = await deps.allocateGrantId();
        custodyGrantId(id);
        let secretBinding: CustodySecretBinding | null = null;
        let sealedSecret: string | null = null;
        let keyVersion: number | null = null;
        if (!keyless) {
          const wrap = deps.wrap!;
          keyVersion = wrap.keyVersion;
          secretBinding = buildCustodySecretBinding({ deploymentId: deps.deploymentId,
            chainId: deps.chainIds[input.chain] ?? '', userId: scope.userId, grantId: id, chain: input.chain,
            grantKind: input.grantKind, accountAddress, keyVersion, scopePolicy, expiresAt });
          custodyIdentifier(wrap.wrapperId);
          try { sealedSecret = await wrap.seal({ plaintext: plaintext!, binding: secretBinding }); }
          catch { throw new CustodyContractError('custody-unavailable'); }
          assertCustodyEnvelope(sealedSecret, keyVersion, wrap.wrapperId);
        }
        if (expiresAt !== null && !(expiresAt.getTime() > deps.now().getTime())) throw new CustodyContractError('custody-stale');
        const record = { id, chain: input.chain, grantKind: input.grantKind, accountAddress,
          sealedSecret, keyVersion, secretBinding, scopePolicy, expiresAt };
        if (secretBinding) assertCustodyBindingMatches(secretBinding, { ...record, userId: scope.userId });
        const grant = await deps.store.record(scope, record);
        if (grant.id !== id || grant.userId !== scope.userId || grant.chain !== record.chain ||
          grant.grantKind !== record.grantKind || grant.accountAddress !== accountAddress || grant.status !== 'active' ||
          grant.revokedAt !== null || grant.keyVersion !== keyVersion || grant.hasSealedSecret !== !keyless ||
          custodyPolicyDigest(grant.scopePolicy) !== custodyPolicyDigest(scopePolicy) ||
          (grant.expiresAt?.getTime() ?? null) !== (expiresAt?.getTime() ?? null)) {
          throw new CustodyContractError('custody-conflict');
        }
        if (secretBinding) assertCustodyBindingMatches(secretBinding, grant);
        return publicGrant(grant);
      } catch (error) {
        if (error instanceof CustodyContractError) throw error;
        throw new CustodyContractError('custody-unavailable');
      } finally { plaintext?.fill(0); }
    }
  };
}
