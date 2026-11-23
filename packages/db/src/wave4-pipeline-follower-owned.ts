import type { PoolClient } from 'pg';
import type { Chain } from '@swat/shared';
import { resolveChainAddress } from '@swat/shared';
import { createExactFollowerEntryRequest, type ReviewedFollowerSizingProvider,
  type ExactFollowerIdentity, type TrustedFollowerBalance } from './exact-follower-sizing.js';
import { exactDecimal, compareExactDecimal } from './runtime-exact-decimal.js';
import { sourceTokenQuantity,sourceContentDigest } from './source-verification.js';
import { readPipelineBackendApproval, requirePipelineProtectedRoutine, pipelineRequire,
  pipelineUuid, pipelineText, pipelineTime } from './wave4-pipeline-source-owned.js';

export interface PipelineFollowerAuthority {
  readonly authorityId: string; readonly providerId: string; readonly providerIdentity: string;
  readonly chain: Chain; readonly network: string;
}
export function pipelineFollowerEvidenceDigest(input: {
  authorityId: string; providerId: string; providerIdentity: string; evidenceId: string;
  userId: string; chain: Chain; network: string; targetAccount: string; tokenMint: string;
  executionMode: ExactFollowerIdentity['executionMode']; rawAvailableUsd: string; usdScale: number;
  availableUsd: string; observedAt: string; expiresAt: string;
}): string {
  // Fixed field order binds every exact economic and immutable identity term.
  return sourceContentDigest(JSON.stringify({ authorityId: input.authorityId,providerId: input.providerId,
    providerIdentity: input.providerIdentity,evidenceId: input.evidenceId,userId: input.userId,chain: input.chain,
    network: input.network,targetAccount: input.targetAccount,tokenMint: input.tokenMint,executionMode: input.executionMode,
    rawAvailableUsd: input.rawAvailableUsd,usdScale: input.usdScale,availableUsd: input.availableUsd,
    observedAt: input.observedAt,expiresAt: input.expiresAt }));
}
/** Fixed independently protected exact balance SQL contract. SQL048 is only a
 * numeric cache and cannot meet it. Missing routine/provider refuses: no Number,
 * master fill, cached USD or queue flag is consulted. Owner/DDL/writer enrollment
 * remains a literal provisioning requirement, not an injected approval callback. */
export function createProtectedExactFollowerProvider(candidate: PipelineFollowerAuthority): ReviewedFollowerSizingProvider {
  pipelineRequire(candidate && pipelineText(candidate.authorityId) && pipelineText(candidate.providerId)
    && typeof candidate.providerIdentity === 'string' && /^[0-9a-f]{64}$/.test(candidate.providerIdentity)
    && ['solana','polygon','robinhood-chain'].includes(candidate.chain) && pipelineText(candidate.network,128),
  'exact follower approved authority selector required');
  const authority = Object.freeze({ ...candidate });
  return Object.freeze({ providerId: authority.providerId,providerIdentity: authority.providerIdentity,
    networkForChain: (chain: Chain) => chain === authority.chain ? authority.network : null,
    async readBalance(client: PoolClient, candidateIdentity: ExactFollowerIdentity): Promise<TrustedFollowerBalance | null> {
      const identity = Object.freeze({ ...candidateIdentity });
      pipelineUuid(identity.userId);
      pipelineRequire(identity.chain === authority.chain && ['paper','live','shadow'].includes(identity.executionMode)
        && resolveChainAddress(identity.targetAccount,identity.chain).prefixed === identity.targetAccount
        && resolveChainAddress(identity.tokenMint,identity.chain).prefixed === identity.tokenMint,
      'exact follower immutable identity required');
      await readPipelineBackendApproval(client,'fanout','');
      await requirePipelineProtectedRoutine(client,'follower');
      const result = await client.query('SELECT * FROM public.swat_pipeline_exact_follower_balance($1::uuid,$2::text,$3::text,$4::text,$5::text)',
        [identity.userId,identity.chain,identity.targetAccount,identity.tokenMint,identity.executionMode]);
      if (result.rows.length === 0) return null;
      pipelineRequire(result.rows.length === 1,'ambiguous exact follower evidence');
      const r = result.rows[0];
      pipelineRequire(r.authority_id === authority.authorityId && r.provider_id === authority.providerId
        && r.provider_identity === authority.providerIdentity && r.enabled === true && r.revoked_at === null
        && r.user_id === identity.userId && r.chain === identity.chain && r.network === authority.network
        && r.target_account === identity.targetAccount && r.token_mint === identity.tokenMint
        && r.execution_mode === identity.executionMode && pipelineText(r.evidence_id)
        && typeof r.evidence_digest === 'string' && /^[0-9a-f]{64}$/.test(r.evidence_digest)
        && pipelineTime(r.observed_at) && pipelineTime(r.expires_at) && pipelineTime(r.provider_valid_until)
        && pipelineTime(r.database_now) && r.observed_at <= r.database_now && r.expires_at > r.database_now
        && r.expires_at > r.observed_at && r.expires_at <= r.provider_valid_until
        && r.provider_valid_until > r.database_now, 'protected exact follower authority/scope/freshness mismatch');
      exactDecimal(r.available_usd);
      pipelineRequire(typeof r.raw_available_usd === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(r.raw_available_usd)
        && Number.isInteger(r.usd_scale) && r.usd_scale >= 0 && r.usd_scale <= 36,'exact follower raw-scale required');
      const quantity = r.raw_available_usd === '0' ? '0' : sourceTokenQuantity(r.raw_available_usd,r.usd_scale);
      pipelineRequire(compareExactDecimal(quantity,r.available_usd) === 0 && quantity === r.available_usd,
        'exact follower raw-scale drift');
      pipelineRequire(r.evidence_digest === pipelineFollowerEvidenceDigest({ authorityId: r.authority_id,
        providerId: r.provider_id,providerIdentity: r.provider_identity,evidenceId: r.evidence_id,userId: identity.userId,
        chain: identity.chain,network: r.network,targetAccount: identity.targetAccount,tokenMint: identity.tokenMint,
        executionMode: identity.executionMode,rawAvailableUsd: r.raw_available_usd,usdScale: r.usd_scale,availableUsd: quantity,
        observedAt: r.observed_at.toISOString(),expiresAt: r.expires_at.toISOString() }), 'exact follower immutable evidence digest drift');
      return Object.freeze({ providerId: authority.providerId,providerIdentity: authority.providerIdentity,evidenceId: r.evidence_id,
        userId: identity.userId,chain: identity.chain,network: authority.network,targetAccount: identity.targetAccount,
        executionMode: identity.executionMode,availableUsd: quantity,observedAt: new Date(r.observed_at),expiresAt: new Date(r.expires_at) });
    }
  });
}

/** Real exact-follower policy/cap-remaining arithmetic, not a duplicate sizing
 * implementation. Explicit null provider preserves existing unavailable buys. */
export function createProtectedExactFollowerEntryRequest(input: {
  authority: PipelineFollowerAuthority | null; now: () => Date; maximumAgeMs: number;
}) {
  pipelineRequire(typeof input.now === 'function' && Number.isSafeInteger(input.maximumAgeMs)
    && input.maximumAgeMs > 0 && input.maximumAgeMs <= 60_000,'bounded exact follower freshness required');
  const request = createExactFollowerEntryRequest({ provider: input.authority
    ? createProtectedExactFollowerProvider(input.authority) : null,now: input.now,maximumAgeMs: input.maximumAgeMs });
  return (client: PoolClient, candidate: Parameters<typeof request>[1]) => {
    const captured = { chain: candidate.chain,data: { ...candidate.data } };
    return request(client,captured);
  };
}
