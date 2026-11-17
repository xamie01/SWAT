import { createHash } from 'node:crypto';
import type { Chain } from '@swat/shared';
import type { GrantKind, GrantStatus } from './execution-grants.js';

/** Metadata authenticated by the wrap service, not an execution permission. */
export interface CustodySecretBinding {
  readonly contextVersion: 2;
  readonly purpose: 'execution-grant';
  readonly deploymentId: string;
  readonly userId: string;
  readonly chain: Chain;
  readonly chainId: string;
  readonly grantId: string;
  readonly grantKind: GrantKind;
  readonly accountAddress: string;
  readonly keyVersion: number;
  readonly scopeVersion: 1;
  readonly policyDigest: string;
  readonly expiresAt: string | null;
}
export interface CustodyGrantSnapshot {
  readonly id: string;
  readonly userId: string;
  readonly chain: Chain;
  readonly grantKind: GrantKind;
  readonly accountAddress: string;
  readonly status: GrantStatus;
  /** Database-generated canonical positive bigint; changes on every lifecycle write. */
  readonly lifecycleRevision: string;
  /** Persistent last revocation, including after retired staging and fresh activation. */
  readonly revocationTombstone: Date | null;
  readonly revokedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly scopePolicy: unknown;
  readonly keyVersion: number | null;
  readonly secretBinding: CustodySecretBinding | null;
  readonly sealedSecret: string | null;
}
export class CustodyContractError extends Error {
  constructor(readonly code: 'custody-invalid' | 'custody-unavailable' | 'custody-stale' | 'custody-conflict') {
    super(code); this.name = 'CustodyContractError';
  }
}
function invalid(): never { throw new CustodyContractError('custody-invalid'); }
export function custodyIdentifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(value) || value === '*') invalid();
}
export function custodyGrantId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) invalid();
}
export function canonicalCustodyAccount(chain: Chain, value: string): string {
  if (typeof value !== 'string') invalid();
  const raw = value.startsWith(`${chain}:`) ? value.slice(chain.length + 1) : value;
  if (chain === 'solana') {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(raw)) invalid();
    return raw;
  }
  if ((chain !== 'polygon' && chain !== 'robinhood-chain') || !/^0x[0-9a-fA-F]{40}$/.test(raw)) invalid();
  return raw.toLowerCase();
}
export function assertCustodyChainKind(chain: Chain, kind: GrantKind): void {
  if (!(kind === 'solana_vault' ? chain === 'solana' : kind === 'polymarket_signer' ? chain === 'polygon'
    : (kind === 'eip7702' || kind === 'session_key_4337') && chain === 'robinhood-chain')) invalid();
}
function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 16) invalid();
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (value.length > 256 || Object.keys(value).length !== value.length) invalid();
    return `[${value.map(v => canonicalJson(v, depth + 1)).join(',')}]`;
  }
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors).sort();
    if (keys.length > 256 || Object.getOwnPropertySymbols(value).length) invalid();
    return `{${keys.map(key => {
      const descriptor = descriptors[key]!;
      if (!('value' in descriptor) || !descriptor.enumerable) invalid();
      return `${JSON.stringify(key)}:${canonicalJson(descriptor.value, depth + 1)}`;
    }).join(',')}}`;
  }
  return invalid();
}
export function custodyPolicySnapshot(policy: unknown): unknown {
  const json = canonicalJson(policy === undefined ? null : policy);
  if (json.length > 65536) invalid();
  return JSON.parse(json);
}
export function custodyPolicyDigest(policy: unknown): string {
  const json = canonicalJson(policy === undefined ? null : policy);
  if (json.length > 65536) invalid();
  return createHash('sha256').update(json).digest('hex');
}
export function buildCustodySecretBinding(input: {
  deploymentId: string; chainId: string; userId: string; grantId: string; chain: Chain;
  grantKind: GrantKind; accountAddress: string; keyVersion: number; scopePolicy: unknown; expiresAt: Date | null;
}): CustodySecretBinding {
  for (const value of [input.deploymentId, input.chainId, input.userId]) custodyIdentifier(value);
  custodyGrantId(input.grantId);
  assertCustodyChainKind(input.chain, input.grantKind);
  if (input.grantKind === 'solana_vault' || !Number.isSafeInteger(input.keyVersion) || input.keyVersion <= 0) invalid();
  if ((input.chain === 'polygon' && input.chainId !== '137') ||
      (input.chain === 'robinhood-chain' && input.chainId !== '4663')) invalid();
  if (input.expiresAt !== null && (!(input.expiresAt instanceof Date) || !Number.isFinite(input.expiresAt.getTime()))) invalid();
  if ((input.grantKind === 'eip7702' || input.grantKind === 'session_key_4337') && input.expiresAt === null) invalid();
  return Object.freeze({
    contextVersion: 2, purpose: 'execution-grant', deploymentId: input.deploymentId,
    userId: input.userId, chain: input.chain, chainId: input.chainId, grantId: input.grantId,
    grantKind: input.grantKind, accountAddress: canonicalCustodyAccount(input.chain, input.accountAddress),
    keyVersion: input.keyVersion, scopeVersion: 1, policyDigest: custodyPolicyDigest(input.scopePolicy),
    expiresAt: input.expiresAt?.toISOString() ?? null
  });
}
/** The full serialized context must be authenticated by both wrap and unwrap implementations. */
export function custodyBindingAad(binding: CustodySecretBinding): string {
  return canonicalJson(binding);
}
export function assertCustodyBindingMatches(binding: CustodySecretBinding, grant: {
  id: string; userId: string; chain: Chain; grantKind: GrantKind; accountAddress: string;
  keyVersion: number | null; scopePolicy: unknown; expiresAt: Date | null;
}, domain?: { deploymentId: string; chainId: string }): void {
  if (!binding || grant.keyVersion === null) invalid();
  const expected = buildCustodySecretBinding({
    deploymentId: domain?.deploymentId ?? binding.deploymentId, chainId: domain?.chainId ?? binding.chainId,
    userId: grant.userId, grantId: grant.id, chain: grant.chain, grantKind: grant.grantKind,
    accountAddress: grant.accountAddress, keyVersion: grant.keyVersion,
    scopePolicy: grant.scopePolicy, expiresAt: grant.expiresAt
  });
  if (custodyBindingAad(binding) !== custodyBindingAad(expected)) invalid();
}
export function assertCustodyEnvelope(envelope: string, keyVersion: number, wrapperId?: string): void {
  if (typeof envelope !== 'string' || envelope.length > 131072) invalid();
  const parts = envelope.split('.');
  if (parts.length !== 7 || parts[0] !== 'v2' || parts[2] !== String(keyVersion)) invalid();
  custodyIdentifier(parts[1]);
  if (wrapperId !== undefined && parts[1] !== wrapperId) invalid();
  for (const part of parts.slice(3)) {
    if (!part || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(part)
      || Buffer.from(part, 'base64').toString('base64') !== part) invalid();
  }
  if (Buffer.from(parts[4]!, 'base64').length !== 12 || Buffer.from(parts[5]!, 'base64').length !== 16) invalid();
}
export function assertCustodyLifecycle(grant: Pick<CustodyGrantSnapshot, 'lifecycleRevision' | 'revocationTombstone' | 'revokedAt'>, now: Date): void {
  if (typeof grant.lifecycleRevision !== 'string' || !/^[1-9][0-9]{0,18}$/.test(grant.lifecycleRevision) ||
      BigInt(grant.lifecycleRevision) > 9223372036854775807n ||
      (grant.revocationTombstone !== null && (!(grant.revocationTombstone instanceof Date) ||
        !Number.isFinite(grant.revocationTombstone.getTime()) || grant.revocationTombstone.getTime() > now.getTime())) ||
      (grant.revokedAt !== null && (!(grant.revokedAt instanceof Date) || !Number.isFinite(grant.revokedAt.getTime()) ||
        grant.revocationTombstone === null || grant.revocationTombstone.getTime() < grant.revokedAt.getTime()))) {
    throw new CustodyContractError('custody-stale');
  }
}
export function assertCustodyActive(grant: CustodyGrantSnapshot, now: Date): void {
  assertCustodyLifecycle(grant, now);
  if (!Number.isFinite(now.getTime()) || grant.status !== 'active' || grant.revokedAt !== null ||
      (grant.expiresAt !== null && (!(grant.expiresAt instanceof Date) || !Number.isFinite(grant.expiresAt.getTime()) ||
        !(grant.expiresAt.getTime() > now.getTime())))) {
    throw new CustodyContractError('custody-stale');
  }
}
export interface CustodyReadiness {
  readonly sourceImplemented: true;
  readonly injectedPortsConfigured: boolean;
  readonly runtimeAccepted: false;
  readonly liveCapabilityAccepted: false;
  readonly blockers: readonly string[];
}
export function custodyReadiness(configured: boolean): CustodyReadiness {
  return { sourceImplemented: true, injectedPortsConfigured: configured, runtimeAccepted: false,
    liveCapabilityAccepted: false, blockers: ['approved-wrap-service-identity', 'approved-execution-unwrap-identity',
      'schema081-isolated-qualification', 'verified-deployed-delegation'] };
}
