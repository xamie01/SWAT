import { describe, expect, it, vi } from 'vitest';
import { createUserSolanaAuthority, createUserRobinhoodAuthority, createExecutionAuthorityAdapters } from './execution-authority-adapters.js';
import { createExecutionAuthorityRegistry, type AuthoritySigningRequest, type DelegatedExecutionEffect, type DelegatedPayloadScope, type ExecutionAuthorityRequest } from './execution-authority.js';
import { createDeployedDelegationAuthority, type DecodedDelegatedPayload, type DelegationGrant, type DeployedDelegationRule, type VerifiedDeployedDelegation } from './delegation-authority.js';
const evm = '0x' + '1'.repeat(40), delegate = '0x' + '2'.repeat(40), router = '0x' + '3'.repeat(40), asset = '0x' + '4'.repeat(40);
const start = new Date('2026-11-17T00:00:00Z');
function fixture(chain: 'solana' | 'robinhood-chain' = 'robinhood-chain', permissionKind?: 'erc20-allowance' | 'permit2') {
  let now = new Date(start);
  const account = chain === 'solana' ? 'So11111111111111111111111111111111111111112' : evm;
  const signer = chain === 'solana' ? '11111111111111111111111111111111' : delegate;
  const spender = chain === 'solana' ? signer : router;
  const effect: DelegatedExecutionEffect = { action: permissionKind ? 'token-spend-permission' : 'venue-trade',
    direction: permissionKind ? null : 'buy', instrument: 'fixture-token', target: spender, selector: permissionKind ? 'permit' : 'swapExact',
    recipient: account, spendAsset: chain === 'solana' ? account : asset, spendAmountBaseUnits: '10', spender,
    permission: permissionKind ? { kind: permissionKind, allowanceBaseUnits: '10' } : null };
  let grant: DelegationGrant = { id: 'fixture-grant', userId: 'fixture-user', chain, grantKind: chain === 'solana' ? 'solana_vault' : 'session_key_4337',
    accountAddress: account, status: 'active', lifecycleRevision: '1', revocationTombstone: null, revokedAt: null,
    expiresAt: new Date('2030-01-01'), scopePolicy: { allowEverything: true } };
  const rule: DeployedDelegationRule = { ...effect, maxSpendBaseUnits: '20',
    permission: permissionKind ? { kind: permissionKind, maxAllowanceBaseUnits: '20', maxLifetimeMs: 20000 } : null };
  const signatureDomain: DelegatedPayloadScope['signatureDomain'] = { kind: chain === 'solana' ? 'solana-message' : 'eip712',
    name: 'FixtureDelegation', version: '1', verifyingContract: spender, salt: null };
  let deployed: VerifiedDeployedDelegation = { grantId: grant.id, userId: grant.userId, chain,
    chainId: chain === 'solana' ? 'fixture-genesis' : '4663', deploymentId: 'fixture-deployment', mechanism: grant.grantKind,
    settlementAddress: account, signingAddress: signer, revision: 'fixture-revision-1', nonce: '0', signatureDomain,
    finality: 'finalized', verifiedAt: now, validUntil: new Date('2026-11-17T00:01:00Z'), expiresAt: new Date('2030-01-01'), revoked: false,
    capabilities: chain === 'solana' ? ['sign-chain-transaction'] : ['sign-typed-data'], rules: [rule] };
  const scope: DelegatedPayloadScope = { chain, chainId: deployed.chainId, deploymentId: deployed.deploymentId,
    ownerAddress: account, delegateAddress: signer, nonce: '0', signatureDomain,
    signatureDeadline: '2026-11-17T00:00:20.000Z', permissionDeadline: permissionKind ? '2026-11-17T00:00:15.000Z' : null };
  const request: ExecutionAuthorityRequest = { chain, principal: { kind: 'user', userId: grant.userId }, action: effect.action,
    ...(effect.direction ? { direction: effect.direction } : {}), instrument: effect.instrument, effect, payloadScope: scope };
  // Keyless synthetic codec only. These JSON payloads are NOT chain transactions,
  // authenticated deployed evidence, real EIP712 encodings or cryptographic signatures.
  const buildPayload = (decoded: readonly DecodedDelegatedPayload[] = [{ effect, scope }]): AuthoritySigningRequest => chain === 'solana'
    ? { kind: 'solana-transaction', transactionBase64: Buffer.from(JSON.stringify(decoded)).toString('base64') }
    : { kind: 'eip712-typed-data', typedData: { domain: { name: signatureDomain.name, version: signatureDomain.version,
      chainId: 4663, verifyingContract: signatureDomain.verifyingContract },
      types: { Fixture: [{ name: 'actions', type: 'string' }] }, primaryType: 'Fixture', message: { actions: JSON.stringify(decoded) } } };
  const loadGrant = vi.fn(async () => structuredClone(grant));
  const inspect = vi.fn(async () => structuredClone(deployed));
  const decode = vi.fn(async (payload: AuthoritySigningRequest): Promise<readonly DecodedDelegatedPayload[]> => {
    if (payload.kind === 'solana-tip-transfer') return [];
    return JSON.parse(payload.kind === 'solana-transaction' ? Buffer.from(payload.transactionBase64, 'base64').toString() : String(payload.typedData.message.actions));
  });
  const signScoped = vi.fn(async ({ request: payload }: { request: AuthoritySigningRequest }) => ({ kind: 'signed' as const,
    encoding: payload.kind === 'eip712-typed-data' ? 'hex' as const : 'base64' as const, value: 'inert-signed-result' }));
  const options = { deploymentId: deployed.deploymentId, chainId: deployed.chainId, maxVerificationAgeMs: 30000, now: () => now,
    approvedVenueSpenders: [spender], maxSpendBaseUnits: '100', maxPermissionLifetimeMs: 25000, maxSignatureLifetimeMs: 25000,
    ports: { loadGrant, inspect, decode, signScoped } };
  const adapter = createDeployedDelegationAuthority({ ...options, id: 'fixture-adapter', chain });
  return { adapter, options, request, payload: buildPayload(), buildPayload, rule, scope, effect, loadGrant, inspect, decode, signScoped,
    changeGrant: (change: Partial<DelegationGrant>) => { grant = { ...grant, ...change }; },
    changeDeployed: (change: Partial<VerifiedDeployedDelegation>) => { deployed = { ...deployed, ...change }; },
    setNow: (value: Date) => { now = value; } };
}
async function authorized(f: ReturnType<typeof fixture>) {
  const v = await f.adapter.authorize(f.request);
  expect(v.kind).toBe('granted'); if (v.kind !== 'granted') throw new Error('fixture denied');
  return v.authority;
}
describe('actual injected deployed scope, not caller labels', () => {
  it.each(['solana','robinhood-chain'] as const)('drives finite scoped payload execution on %s', async chain => {
    const f = fixture(chain), authority = await authorized(f);
    expect(authority.deployedDelegation).toMatchObject({ deploymentId: 'fixture-deployment', revision: 'fixture-revision-1' });
    expect(authority.capabilities).not.toContain('venue-managed-submission');
    expect(await authority.sign(f.payload)).toMatchObject({ kind: 'signed', value: 'inert-signed-result' });
    expect(f.loadGrant).toHaveBeenCalledTimes(3); expect(f.inspect).toHaveBeenCalledTimes(3);
    expect(f.signScoped).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 'fixture-revision-1',
      expectedLifecycleRevision: '1', expectedRevocationTombstone: null, issuedDeadline: new Date(f.scope.signatureDeadline),
      effect: f.effect, payloadScope: f.scope }));
  });
  it.each(['erc20-allowance','permit2'] as const)('accepts finite %s only with finite permission lifetime', async kind => {
    const f = fixture('robinhood-chain', kind), authority = await authorized(f);
    expect(authority.expiresAt).toEqual(new Date(f.scope.permissionDeadline!));
    expect(await authority.sign(f.payload)).toMatchObject({ kind: 'signed' });
  });
  it('legacy signer/enabled/programId never establishes authority or reads legacy accessors', async () => {
    let accessed = false;
    const legacy = { get signer() { accessed = true; throw new Error('legacy'); }, get enabled() { accessed = true; return true; } };
    expect(await createUserSolanaAuthority(legacy as any).authorize(fixture('solana').request)).toMatchObject({ kind: 'denied', code: 'authority-solana-delegate-unavailable' });
    expect(accessed).toBe(false);
  });
  it('explicit verified factories are reachable through the registry, no operator fallback', async () => {
    const f = fixture('solana'), unused = vi.fn(() => null);
    const resolver = createExecutionAuthorityRegistry(createExecutionAuthorityAdapters({ solana: { trojanWalletAddress: unused, signer: unused },
      robinhoodChain: { accountAddress: unused, typedDataSigner: unused }, polygon: { identity: unused, typedDataSigner: unused } }, undefined, { solana: f.options }));
    expect(await resolver(f.request)).toMatchObject({ kind: 'granted' }); expect(unused).not.toHaveBeenCalled();
    const e = fixture(); expect(await createUserRobinhoodAuthority(undefined, e.options).authorize(e.request)).toMatchObject({ kind: 'granted' });
  });
  it.each([
    ['tenant', { userId: 'other-user' }], ['grant', { grantId: 'other-grant' }], ['account', { settlementAddress: delegate }],
    ['network', { chainId: '137' }], ['deployment', { deploymentId: 'other-deployment' }],
    ['mechanism', { mechanism: 'eip7702' }], ['finality', { finality: 'confirmed' }]
  ])('denies substituted deployed %s', async (_field, change) => {
    const f = fixture(); f.changeDeployed(change as any);
    expect(await f.adapter.authorize(f.request)).toMatchObject({ kind: 'denied', code: 'authority-deployed-scope-mismatch' });
    expect(f.signScoped).not.toHaveBeenCalled();
  });
  it.each([
    ['revoked', { revoked: true }], ['future-proof', { verifiedAt: new Date('2027-01-01') }],
    ['stale-proof', { verifiedAt: new Date('2026-11-16') }], ['expired-proof', { validUntil: new Date('2026-11-16') }],
    ['expired-delegation', { expiresAt: new Date('2026-11-16') }]
  ])('denies %s deployed evidence', async (_field, change) => {
    const f = fixture(); f.changeDeployed(change);
    expect(await f.adapter.authorize(f.request)).toMatchObject({ kind: 'denied', code: 'authority-deployed-scope-stale' });
  });
  it.each(['instrument','target','selector','recipient','spendAsset','spender'])('caller policy cannot widen deployed %s', async field => {
    const f = fixture(), changed = { ...f.effect, [field]: ['instrument','selector'].includes(field) ? 'attacker' : delegate };
    expect(await f.adapter.authorize({ ...f.request, instrument: changed.instrument, effect: changed })).toMatchObject({ kind: 'denied', code: 'authority-effect-out-of-scope' });
    expect(f.signScoped).not.toHaveBeenCalled();
  });
  it.each(['recipient','spender','amount','permission-lifetime'])('denies unsafe deployed %s even when request matches', async field => {
    const f = fixture('robinhood-chain', 'permit2');
    const rule = { ...f.rule, ...(field === 'amount' ? { maxSpendBaseUnits: '101', permission: { ...f.rule.permission!, maxAllowanceBaseUnits: '101' } }
      : field === 'permission-lifetime' ? { permission: { ...f.rule.permission!, maxLifetimeMs: 25001 } } : { [field]: delegate }) };
    f.changeDeployed({ rules: [rule] });
    expect(await f.adapter.authorize({ ...f.request, effect: { ...f.effect, ...(field === 'recipient' || field === 'spender' ? { [field]: delegate } : {}) } }))
      .toMatchObject({ kind: 'denied', code: 'authority-effect-out-of-scope' });
    expect(f.signScoped).not.toHaveBeenCalled();
  });
  it.each(['erc20-allowance','permit2'] as const)('denies unlimited/overflow %s deployed and requested allowances', async kind => {
    const bits = kind === 'permit2' ? 160n : 256n;
    for (const amount of [(2n ** bits - 1n).toString(), (2n ** bits).toString()]) {
      const f = fixture('robinhood-chain', kind);
      f.changeDeployed({ rules: [{ ...f.rule, maxSpendBaseUnits: amount, permission: { ...f.rule.permission!, maxAllowanceBaseUnits: amount } }] });
      expect(await f.adapter.authorize({ ...f.request, effect: { ...f.effect, spendAmountBaseUnits: amount,
        permission: { kind, allowanceBaseUnits: amount } } })).toMatchObject({ kind: 'denied', code: 'authority-effect-out-of-scope' });
      expect(f.signScoped).not.toHaveBeenCalled();
    }
  });
  it('exact base units reject floats, malformed quantities and over-budget requests', async () => {
    for (const spendAmountBaseUnits of ['0','01','1.5','1e3','-1','21','999999999999999999999999999999']) {
      const f = fixture(); expect(await f.adapter.authorize({ ...f.request, effect: { ...f.effect, spendAmountBaseUnits } })).toMatchObject({ kind: 'denied' });
    }
  });
  it('opaque labels or incomplete payload scope deny before signing', async () => {
    const f = fixture(); expect(await f.adapter.authorize({ ...f.request, effect: undefined })).toMatchObject({ kind: 'denied', code: 'authority-effect-intent-missing' });
    expect(await f.adapter.authorize({ ...f.request, payloadScope: undefined })).toMatchObject({ kind: 'denied', code: 'authority-payload-mismatch' });
  });
  it.each(['chain','chainId','deploymentId','ownerAddress','delegateAddress','nonce','signatureDomain','signatureDeadline','permissionDeadline'])
    ('rejects decoded %s substitution even with unchanged effect', async field => {
      const f = fixture('robinhood-chain', 'permit2'), authority = await authorized(f);
      const changed = { ...f.scope, [field]: field === 'signatureDomain' ? { ...f.scope.signatureDomain, salt: '0x' + '0'.repeat(64) }
        : field.endsWith('Deadline') ? '2026-11-17T00:00:10.000Z' : field.endsWith('Address') ? router : field === 'nonce' ? '1' : 'other' };
      expect(await authority.sign(f.buildPayload([{ effect: f.effect, scope: changed as DelegatedPayloadScope }])))
        .toMatchObject({ kind: 'refused', code: 'authority-payload-mismatch' });
      expect(f.signScoped).not.toHaveBeenCalled();
    });
  it.each(['name','version','chainId','verifyingContract','salt','extra'])('rejects actual typed domain %s substitution independently of decoder', async field => {
    const f = fixture(), authority = await authorized(f);
    if (f.payload.kind !== 'eip712-typed-data') throw new Error('fixture payload');
    const payload = { ...f.payload, typedData: { ...f.payload.typedData, domain: { ...f.payload.typedData.domain, [field]: field === 'chainId' ? 137 : 'other' } } };
    expect(await authority.sign(payload)).toMatchObject({ kind: 'refused', code: 'authority-payload-mismatch' });
    expect(f.signScoped).not.toHaveBeenCalled();
  });
  it.each(['signatureDeadline','permissionDeadline'] as const)('rejects missing, nonfinite, elapsed or over-authority %s', async field => {
    for (const value of [null, 'never', '2026-11-17T00:00:00.000Z', '2026-11-17T00:00:26.000Z', '2031-01-01T00:00:00.000Z']) {
      const f = fixture('robinhood-chain', 'permit2');
      expect(await f.adapter.authorize({ ...f.request, payloadScope: { ...f.scope, [field]: value } as DelegatedPayloadScope }))
        .toMatchObject({ kind: 'denied', code: 'authority-payload-mismatch' });
    }
  });
  it.each(['status','revision','scope','expiry','nonce','lifecycleRevision','revocationTombstone'])('rechecks %s before execution', async field => {
    const f = fixture(), authority = await authorized(f);
    if (field === 'status') f.changeGrant({ status: 'revoked' });
    if (field === 'revision') f.changeDeployed({ revision: 'fixture-revision-2' });
    if (field === 'scope') f.changeDeployed({ rules: [{ ...f.rule, maxSpendBaseUnits: '5' }] });
    if (field === 'expiry') f.setNow(new Date('2031-01-01'));
    if (field === 'nonce') f.changeDeployed({ nonce: '1' });
    if (field === 'lifecycleRevision') f.changeGrant({ lifecycleRevision: '4' });
    if (field === 'revocationTombstone') f.changeGrant({ revocationTombstone: start });
    expect(await authority.sign(f.payload)).toMatchObject({ kind: 'refused' }); expect(f.signScoped).not.toHaveBeenCalled();
  });
  it('revoke/retire/reactivate ABA leaves an old session stale despite restored values', async () => {
    const f = fixture(), authority = await authorized(f);
    f.changeGrant({ status: 'revoked', lifecycleRevision: '2', revokedAt: start, revocationTombstone: start });
    f.changeGrant({ status: 'retired', lifecycleRevision: '3' });
    f.changeGrant({ status: 'active', lifecycleRevision: '4', revokedAt: null });
    expect(await authority.sign(f.payload)).toMatchObject({ kind: 'refused', code: 'authority-deployed-scope-stale' });
    expect(f.signScoped).not.toHaveBeenCalled();
  });
  it.each(['0','01','-1','1.5','9223372036854775808', 1])('rejects noncanonical lifecycle revision %s', async lifecycleRevision => {
    const f = fixture(); f.changeGrant({ lifecycleRevision: lifecycleRevision as string });
    expect(await f.adapter.authorize(f.request)).toMatchObject({ kind: 'denied', code: 'authority-deployed-scope-mismatch' });
  });
  it.each(['target','recipient','amount','batch'])('decodes and rejects effect %s substitution', async field => {
    const f = fixture(), authority = await authorized(f);
    const decoded = field === 'batch' ? [{ effect: f.effect, scope: f.scope }, { effect: f.effect, scope: f.scope }]
      : [{ effect: { ...f.effect, ...(field === 'amount' ? { spendAmountBaseUnits: '11' } : { [field]: delegate }) }, scope: f.scope }];
    expect(await authority.sign(f.buildPayload(decoded))).toMatchObject({ kind: 'refused', code: 'authority-payload-mismatch' });
    expect(f.signScoped).not.toHaveBeenCalled();
  });
  it('renewed proof same revision cannot extend the initially advertised deadline', async () => {
    const f = fixture(); f.changeDeployed({ validUntil: new Date('2026-11-17T00:00:05Z') });
    const v = await f.adapter.authorize({ ...f.request, payloadScope: { ...f.scope, signatureDeadline: '2026-11-17T00:00:05.000Z' } });
    if (v.kind !== 'granted') throw new Error('fixture denied');
    const authority = v.authority; expect(authority.expiresAt).toEqual(new Date('2026-11-17T00:00:05Z'));
    f.setNow(new Date('2026-11-17T00:00:06Z'));
    f.changeDeployed({ verifiedAt: new Date('2026-11-17T00:00:06Z'), validUntil: new Date('2026-11-17T00:01:06Z') });
    expect(await authority.sign(f.payload)).toMatchObject({ kind: 'refused', code: 'authority-deployed-scope-stale' });
    expect(f.signScoped).not.toHaveBeenCalled();
    expect(await f.adapter.authorize(f.request)).toMatchObject({ kind: 'granted' }); // new authorization is required
  });
  it('proof renewal during decoder latency cannot revive an issued deadline', async () => {
    const f = fixture(); f.changeDeployed({ validUntil: new Date('2026-11-17T00:00:05Z') });
    const issuedScope = { ...f.scope, signatureDeadline: '2026-11-17T00:00:05.000Z' };
    const v = await f.adapter.authorize({ ...f.request, payloadScope: issuedScope });
    if (v.kind !== 'granted') throw new Error('fixture denied');
    const authority = v.authority;
    f.decode.mockImplementation(async () => { f.setNow(new Date('2026-11-17T00:00:06Z'));
      f.changeDeployed({ verifiedAt: new Date('2026-11-17T00:00:06Z'), validUntil: new Date('2026-11-17T00:01:06Z') });
      return [{ effect: f.effect, scope: issuedScope }]; });
    expect(await authority.sign(f.payload)).toMatchObject({ kind: 'refused', code: 'authority-deployed-scope-stale' });
    expect(f.signScoped).not.toHaveBeenCalled();
  });
  it('single-use authorization cannot repeat after success or uncertainty', async () => {
    for (const uncertain of [false, true]) {
      const f = fixture(), authority = await authorized(f);
      if (uncertain) f.signScoped.mockRejectedValue(new Error('uncertain'));
      expect((await authority.sign(f.payload)).kind).toBe(uncertain ? 'refused' : 'signed');
      expect(await authority.sign(f.payload)).toMatchObject({ kind: 'refused', code: 'authority-deployed-scope-stale' });
      expect(f.signScoped).toHaveBeenCalledTimes(1);
    }
  });
  it('snapshots caller scope/effect and sends pinned lifecycle/deadline to boundary', async () => {
    const f = fixture(), authority = await authorized(f);
    (f.request.effect as any).recipient = delegate; (f.request.payloadScope as any).nonce = '999';
    expect(await authority.sign(f.payload)).toMatchObject({ kind: 'signed' });
    expect(f.signScoped.mock.calls[0]![0]).toMatchObject({ expectedLifecycleRevision: '1',
      issuedDeadline: new Date('2026-11-17T00:00:20Z'), effect: { recipient: evm }, payloadScope: { nonce: '0' } });
  });
  it('verifier and service exceptions are sanitized, never promoted to grants/fallback', async () => {
    const f = fixture(); f.inspect.mockRejectedValue(new Error('secret-provider-error'));
    expect(await f.adapter.authorize(f.request)).toEqual({ kind: 'denied', code: 'authority-deployed-scope-unavailable', reason: 'Deployed delegation verifier failed' });
    const g = fixture(), authority = await authorized(g); g.signScoped.mockRejectedValue(new Error('secret-provider-error'));
    expect(await authority.sign(g.payload)).toEqual({ kind: 'refused', code: 'authority-signing-failed', reason: 'Scoped execution failed' });
  });
});
