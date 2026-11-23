import { describe, expect, it, vi } from 'vitest';
import { createOwnedCustodyComposition, type CustodyCapability, type CustodyCapabilityAdmission, type CustodyOwnedCompositionPorts,
  type CustodyCheckedTransaction } from './custody-owned-composition.js';
import { recordAuditEventStrictWithClient } from '@swat/db/dist/audit-log-owned.js';
import { createCustodyScenarioFactory } from './custody-scenarios.js';
import { buildCustodySecretBinding, type CustodyGrantSnapshot } from '@swat/db/dist/custody-contract.js';
import { prepareCustodySecretAdmission } from '@swat/db/dist/custody-owned-store.js';
import type { CustodyEnrollmentRecord } from '@swat/db/dist/custody-enrollment.js';
import type { UserScope } from '@swat/db/dist/tenancy.js';
import type { AuthoritySigningRequest, AuthoritySigningResult, ExecutionAuthorityRequest } from '../../../apps/trade-executor/src/execution-authority.js';
import type { VerifiedDeployedDelegation } from '../../../apps/trade-executor/src/delegation-authority.js';
import type { CustodyJournal } from './custody-journal.js';
const USER = '11111111-1111-4111-8111-111111111111', GRANT = '22222222-2222-4222-8222-222222222222';
const RUN = '33333333-3333-4333-8333-333333333333', ACCOUNT = `0x${'1'.repeat(40)}`, SIGNER = `0x${'2'.repeat(40)}`,
  SPENDER = `0x${'3'.repeat(40)}`, ASSET = `0x${'4'.repeat(40)}`;
const scope = { userId: USER } as UserScope;
const baseTime = new Date('2026-11-23T00:00:00.000Z');
function envelope(version: number) {
  return ['v2','inert-wrapper',String(version),Buffer.from('inert-authenticated-wrap').toString('base64'),
    Buffer.alloc(12, 1).toString('base64'),Buffer.alloc(16, 2).toString('base64'),Buffer.from('inert-no-key').toString('base64')].join('.');
}
/** Inert SQL response emulator only, not an alternate production business body.
 * Actual admission/store/enrollment/execution/delegation source is invoked. */
function fixture() {
  let now = new Date(baseTime), grant: Record<string, any> | null = null;
  let admissions: Record<string, any>[] = [], failIdentity = '', uncertain = '', denied: CustodyCapability | null = null,
    wideAdmission = false, wrongDigest = false, verifyAccepted = true, cancelled = false;
  let history: CustodyJournal['history'][number][] = [];
  const calls: { identity: string; sql: string; values: unknown[] }[] = [];
  const secret = Uint8Array.from([17,33,65,129]); let wrapped: Uint8Array | undefined, opened: Uint8Array | undefined;
  let onOpen = () => {}, onDecode = () => {}, onExecute = () => {}, executed = 0;
  const input = { chain: 'robinhood-chain' as const, grantKind: 'session_key_4337' as const, accountAddress: ACCOUNT,
    secret, scopePolicy: { max: '900719925474099312345' }, expiresAt: new Date(baseTime.getTime() + 600000) };
  const transaction = (identity: string): CustodyCheckedTransaction => async (s, action) => {
    const savedGrant = structuredClone(grant), savedAdmissions = structuredClone(admissions), savedHistory = structuredClone(history);
    const query = async (sql: string, values: unknown[] = []) => {
      calls.push({ identity, sql, values }); const reply = (rows: unknown[] = []) => ({ rows, rowCount: rows.length });
      if (sql.includes('session_user')) return reply([{ authenticated_role: identity, runtime_role: identity,
        tenant: s.userId, bypass: 'off' }]);
      if (sql.includes('INSERT INTO custody_secret_admissions')) {
        if (admissions.some(row => row.grant_id === values[0] && row.key_version === values[5])) return reply();
        const row = { id: `44444444-4444-4444-8444-${String(values[5]).padStart(12,'0')}`, grant_id: values[0], user_id: values[1],
          chain: values[2], grant_kind: values[3], account_address: values[4], key_version: values[5], sealed_secret: values[6],
          secret_binding: JSON.parse(values[7] as string), scope_policy: JSON.parse(values[8] as string), expires_at: values[9],
          wrapper_id: values[10], service_identity: values[11], authenticated_receipt: values[12], accepted_at: new Date(now) };
        admissions.push(row); return reply([row]);
      }
      if (sql.includes('FROM custody_secret_admissions')) return reply(admissions.filter(row => row.grant_id === values[0] &&
        row.user_id === values[1] && row.key_version === values[2]));
      if (sql.includes('INSERT INTO user_execution_grants')) {
        if (grant) return reply();
        grant = { id: values[0], user_id: values[1], chain: values[2], grant_kind: values[3], account_address: values[4],
          sealed_secret: values[5], has_sealed_secret: true, key_version: values[6], secret_binding: JSON.parse(values[7] as string),
          scope_policy: JSON.parse(values[8] as string), expires_at: values[9], revoked_at: null, status: 'active',
          created_at: new Date(now), lifecycle_revision: '1', revocation_tombstone: null };
        return reply([grant]);
      }
      if (sql.includes('UPDATE user_execution_grants')) {
        if (!grant || grant.id !== values[0] || grant.user_id !== values[1]) return reply();
        if (sql.includes('grant_kind=$3')) {
          if (grant.lifecycle_revision !== values[8]) return reply();
          Object.assign(grant, { grant_kind: values[2], sealed_secret: values[3], key_version: values[4],
            secret_binding: JSON.parse(values[5] as string), scope_policy: JSON.parse(values[6] as string), expires_at: values[7], status: 'retired' });
        } else if (sql.includes("status='active'")) {
          if (grant.lifecycle_revision !== values[2]) return reply(); grant.status = 'active'; grant.revoked_at = null;
        } else {
          if (grant.lifecycle_revision !== values[3]) return reply(); grant.status = values[2];
          if (grant.status === 'revoked' || grant.status === 'compromised') grant.revoked_at = grant.revocation_tombstone = new Date(now);
        }
        grant.lifecycle_revision = (BigInt(grant.lifecycle_revision) + 1n).toString(); return reply([{ id: GRANT }]);
      }
      if (sql.includes('INSERT INTO audit_log')) {
        history.push({ actorType: values[0] as string, actorId: values[1] as string, event: values[2] as string,
          targetType: values[3] as string, targetId: values[4] as string, metadata: JSON.parse(values[7] as string), createdAt: now.toISOString() });
        return reply();
      }
      if (sql.includes('FROM user_execution_grants')) return reply(grant && grant.id === values[0] && grant.user_id === values[1] ? [grant] : []);
      throw new Error('unexpected inert SQL');
    };
    try {
      const value = await action({ query } as any);
      if (failIdentity === identity) throw new Error('inert checked COMMIT refusal');
      if (uncertain === identity) return { value, outcome: 'uncertain' } as any;
      return { value, outcome: 'committed' };
    } catch (error) { grant = savedGrant; admissions = savedAdmissions; history = savedHistory; throw error; }
  };
  const effect = { action: 'venue-trade' as const, direction: 'buy' as const, instrument: 'inert-instrument', target: SPENDER,
    selector: 'inert-selector', recipient: ACCOUNT, spendAsset: ASSET, spendAmountBaseUnits: '100', spender: SPENDER, permission: null };
  const payloadScope = { chain: input.chain, chainId: '4663', deploymentId: 'inert-deployment', ownerAddress: ACCOUNT,
    delegateAddress: SIGNER, nonce: '1', signatureDeadline: new Date(baseTime.getTime() + 30000).toISOString(), permissionDeadline: null,
    signatureDomain: { kind: 'eip712' as const, name: 'inert-domain', version: '1', verifyingContract: SPENDER, salt: null } };
  const request: ExecutionAuthorityRequest = { chain: input.chain, principal: { kind: 'user', userId: USER },
    action: effect.action, direction: effect.direction, instrument: effect.instrument, effect, payloadScope };
  const payload: AuthoritySigningRequest = { kind: 'eip712-typed-data', typedData: { domain: { name: 'inert-domain', version: '1',
    chainId: 4663, verifyingContract: SPENDER }, types: {}, primaryType: 'Inert', message: {} } };
  const deployment: VerifiedDeployedDelegation = { grantId: GRANT, userId: USER, chain: input.chain, chainId: '4663',
    deploymentId: 'inert-deployment', mechanism: input.grantKind, settlementAddress: ACCOUNT, signingAddress: SIGNER,
    revision: 'inert-revision', nonce: '1', signatureDomain: payloadScope.signatureDomain, finality: 'finalized',
    verifiedAt: new Date(now), validUntil: new Date(baseTime.getTime() + 120000), expiresAt: input.expiresAt, revoked: false,
    capabilities: ['sign-typed-data'], rules: [{ ...effect, maxSpendBaseUnits: '100', permission: null }] };
  const ports: CustodyOwnedCompositionPorts = { deploymentId: 'inert-deployment', chainIds: { 'robinhood-chain': '4663' },
    now: () => new Date(now), check: () => { if (cancelled) throw new Error('inert cancellation'); }, allocateGrantId: async () => GRANT,
    admissions: { authorize: vi.fn(async (r: Parameters<CustodyCapabilityAdmission['authorize']>[0]): ReturnType<CustodyCapabilityAdmission['authorize']> => denied === r.capability ? null : { request: { ...r,
      ...(wrongDigest ? { payloadDigest: 'wrong' } : {}) }, approved: true, validUntil: new Date(now.getTime() + 1000),
      capabilities: wideAdmission ? ['wrap-only','execution-unwrap'] : r.identity === 'swat_app' ? ['grant-enrollment','grant-lifecycle'] :
        r.identity === 'inert-reader' ? ['execution-secret-read','scoped-execution'] : r.identity === 'inert-deployed-verifier'
          ? ['deployed-inspection','scoped-execution'] : [r.capability] }) },
    wrap: { wrapperId: 'inert-wrapper', keyVersion: 1, serviceIdentity: 'inert-wrap-service',
      seal: vi.fn(async ({ plaintext }: Parameters<CustodyOwnedCompositionPorts['wrap']['seal']>[0]) => { wrapped = plaintext; return envelope(1); }),
      attest: vi.fn(async () => ({ wrapperId: 'inert-wrapper', serviceIdentity: 'inert-wrap-service', authenticatedReceipt: 'inert-receipt' })) },
    unwrap: { serviceIdentity: 'inert-unwrap-service', open: vi.fn(async () => { onOpen(); opened = Uint8Array.from(secret); return opened; }) },
    admissionVerifier: { verify: vi.fn(async (i: Parameters<CustodyOwnedCompositionPorts['admissionVerifier']['verify']>[0]) => ({ accepted: verifyAccepted, payloadDigest: i.payloadDigest,
      serviceIdentity: i.authentication.serviceIdentity })) },
    database: { admission: { identity: 'swat_custody_writer', transaction: transaction('swat_custody_writer') },
      enrollment: { identity: 'swat_app', transaction: transaction('swat_app') },
      execution: { identity: 'inert-reader', transaction: transaction('inert-reader') },
      lifecycle: { identity: 'swat_app', transaction: transaction('swat_app') } },
    delegation: { identity: 'inert-deployed-verifier', maxVerificationAgeMs: 120000,
      policy: { approvedVenueSpenders: [SPENDER], maxSpendBaseUnits: '1000', maxPermissionLifetimeMs: 60000, maxSignatureLifetimeMs: 60000 },
      inspect: vi.fn(async () => structuredClone(deployment)), decode: vi.fn(async () => { onDecode(); return [{ effect, scope: payloadScope }]; }),
      executeScoped: vi.fn(async (_client: Parameters<CustodyOwnedCompositionPorts['delegation']['executeScoped']>[0],
        bytes: Uint8Array, issued: Parameters<CustodyOwnedCompositionPorts['delegation']['executeScoped']>[2]): Promise<AuthoritySigningResult> => { onExecute();
        if (!grant || grant.lifecycle_revision !== issued.expectedLifecycleRevision || now >= issued.issuedDeadline) {
          return { kind: 'refused', code: 'authority-deployed-scope-stale', reason: 'inert atomic boundary refusal' };
        }
        expect([...bytes]).toEqual([...secret]); executed++; return { kind: 'signed', encoding: 'hex', value: 'inert-not-a-signature' };
      }) } };
  const snapshot = (): CustodyGrantSnapshot | null => grant ? { id: grant.id, userId: grant.user_id, chain: grant.chain, grantKind: grant.grant_kind,
    accountAddress: grant.account_address, keyVersion: grant.key_version, sealedSecret: grant.sealed_secret, secretBinding: structuredClone(grant.secret_binding),
    scopePolicy: structuredClone(grant.scope_policy), expiresAt: new Date(grant.expires_at), status: grant.status, lifecycleRevision: grant.lifecycle_revision,
    revokedAt: grant.revoked_at ? new Date(grant.revoked_at) : null, revocationTombstone: grant.revocation_tombstone ? new Date(grant.revocation_tombstone) : null } : null;
  const journal = (): CustodyJournal => ({ scope: { runId: RUN, userId: USER, grantId: GRANT, chain: input.chain,
    observerIdentity: 'inert-observer', deploymentId: 'inert-deployment', chainId: '4663' }, observedAt: now.toISOString(), grant: snapshot(),
    admissions: admissions.map(row => ({ id: row.id, userId: row.user_id, record: { id: row.grant_id, chain: row.chain, grantKind: row.grant_kind,
      accountAddress: row.account_address, keyVersion: row.key_version, sealedSecret: row.sealed_secret, secretBinding: structuredClone(row.secret_binding),
      scopePolicy: structuredClone(row.scope_policy), expiresAt: new Date(row.expires_at) }, wrapperId: row.wrapper_id,
      serviceIdentity: row.service_identity, authenticatedReceipt: row.authenticated_receipt, acceptedAt: new Date(row.accepted_at) })), history: structuredClone(history) });
  return { ports, input, calls, request, payload, snapshot, journal, deployment,
    get grant() { return grant; }, get admissions() { return admissions; }, get wrapped() { return wrapped; }, get opened() { return opened; },
    get executed() { return executed; }, fail: (id: string) => { failIdentity = id; }, uncertain: (id: string) => { uncertain = id; },
    deny: (cap: CustodyCapability) => { denied = cap; }, wide: () => { wideAdmission = true; }, mismatch: () => { wrongDigest = true; },
    rejectVerification: () => { verifyAccepted = false; }, setNow: (date: Date) => { now = date; }, cancel: () => { cancelled = true; },
    mutate: (patch: Record<string, unknown>) => { if (!grant) throw new Error('not enrolled'); Object.assign(grant, patch); },
    onOpen: (action: () => void) => { onOpen = action; }, onDecode: (action: () => void) => { onDecode = action; },
    onExecute: (action: () => void) => { onExecute = action; } };
}
describe('P5a owned canonical custody composition; inert IO only, no keys/signing/PG', () => {
  it('canonical owned strict audit preserves metadata/agent truncation and propagates write refusal', async () => {
    const query = vi.fn(async (_sql: string, _values: unknown[]) => ({ rows: [] }));
    await recordAuditEventStrictWithClient({ actorType: 'user', actorId: USER, event: 'grant.locally_replaced',
      targetType: 'execution_grant', targetId: GRANT, userAgent: 'x'.repeat(300), metadata: { localOnly: true } }, { query });
    expect(query.mock.calls[0]![1]).toEqual(['user',USER,'grant.locally_replaced','execution_grant',GRANT,null,'x'.repeat(256),'{"localOnly":true}']);
    await expect(recordAuditEventStrictWithClient({ actorType: 'user', event: 'grant.locally_revoked' },
      { query: async () => { throw new Error('inert audit refusal'); } })).rejects.toThrow('inert audit refusal');
  });
  it('commits independent admission before enrollment, redacts public grant and zeroes one-use bytes', async () => {
    const f = fixture(), custody = createOwnedCustodyComposition(f.ports);
    expect(await custody.enroll(scope, f.input)).toMatchObject({ id: GRANT, hasSealedSecret: true });
    expect(f.calls.findIndex(c => c.sql.includes('INSERT INTO custody_secret_admissions'))).toBeLessThan(
      f.calls.findIndex(c => c.sql.includes('INSERT INTO user_execution_grants')));
    expect(f.calls.find(c => c.sql.includes('INSERT INTO custody_secret_admissions'))!.identity).toBe('swat_custody_writer');
    expect(f.calls.find(c => c.sql.includes('INSERT INTO user_execution_grants'))!.identity).toBe('swat_app');
    expect(f.wrapped!.every(b => b === 0)).toBe(true); expect([...f.input.secret]).toEqual([17,33,65,129]);
    const session = await custody.session(scope, GRANT, f.input.chain); let held: Uint8Array | undefined;
    await session.use(async bytes => { held = bytes; expect([...bytes]).toEqual([...f.input.secret]); });
    expect(held!.every(b => b === 0)).toBe(true); expect(f.opened!.every(b => b === 0)).toBe(true);
    await expect(session.use(async () => {})).rejects.toThrow('custody-stale');
    expect(f.calls.every(c => !/^(BEGIN|COMMIT|ROLLBACK)$/.test(c.sql))).toBe(true);
  });
  it.each(['wrap-only','secret-admission','grant-enrollment'] as const)('missing %s approval refuses without escalating authority', async capability => {
    const f = fixture(); f.deny(capability);
    await expect(createOwnedCustodyComposition(f.ports).enroll(scope, f.input)).rejects.toThrow('custody-unavailable');
    expect(f.grant).toBeNull(); expect(f.ports.unwrap.open).not.toHaveBeenCalled();
  });
  it.each(['widened','wrong-digest','verification'] as const)('rejects %s admission before grant effects', async reason => {
    const f = fixture(); if (reason === 'widened') f.wide(); else if (reason === 'wrong-digest') f.mismatch(); else f.rejectVerification();
    await expect(createOwnedCustodyComposition(f.ports).enroll(scope, f.input)).rejects.toThrow('custody-unavailable'); expect(f.grant).toBeNull();
  });
  it('an enrollment rollback retains only the independently committed admission and no grant', async () => {
    const f = fixture(); f.fail('swat_app');
    await expect(createOwnedCustodyComposition(f.ports).enroll(scope, f.input)).rejects.toThrow('custody-unavailable');
    expect(f.grant).toBeNull(); expect(f.admissions).toHaveLength(1); expect(f.wrapped!.every(b => b === 0)).toBe(true);
  });
  it('failed admission commit retains neither admission nor grant', async () => {
    const f = fixture(); f.fail('swat_custody_writer');
    await expect(createOwnedCustodyComposition(f.ports).enroll(scope, f.input)).rejects.toThrow('custody-unavailable');
    expect(f.admissions).toEqual([]); expect(f.grant).toBeNull();
  });
  it('uncertain admission COMMIT suppresses enrollment without pretending durable rollback', async () => {
    const f = fixture(); f.uncertain('swat_custody_writer');
    await expect(createOwnedCustodyComposition(f.ports).enroll(scope, f.input)).rejects.toThrow('custody-unavailable');
    expect(f.admissions).toHaveLength(1); expect(f.grant).toBeNull();
  });
  it('wrap/read identities cannot collapse onto application identity', () => {
    const f = fixture(); expect(() => createOwnedCustodyComposition({ ...f.ports,
      database: { ...f.ports.database, execution: { ...f.ports.database.execution, identity: 'swat_app' } } })).toThrow('custody-unavailable');
  });
  it.each(['execution-secret-read','execution-unwrap'] as const)('missing %s approval refuses before consumer', async capability => {
    const f = fixture(), custody = createOwnedCustodyComposition(f.ports); await custody.enroll(scope, f.input); f.deny(capability);
    await expect((async () => (await custody.session(scope, GRANT, f.input.chain)).use(async () => {}))()).rejects.toThrow('custody-unavailable');
    expect(f.ports.unwrap.open).not.toHaveBeenCalled();
  });
  it.each(['foreign-tenant','changed-policy','expired','revoked','retired-ABA','missing-admission'] as const)('refuses %s without consuming material', async reason => {
    const f = fixture(), custody = createOwnedCustodyComposition(f.ports); await custody.enroll(scope, f.input);
    const session = await custody.session(scope, GRANT, f.input.chain);
    if (reason === 'changed-policy') f.mutate({ scope_policy: { max: '1' } });
    if (reason === 'expired') f.setNow(f.input.expiresAt);
    if (reason === 'revoked' || reason === 'retired-ABA') f.mutate({ status: reason === 'revoked' ? 'revoked' : 'active',
      lifecycle_revision: '3', revoked_at: reason === 'revoked' ? baseTime : null, revocation_tombstone: baseTime });
    if (reason === 'missing-admission') f.admissions.splice(0);
    let used = false;
    await expect(reason === 'foreign-tenant' ? custody.session({ userId: RUN } as UserScope, GRANT, f.input.chain) :
      session.use(async () => { used = true; })).rejects.toThrow();
    expect(used).toBe(false); expect(f.ports.unwrap.open).not.toHaveBeenCalled();
  });
  it.each(['expiry','revocation','cancellation'] as const)('post-open %s zeros transferred bytes and prevents use', async reason => {
    const f = fixture(), custody = createOwnedCustodyComposition(f.ports); await custody.enroll(scope, f.input);
    const session = await custody.session(scope, GRANT, f.input.chain);
    f.onOpen(() => reason === 'expiry' ? f.setNow(f.input.expiresAt) : reason === 'cancellation' ? f.cancel() :
      f.mutate({ status: 'revoked', revoked_at: baseTime, revocation_tombstone: baseTime, lifecycle_revision: '2' }));
    let used = false; await expect(session.use(async () => { used = true; })).rejects.toThrow();
    expect(used).toBe(false); expect(f.opened!.every(b => b === 0)).toBe(true);
  });
  it('joins actual deployed delegation authorization/decode/scoped effect and refuses reuse', async () => {
    const f = fixture(), custody = createOwnedCustodyComposition(f.ports); await custody.enroll(scope, f.input);
    const verdict = await custody.authority(scope, GRANT).authorize(f.request); expect(verdict.kind).toBe('granted');
    if (verdict.kind !== 'granted') throw new Error('unexpected denial');
    expect(await verdict.authority.sign(f.payload)).toMatchObject({ kind: 'signed' }); expect(f.executed).toBe(1);
    expect(await verdict.authority.sign(f.payload)).toMatchObject({ kind: 'refused' }); expect(f.executed).toBe(1);
    expect(f.calls.some(c => c.identity === 'inert-reader' && c.sql.includes('FOR UPDATE'))).toBe(true);
    expect(f.opened!.every(b => b === 0)).toBe(true);
  });
  it.each(['decode-ABA','effect-boundary-expiry','out-of-scope'] as const)('deployed %s never reports a signature', async reason => {
    const f = fixture(), custody = createOwnedCustodyComposition(f.ports); await custody.enroll(scope, f.input);
    const verdict = await custody.authority(scope, GRANT).authorize(f.request); if (verdict.kind !== 'granted') throw new Error('unexpected denial');
    if (reason === 'decode-ABA') f.onDecode(() => f.mutate({ lifecycle_revision: '4', revocation_tombstone: baseTime }));
    if (reason === 'effect-boundary-expiry') f.onExecute(() => f.setNow(new Date(f.request.payloadScope!.signatureDeadline)));
    const result = await verdict.authority.sign(reason === 'out-of-scope' ? { ...f.payload,
      typedData: { ...(f.payload as any).typedData, domain: { chainId: 4664 } } } as AuthoritySigningRequest : f.payload);
    expect(result.kind).toBe('refused'); expect(f.executed).toBe(0);
  });
  it('runs the callable joined lifecycle scenario with exact independently specified journals and conserved rollback', async () => {
    const f = fixture();
    const record = (version: number): CustodyEnrollmentRecord => ({ id: GRANT, chain: f.input.chain, grantKind: f.input.grantKind,
      accountAddress: ACCOUNT, keyVersion: version, scopePolicy: { max: '900719925474099312345' }, expiresAt: new Date(f.input.expiresAt),
      sealedSecret: envelope(version), secretBinding: buildCustodySecretBinding({ deploymentId: 'inert-deployment', chainId: '4663',
        userId: USER, grantId: GRANT, chain: f.input.chain, grantKind: f.input.grantKind, accountAddress: ACCOUNT,
        keyVersion: version, scopePolicy: { max: '900719925474099312345' }, expiresAt: f.input.expiresAt }) });
    const first = record(1), next = record(2), later = new Date(baseTime.getTime() + 1);
    const admission = (r: CustodyEnrollmentRecord, acceptedAt: Date) => ({ id: `44444444-4444-4444-8444-${String(r.keyVersion).padStart(12,'0')}`,
      userId: USER, record: r, wrapperId: 'inert-wrapper', serviceIdentity: 'inert-wrap-service', authenticatedReceipt: 'inert-receipt', acceptedAt });
    const journal = (r: CustodyEnrollmentRecord, revision: string, status: CustodyGrantSnapshot['status'], observedAt: Date,
      tombstone: Date | null, accepted: ReturnType<typeof admission>[]): CustodyJournal => ({
      scope: { runId: RUN, userId: USER, grantId: GRANT, chain: f.input.chain, observerIdentity: 'inert-observer',
        deploymentId: 'inert-deployment', chainId: '4663' }, observedAt: observedAt.toISOString(), admissions: accepted,
      history: [
        ...(BigInt(revision) >= 2n ? [{ event: 'grant.locally_revoked', actorType: 'user', actorId: USER,
          targetType: 'execution_grant', targetId: GRANT, metadata: { chain: f.input.chain, grantKind: f.input.grantKind,
            previousLifecycleRevision: '1', lifecycleRevision: '2', localOnly: true }, createdAt: baseTime.toISOString() }] : []),
        ...(BigInt(revision) >= 3n ? [{ event: 'grant.locally_retired', actorType: 'user', actorId: USER,
          targetType: 'execution_grant', targetId: GRANT, metadata: { chain: f.input.chain, grantKind: f.input.grantKind,
            previousLifecycleRevision: '2', lifecycleRevision: '3', localOnly: true }, createdAt: baseTime.toISOString() }] : []),
        ...(BigInt(revision) >= 5n ? [{ event: 'grant.locally_replaced', actorType: 'user', actorId: USER,
          targetType: 'execution_grant', targetId: GRANT, metadata: { chain: f.input.chain, grantKind: f.input.grantKind,
            previousLifecycleRevision: '3', lifecycleRevision: '5', localOnly: true }, createdAt: later.toISOString() }] : [])
      ],
      grant: { ...r, userId: USER, status, lifecycleRevision: revision, revokedAt: status === 'revoked' || status === 'retired' ? tombstone : null,
        revocationTombstone: tombstone } });
    const firstAdmission = admission(first, baseTime), secondAdmission = admission(next, later);
    const verify = f.ports.admissionVerifier.verify;
    f.ports.admissionVerifier.verify = async i => { if (i.record.keyVersion === 2) f.setNow(later); return verify(i); };
    const result = await createCustodyScenarioFactory(f.ports).lifecycle({ scope, syntheticInput: f.input, grantId: GRANT,
      observe: async () => f.journal(), request: f.request, payload: f.payload,
      expected: { enrolled: journal(first,'1','active',baseTime,null,[firstAdmission]),
        revoked: journal(first,'2','revoked',baseTime,baseTime,[firstAdmission]),
        retired: journal(first,'3','retired',baseTime,baseTime,[firstAdmission]),
        reactivated: journal(next,'5','active',later,baseTime,[firstAdmission,secondAdmission]) },
      replacement: { record: next, authentication: { wrapperId: 'inert-wrapper', serviceIdentity: 'inert-wrap-service', authenticatedReceipt: 'inert-receipt' },
        admission: secondAdmission },
      rollback: { arm: async () => { f.fail('swat_app'); }, input: { grantId: GRANT, chain: f.input.chain,
        expectedLifecycleRevision: '5', status: 'compromised', now: later } } });
    expect(result.evidence).toMatchObject({ lifecycleRevisions: ['1','2','3','5'], staleAbaRefused: true, rollbackConserved: true,
      delegatedReplayRefused: true, secretProjected: false });
    expect(result.evidence.journalHashes).toHaveLength(4); expect(f.snapshot()!.status).toBe('active');
    expect(JSON.stringify(result)).not.toContain('inert-not-a-signature'); expect(JSON.stringify(result)).not.toContain(envelope(1));
  });
  it('source admission captures complete binding/policy before acquisition and exact replay refuses receipt mutation', async () => {
    const f = fixture(), custody = createOwnedCustodyComposition(f.ports); await custody.enroll(scope, f.input);
    const record = structuredClone(f.journal().admissions[0]!.record), auth = { wrapperId: 'inert-wrapper', serviceIdentity: 'inert-wrap-service', authenticatedReceipt: 'inert-receipt' };
    const prepared = prepareCustodySecretAdmission({ scope, record, authentication: auth, verifier: f.ports.admissionVerifier, now: f.ports.now });
    (record.scopePolicy as any).max = 'mutated';
    await expect(f.ports.database.admission.transaction(scope, c => prepared(c as any))).resolves.toMatchObject({ outcome: 'committed' });
    await expect(custody.admitReplacement(scope, f.journal().admissions[0]!.record, { ...auth, authenticatedReceipt: 'substitution' })).rejects.toThrow();
    expect(f.admissions).toHaveLength(1);
  });
});
