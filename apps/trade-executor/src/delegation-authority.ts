import type { Chain } from '@swat/shared';
import {
  denied, capabilityForSigningRequest, type AuthorityCapability, type AuthoritySigningRequest,
  type AuthoritySigningResult, type DelegatedExecutionEffect, type DelegatedPayloadScope,
  type ExecutionAuthorityRequest, type ExecutionAuthorityVerdict, type UserExecutionAuthority
} from './execution-authority.js';

/** Authenticated current grant projection supplied from tenant storage, not an HTTP body. */
export interface DelegationGrant {
  readonly id: string;
  readonly userId: string;
  readonly chain: Chain;
  readonly grantKind: 'solana_vault' | 'eip7702' | 'session_key_4337';
  readonly accountAddress: string;
  readonly status: 'active' | 'retired' | 'revoked' | 'compromised';
  readonly lifecycleRevision: string;
  readonly revocationTombstone: Date | null;
  readonly revokedAt: Date | null;
  readonly expiresAt: Date | null;
  /** Only for custody integrity. It is never used as delegated policy. */
  readonly scopePolicy?: unknown;
}
export interface DeployedDelegationRule {
  readonly action: DelegatedExecutionEffect['action'];
  readonly direction: DelegatedExecutionEffect['direction'];
  readonly instrument: string;
  readonly target: string;
  readonly selector: string;
  readonly recipient: string;
  readonly spendAsset: string;
  readonly spender: string;
  readonly maxSpendBaseUnits: string;
  readonly permission: {
    readonly kind: 'erc20-allowance' | 'permit2';
    readonly maxAllowanceBaseUnits: string;
    readonly maxLifetimeMs: number;
  } | null;
}
/** A trusted verifier reads actual deployed code/policy + finality + current revocation. */
export interface VerifiedDeployedDelegation {
  readonly grantId: string;
  readonly userId: string;
  readonly chain: Chain;
  readonly chainId: string;
  readonly deploymentId: string;
  readonly mechanism: DelegationGrant['grantKind'];
  readonly settlementAddress: string;
  readonly signingAddress: string;
  readonly revision: string;
  /** Actual current nonce and signature domain, never synthesized from request labels. */
  readonly nonce: string;
  readonly signatureDomain: DelegatedPayloadScope['signatureDomain'];
  readonly finality: 'finalized';
  readonly verifiedAt: Date;
  readonly validUntil: Date;
  readonly expiresAt: Date;
  readonly revoked: boolean;
  readonly capabilities: readonly Exclude<AuthorityCapability, 'venue-managed-submission'>[];
  readonly rules: readonly DeployedDelegationRule[];
}
export interface DecodedDelegatedPayload {
  readonly effect: DelegatedExecutionEffect;
  readonly scope: DelegatedPayloadScope;
}
export interface DeployedDelegationPorts {
  loadGrant(userId: string, chain: Chain): Promise<DelegationGrant | null>;
  /** Evidence authority: must read actual deployed policy, nonce and authenticated signature domain. */
  inspect(grant: DelegationGrant): Promise<VerifiedDeployedDelegation | null>;
  /** Decode ALL actual effects and their complete signed scope, including nested/batched effects. */
  decode(request: AuthoritySigningRequest, deployment: VerifiedDeployedDelegation): Promise<readonly DecodedDelegatedPayload[]>;
  /**
   * Atomically recheck tenant grant lifecycle/tombstone, deployed revision, current
   * nonce, actual payload effects + scope and issuedDeadline at the actual effect
   * boundary; consume the nonce/authorization atomically. Local rereads are not
   * TOCTOU, replay or remote signer isolation proof. Never use an unconstrained signer.
   */
  signScoped(input: {
    readonly grant: DelegationGrant;
    readonly deployment: VerifiedDeployedDelegation;
    readonly expectedRevision: string;
    readonly expectedLifecycleRevision: string;
    readonly expectedRevocationTombstone: Date | null;
    readonly issuedDeadline: Date;
    readonly effect: DelegatedExecutionEffect;
    readonly payloadScope: DelegatedPayloadScope;
    readonly request: AuthoritySigningRequest;
  }): Promise<AuthoritySigningResult>;
}
export interface DeployedDelegationPolicy {
  /** Independently approved venue spenders, never taken from deployed/caller labels. */
  readonly approvedVenueSpenders: readonly string[];
  /** Finite local loss ceiling, strictly below uint160/uint256 unlimited sentinels. */
  readonly maxSpendBaseUnits: string;
  readonly maxPermissionLifetimeMs: number;
  readonly maxSignatureLifetimeMs: number;
}
function id(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(value) && value !== '*';
}
function integer(value: unknown, bits: number, positive = true): value is string {
  return typeof value === 'string' && (positive ? /^[1-9][0-9]{0,77}$/ : /^(0|[1-9][0-9]{0,77})$/).test(value)
    && BigInt(value) < (1n << BigInt(bits)) - 1n; // exclude unlimited sentinel as well as overflow
}
function address(chain: Chain, value: unknown): value is string {
  return typeof value === 'string' && (chain === 'solana' ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value) : /^0x[0-9a-f]{40}$/.test(value));
}
function date(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}
function deadline(value: unknown): number {
  if (typeof value !== 'string') return NaN;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? time : NaN;
}
function lifetime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
function validDomain(domain: DelegatedPayloadScope['signatureDomain'], chain: Chain): boolean {
  return !!domain && domain.kind === (chain === 'solana' ? 'solana-message' : 'eip712') &&
    id(domain.name) && id(domain.version) && address(chain, domain.verifyingContract) &&
    (domain.salt === null || /^0x[0-9a-f]{64}$/.test(domain.salt));
}
function equalDomain(a: DelegatedPayloadScope['signatureDomain'], b: DelegatedPayloadScope['signatureDomain']): boolean {
  return a.kind === b.kind && a.name === b.name && a.version === b.version &&
    a.verifyingContract === b.verifyingContract && a.salt === b.salt;
}
function validEffect(effect: DelegatedExecutionEffect, chain: Chain): boolean {
  if (!effect || !['venue-trade', 'token-spend-permission', 'position-redemption'].includes(effect.action) ||
    !id(effect.instrument) || !id(effect.selector) || ![effect.target, effect.recipient, effect.spendAsset, effect.spender].every(a => address(chain, a)) ||
    !integer(effect.spendAmountBaseUnits, chain === 'solana' ? 64 : 256)) return false;
  if (effect.action === 'token-spend-permission') {
    const p = effect.permission;
    return chain !== 'solana' && effect.direction === null && !!p &&
      (p.kind === 'erc20-allowance' || p.kind === 'permit2') && integer(p.allowanceBaseUnits, p.kind === 'permit2' ? 160 : 256) &&
      p.allowanceBaseUnits === effect.spendAmountBaseUnits;
  }
  return effect.permission === null && (effect.action === 'venue-trade'
    ? effect.direction === 'buy' || effect.direction === 'sell' : effect.direction === null);
}
function equalEffect(a: DelegatedExecutionEffect, b: DelegatedExecutionEffect): boolean {
  return a.action === b.action && a.direction === b.direction && a.instrument === b.instrument &&
    a.target === b.target && a.selector === b.selector && a.recipient === b.recipient && a.spender === b.spender &&
    a.spendAsset === b.spendAsset && a.spendAmountBaseUnits === b.spendAmountBaseUnits &&
    (a.permission === null ? b.permission === null : b.permission !== null &&
      a.permission.kind === b.permission.kind && a.permission.allowanceBaseUnits === b.permission.allowanceBaseUnits);
}
function equalScope(a: DelegatedPayloadScope, b: DelegatedPayloadScope): boolean {
  return a.chain === b.chain && a.chainId === b.chainId && a.deploymentId === b.deploymentId &&
    a.ownerAddress === b.ownerAddress && a.delegateAddress === b.delegateAddress && a.nonce === b.nonce &&
    a.signatureDeadline === b.signatureDeadline && a.permissionDeadline === b.permissionDeadline && equalDomain(a.signatureDomain, b.signatureDomain);
}
function grantFingerprint(g: DelegationGrant): string {
  return JSON.stringify([g.id, g.userId, g.chain, g.grantKind, g.accountAddress, g.status,
    g.lifecycleRevision, g.revocationTombstone?.toISOString(), g.revokedAt?.toISOString(), g.expiresAt?.toISOString()]);
}
function deploymentFingerprint(d: VerifiedDeployedDelegation): string {
  return JSON.stringify([d.grantId, d.userId, d.chain, d.chainId, d.deploymentId, d.mechanism,
    d.settlementAddress, d.signingAddress, d.revision, d.nonce, d.signatureDomain, d.expiresAt.toISOString(), d.revoked,
    [...d.capabilities].sort(), d.rules]);
}
function refused(verdict: ExecutionAuthorityVerdict): AuthoritySigningResult {
  return verdict.kind === 'denied' ? { kind: 'refused', code: verdict.code, reason: verdict.reason }
    : { kind: 'refused', code: 'authority-deployed-scope-unavailable', reason: 'Invalid deployment verdict' };
}
/** Inert unless explicitly injected. It never creates RPC clients, wallets or keys. */
export function createDeployedDelegationAuthority(input: DeployedDelegationPolicy & {
  readonly id: string;
  readonly chain: 'solana' | 'robinhood-chain';
  readonly deploymentId: string;
  readonly chainId: string;
  readonly maxVerificationAgeMs: number;
  readonly now: () => Date;
  readonly ports: DeployedDelegationPorts;
}): UserExecutionAuthority {
  const policy: DeployedDelegationPolicy = { approvedVenueSpenders: [...input.approvedVenueSpenders],
    maxSpendBaseUnits: input.maxSpendBaseUnits, maxPermissionLifetimeMs: input.maxPermissionLifetimeMs,
    maxSignatureLifetimeMs: input.maxSignatureLifetimeMs };
  function validRule(rule: DeployedDelegationRule, d: VerifiedDeployedDelegation): boolean {
    if (!rule || rule.recipient !== d.settlementAddress || !policy.approvedVenueSpenders.includes(rule.spender) ||
      !integer(rule.maxSpendBaseUnits, input.chain === 'solana' ? 64 : 256) || BigInt(rule.maxSpendBaseUnits) > BigInt(policy.maxSpendBaseUnits)) return false;
    const p = rule.permission;
    return validEffect({ ...rule, spendAmountBaseUnits: rule.maxSpendBaseUnits,
      permission: p ? { kind: p.kind, allowanceBaseUnits: p.maxAllowanceBaseUnits } : null }, input.chain) &&
      (p === null || lifetime(p.maxLifetimeMs) && p.maxLifetimeMs <= policy.maxPermissionLifetimeMs);
  }
  function inScope(effect: DelegatedExecutionEffect, d: VerifiedDeployedDelegation): DeployedDelegationRule | undefined {
    if (effect.recipient !== d.settlementAddress || !policy.approvedVenueSpenders.includes(effect.spender)) return undefined;
    return d.rules.find(rule => rule.action === effect.action && rule.direction === effect.direction &&
      rule.instrument === effect.instrument && rule.target === effect.target && rule.selector === effect.selector &&
      rule.recipient === effect.recipient && rule.spender === effect.spender && rule.spendAsset === effect.spendAsset &&
      BigInt(effect.spendAmountBaseUnits) <= BigInt(rule.maxSpendBaseUnits) &&
      (effect.permission === null ? rule.permission === null : rule.permission !== null &&
        effect.permission.kind === rule.permission.kind && BigInt(effect.permission.allowanceBaseUnits) <= BigInt(rule.permission.maxAllowanceBaseUnits)));
  }
  function authorityDeadline(grant: DelegationGrant, d: VerifiedDeployedDelegation): number {
    return Math.min(d.expiresAt.getTime(), d.validUntil.getTime(), d.verifiedAt.getTime() + input.maxVerificationAgeMs,
      grant.expiresAt?.getTime() ?? Infinity);
  }
  function validScope(scope: DelegatedPayloadScope, effect: DelegatedExecutionEffect, grant: DelegationGrant,
    d: VerifiedDeployedDelegation, now: number): boolean {
    if (!Number.isFinite(now) || !scope || scope.chain !== input.chain || scope.chainId !== input.chainId || scope.deploymentId !== input.deploymentId ||
      scope.ownerAddress !== grant.accountAddress || scope.delegateAddress !== d.signingAddress ||
      !integer(scope.nonce, 256, false) || scope.nonce !== d.nonce || !validDomain(scope.signatureDomain, input.chain) ||
      !equalDomain(scope.signatureDomain, d.signatureDomain)) return false;
    const signature = deadline(scope.signatureDeadline), permission = deadline(scope.permissionDeadline), rule = inScope(effect, d);
    const bound = authorityDeadline(grant, d);
    if (!rule || !(signature > now) || signature > bound || signature - now > policy.maxSignatureLifetimeMs) return false;
    return effect.permission === null ? scope.permissionDeadline === null : !!rule.permission && permission > now &&
      permission <= bound && permission - now <= Math.min(policy.maxPermissionLifetimeMs, rule.permission.maxLifetimeMs);
  }
  function payloadDomainMatches(payload: AuthoritySigningRequest, scope: DelegatedPayloadScope): boolean {
    if (payload.kind !== 'eip712-typed-data') return input.chain === 'solana' && payload.kind === 'solana-transaction';
    const d = payload.typedData.domain, expected = scope.signatureDomain;
    return expected.kind === 'eip712' && String(d.chainId) === scope.chainId && Number.isSafeInteger(d.chainId) &&
      d.name === expected.name && d.version === expected.version && d.verifyingContract === expected.verifyingContract &&
      (d.salt ?? null) === expected.salt && Object.keys(d).every(k => ['name', 'version', 'chainId', 'verifyingContract', 'salt'].includes(k));
  }
  async function check(request: ExecutionAuthorityRequest): Promise<
    { grant: DelegationGrant; deployment: VerifiedDeployedDelegation } | ExecutionAuthorityVerdict> {
    if (request.principal.kind !== 'user') return denied('authority-principal-mismatch', 'Deployed delegation requires a user principal');
    if (request.chain !== input.chain) return denied('authority-chain-mismatch', 'Deployed delegation chain mismatch');
    if (!id(request.principal.userId) || !id(input.deploymentId) || !id(input.chainId) || !lifetime(input.maxVerificationAgeMs) ||
      !lifetime(policy.maxSignatureLifetimeMs) || !lifetime(policy.maxPermissionLifetimeMs) || !integer(policy.maxSpendBaseUnits, 160) ||
      !policy.approvedVenueSpenders.length || policy.approvedVenueSpenders.length > 128 ||
      !policy.approvedVenueSpenders.every(a => address(input.chain, a)) || (input.chain === 'robinhood-chain' && input.chainId !== '4663')) {
      return denied('authority-deployed-scope-mismatch', 'Invalid verifier domain or finite loss policy');
    }
    // Clone immediately: a verifier cannot mutate a prior snapshot across an await.
    const loaded = await input.ports.loadGrant(request.principal.userId, input.chain);
    if (!loaded) return denied('authority-grant-missing', 'No authenticated current grant');
    const grant = structuredClone(loaded);
    let now = input.now().getTime();
    if (grant.userId !== request.principal.userId || grant.chain !== input.chain || !id(grant.id) || !address(input.chain, grant.accountAddress) ||
      !(input.chain === 'solana' ? grant.grantKind === 'solana_vault' : ['eip7702', 'session_key_4337'].includes(grant.grantKind)) ||
      typeof grant.lifecycleRevision !== 'string' || !/^[1-9][0-9]{0,18}$/.test(grant.lifecycleRevision) || BigInt(grant.lifecycleRevision) > 9223372036854775807n ||
      (grant.revocationTombstone !== null && (!date(grant.revocationTombstone) || grant.revocationTombstone.getTime() > now)) ||
      (grant.revokedAt !== null && (!date(grant.revokedAt) || grant.revocationTombstone === null ||
        grant.revocationTombstone.getTime() < grant.revokedAt.getTime()))) {
      return denied('authority-deployed-scope-mismatch', 'Authenticated grant identity or lifecycle mismatch');
    }
    if (grant.status === 'revoked' || grant.status === 'compromised' || grant.revokedAt !== null) return denied('authority-grant-revoked', 'Authenticated grant is revoked');
    if (!Number.isFinite(now) || grant.status !== 'active' || (grant.expiresAt !== null && (!date(grant.expiresAt) || !(grant.expiresAt.getTime() > now))) ||
      (input.chain !== 'solana' && grant.expiresAt === null)) return denied('authority-grant-expired', 'Authenticated grant is lapsed');
    const inspected = await input.ports.inspect(structuredClone(grant));
    now = input.now().getTime();
    if (!Number.isFinite(now) || (grant.expiresAt !== null && !(grant.expiresAt.getTime() > now))) return denied('authority-grant-expired', 'Authenticated grant expired during verification');
    if (!inspected) return denied('authority-deployed-scope-unavailable', 'Verified deployed delegation is unavailable');
    const d = structuredClone(inspected);
    if (d.grantId !== grant.id || d.userId !== grant.userId || d.chain !== input.chain || d.chainId !== input.chainId || d.deploymentId !== input.deploymentId ||
      d.mechanism !== grant.grantKind || d.settlementAddress !== grant.accountAddress || !address(input.chain, d.signingAddress) || !id(d.revision) ||
      !integer(d.nonce, 256, false) || !validDomain(d.signatureDomain, input.chain) || d.finality !== 'finalized' ||
      !Array.isArray(d.rules) || d.rules.length === 0 || d.rules.length > 128 || !Array.isArray(d.capabilities) || d.capabilities.length === 0 ||
      d.capabilities.some(c => c !== 'sign-chain-transaction' && c !== 'sign-typed-data') ||
      (input.chain === 'solana' && d.capabilities.includes('sign-typed-data')) || (input.chain === 'robinhood-chain' && d.capabilities.includes('sign-chain-transaction'))) {
      return denied('authority-deployed-scope-mismatch', 'Deployed delegation identity or capability mismatch');
    }
    if (d.revoked || !date(d.verifiedAt) || !date(d.validUntil) || !date(d.expiresAt) || d.verifiedAt.getTime() > now ||
      !(authorityDeadline(grant, d) > now)) return denied('authority-deployed-scope-stale', 'Deployed delegation proof is stale or revoked');
    if (!d.rules.every(rule => validRule(rule, d))) return denied('authority-effect-out-of-scope', 'Unsafe deployed allowance, spender, recipient or lifetime');
    if (!request.effect || !validEffect(request.effect, input.chain) || request.effect.action !== request.action ||
      request.effect.direction !== (request.direction ?? null) || request.effect.instrument !== request.instrument) return denied('authority-effect-intent-missing', 'Exact delegated effect intent is required');
    if (!inScope(request.effect, d)) return denied('authority-effect-out-of-scope', 'Effect is outside actual deployed argument scope');
    if (!request.payloadScope || !validScope(request.payloadScope, request.effect, grant, d, now)) return denied('authority-payload-mismatch', 'Complete authenticated payload scope with finite lifetimes is required');
    return { grant, deployment: d };
  }
  return {
    id: input.id, chain: input.chain, serves: principal => principal.kind === 'user',
    async authorize(request) {
      let pinnedRequest: ExecutionAuthorityRequest;
      let checked: Awaited<ReturnType<typeof check>>;
      try { pinnedRequest = structuredClone(request); checked = await check(pinnedRequest); }
      catch { return denied('authority-deployed-scope-unavailable', 'Deployed delegation verifier failed'); }
      if ('kind' in checked) return checked;
      const { grant, deployment } = checked;
      const pinnedGrant = grantFingerprint(grant), pinnedDeployment = deploymentFingerprint(deployment);
      const issuedDeadline = Math.min(authorityDeadline(grant, deployment), deadline(pinnedRequest.payloadScope!.signatureDeadline),
        pinnedRequest.payloadScope!.permissionDeadline === null ? Infinity : deadline(pinnedRequest.payloadScope!.permissionDeadline));
      const live = () => { const now = input.now().getTime(); return Number.isFinite(now) && now < issuedDeadline; };
      let signConsumed = false;
      return { kind: 'granted', authority: {
        adapterId: input.id, chain: input.chain, principal: structuredClone(pinnedRequest.principal),
        settlementAddress: deployment.settlementAddress, signingAddress: deployment.signingAddress,
        capabilities: Object.freeze([...deployment.capabilities]), expiresAt: new Date(issuedDeadline),
        deployedDelegation: { grantId: grant.id, deploymentId: deployment.deploymentId, chainId: deployment.chainId,
          revision: deployment.revision, verifiedAt: new Date(deployment.verifiedAt) },
        async sign(signingRequest) {
          if (signConsumed || !live()) return refused(denied('authority-deployed-scope-stale', 'Delegated authorization is expired or consumed'));
          signConsumed = true;
          try {
            const payload = structuredClone(signingRequest);
            if (!deployment.capabilities.includes(capabilityForSigningRequest(payload) as Exclude<AuthorityCapability, 'venue-managed-submission'>)) {
              return refused(denied('authority-capability-unsupported', 'Signing shape is outside deployed capability'));
            }
            const current = await check(pinnedRequest);
            if ('kind' in current) return refused(current);
            if (!live() || grantFingerprint(current.grant) !== pinnedGrant || deploymentFingerprint(current.deployment) !== pinnedDeployment) {
              return refused(denied('authority-deployed-scope-stale', 'Delegation changed or issued deadline elapsed'));
            }
            const decoded = structuredClone(await input.ports.decode(payload, structuredClone(current.deployment)));
            if (!live()) return refused(denied('authority-deployed-scope-stale', 'Issued deadline elapsed while decoding'));
            if (!Array.isArray(decoded) || decoded.length !== 1 || !validEffect(decoded[0]!.effect, input.chain) ||
              !equalEffect(decoded[0]!.effect, pinnedRequest.effect!) || !inScope(decoded[0]!.effect, current.deployment) ||
              !validScope(decoded[0]!.scope, decoded[0]!.effect, current.grant, current.deployment, input.now().getTime()) ||
              !equalScope(decoded[0]!.scope, pinnedRequest.payloadScope!) || !payloadDomainMatches(payload, decoded[0]!.scope)) {
              return refused(denied('authority-payload-mismatch', 'Built payload does not match the exact effect and complete signed scope'));
            }
            const afterDecode = await check(pinnedRequest);
            if ('kind' in afterDecode) return refused(afterDecode);
            if (!live() || grantFingerprint(afterDecode.grant) !== pinnedGrant || deploymentFingerprint(afterDecode.deployment) !== pinnedDeployment) {
              return refused(denied('authority-deployed-scope-stale', 'Delegation changed or issued deadline elapsed while decoding'));
            }
            const result = await input.ports.signScoped({ grant: afterDecode.grant, deployment: afterDecode.deployment,
              expectedRevision: deployment.revision, expectedLifecycleRevision: grant.lifecycleRevision,
              expectedRevocationTombstone: grant.revocationTombstone ? new Date(grant.revocationTombstone) : null,
              issuedDeadline: new Date(issuedDeadline), effect: structuredClone(pinnedRequest.effect!),
              payloadScope: structuredClone(pinnedRequest.payloadScope!), request: payload });
            if (result.kind === 'refused') return { kind: 'refused', code: result.code, reason: 'Scoped executor refused the effect' };
            if (result.kind !== 'signed' || !result.value || result.encoding !== (payload.kind === 'eip712-typed-data' ? 'hex' : 'base64')) {
              return refused(denied('authority-signing-failed', 'Invalid scoped execution result'));
            }
            return result;
          } catch { return refused(denied('authority-signing-failed', 'Scoped execution failed')); }
        }
      } };
    }
  };
}
