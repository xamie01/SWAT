import type { UserScope } from './tenancy.js';
import {
  assertCustodyActive, assertCustodyBindingMatches, assertCustodyEnvelope, custodyBindingAad,
  custodyIdentifier, CustodyContractError, type CustodyGrantSnapshot, type CustodySecretBinding
} from './custody-contract.js';

/** Execution-only service port; no wrap, generate or export-key operation. */
export interface CustodyExecutionUnwrapPort {
  open(input: { readonly sealedSecret: string; readonly binding: CustodySecretBinding }): Promise<Uint8Array>;
}
export interface CustodyExecutionStore {
  /** Must read current grant in an authenticated tenant context, never a cached public projection. */
  load(scope: UserScope, grantId: string): Promise<CustodyGrantSnapshot | null>;
}
export interface CustodyExecutionBoundary {
  readonly grantId: string;
  readonly lifecycleRevision: string;
  readonly revocationTombstone: Date | null;
  readonly expiresAt: Date | null;
}
export interface CustodyExecutionSession {
  /** Consumer must atomically recheck this lifecycle at its effect boundary and never retain bytes. */
  use<T>(consume: (secret: Uint8Array, boundary: CustodyExecutionBoundary) => Promise<T>): Promise<T>;
}
function fingerprint(grant: CustodyGrantSnapshot): string {
  return JSON.stringify([grant.id, grant.userId, grant.chain, grant.grantKind, grant.accountAddress,
    grant.status, grant.lifecycleRevision, grant.revocationTombstone?.toISOString(), grant.revokedAt?.toISOString(),
    grant.expiresAt?.toISOString(), grant.keyVersion,
    grant.sealedSecret, grant.secretBinding ? custodyBindingAad(grant.secretBinding) : null]);
}
export function createCustodyExecutionAccess(deps: {
  readonly deploymentId: string;
  readonly chainIds: Readonly<Partial<Record<CustodyGrantSnapshot['chain'], string>>>;
  readonly store: CustodyExecutionStore;
  readonly unwrap: CustodyExecutionUnwrapPort;
  readonly now: () => Date;
}) {
  function validate(scope: UserScope, grantId: string, grant: CustodyGrantSnapshot | null): CustodyGrantSnapshot {
    if (!grant || grant.id !== grantId || grant.userId !== scope.userId) throw new CustodyContractError('custody-stale');
    assertCustodyActive(grant, deps.now());
    if (grant.grantKind === 'solana_vault' || grant.keyVersion === null || !grant.secretBinding || !grant.sealedSecret) {
      throw new CustodyContractError('custody-invalid');
    }
    assertCustodyBindingMatches(grant.secretBinding, grant,
      { deploymentId: deps.deploymentId, chainId: deps.chainIds[grant.chain] ?? '' });
    assertCustodyEnvelope(grant.sealedSecret, grant.keyVersion);
    return grant;
  }
  return {
    async session(scope: UserScope, grantId: string): Promise<CustodyExecutionSession> {
      scope = { userId: scope.userId } as UserScope;
      custodyIdentifier(scope.userId);
      const initial = validate(scope, grantId, structuredClone(await deps.store.load(scope, grantId)));
      const pinned = fingerprint(initial);
      let consumed = false;
      return {
        async use<T>(consume: (secret: Uint8Array, boundary: CustodyExecutionBoundary) => Promise<T>): Promise<T> {
          if (consumed) throw new CustodyContractError('custody-stale');
          consumed = true; // one use, including failed/uncertain unwraps
          const current = validate(scope, grantId, structuredClone(await deps.store.load(scope, grantId)));
          if (fingerprint(current) !== pinned) throw new CustodyContractError('custody-stale');
          let owned: Uint8Array | undefined;
          let providerBytes: Uint8Array | undefined;
          try {
            try {
              providerBytes = await deps.unwrap.open({ sealedSecret: current.sealedSecret!, binding: current.secretBinding! });
            } catch { throw new CustodyContractError('custody-unavailable'); }
            if (!(providerBytes instanceof Uint8Array) || providerBytes.length === 0 || providerBytes.length > 8192) {
              throw new CustodyContractError('custody-invalid');
            }
            owned = Uint8Array.from(providerBytes);
            providerBytes.fill(0); // port contract transfers ownership; no cached-key buffers
            const latest = validate(scope, grantId, structuredClone(await deps.store.load(scope, grantId)));
            if (fingerprint(latest) !== pinned) throw new CustodyContractError('custody-stale');
            // Consumer performs the effect through a scoped executor, not a public route.
            // That executor must recheck deployed scope at its actual submission boundary.
            try { return await consume(owned, { grantId: latest.id, lifecycleRevision: latest.lifecycleRevision,
              revocationTombstone: latest.revocationTombstone ? new Date(latest.revocationTombstone) : null,
              expiresAt: latest.expiresAt ? new Date(latest.expiresAt) : null }); }
            catch { throw new CustodyContractError('custody-unavailable'); }
          } finally { owned?.fill(0); providerBytes?.fill(0); }
        }
      };
    }
  };
}
