import { describe, expect, it, vi } from 'vitest';
import { createCustodyEnrollment, type CustodyEnrollmentRecord } from './custody-enrollment.js';
import { custodyBindingAad } from './custody-contract.js';
import type { UserScope } from './tenancy.js';
const scope = { userId: 'fixture-user' } as UserScope;
const account = '0x' + '1'.repeat(40);
const grantId = '11111111-1111-4111-8111-111111111111';
function fixture() {
  let now = new Date('2026-11-17T00:00:00Z');
  const seal = vi.fn(async ({ binding }: any) => ['v2','fixture-wrapper',String(binding.keyVersion),
    Buffer.from('inert-wrapped').toString('base64'),Buffer.alloc(12,1).toString('base64'),
    Buffer.alloc(16,2).toString('base64'),Buffer.from('inert-ciphertext').toString('base64')].join('.'));
  const record = vi.fn(async (tenant: UserScope, input: CustodyEnrollmentRecord) => ({
    id: input.id, userId: tenant.userId, chain: input.chain, grantKind: input.grantKind,
    accountAddress: input.accountAddress, hasSealedSecret: input.sealedSecret !== null,
    keyVersion: input.keyVersion, scopePolicy: input.scopePolicy, expiresAt: input.expiresAt,
    revokedAt: null, status: 'active' as const, createdAt: now,
    // Adversarial extra storage fields must not leak through the public result.
    sealedSecret: input.sealedSecret, plaintext: 'never-public'
  }));
  const deps = { deploymentId: 'fixture-deployment', chainIds: { solana: 'fixture-genesis', polygon: '137', 'robinhood-chain': '4663' },
    allocateGrantId: vi.fn(async () => grantId), store: { record },
    wrap: { wrapperId: 'fixture-wrapper', keyVersion: 7, seal }, now: () => now };
  return { deps, seal, record, setNow: (value: Date) => { now = value; } };
}
const keyed = () => ({ chain: 'robinhood-chain' as const, grantKind: 'session_key_4337' as const,
  accountAddress: account, secret: Uint8Array.from([1,2,3]), scopePolicy: { max: '20' }, expiresAt: new Date('2030-01-01T00:00:00Z') });
describe('wrap-only enrollment drives actual injected persistence', () => {
  it('binds tenant/account/policy/version/expiry, zeros owned bytes and projects no secret', async () => {
    const f = fixture(), input = keyed();
    const result = await createCustodyEnrollment(f.deps).enroll(scope, input);
    expect(f.seal).toHaveBeenCalledTimes(1); expect(f.record).toHaveBeenCalledTimes(1);
    const wrapped = f.seal.mock.calls[0]![0];
    expect(wrapped.binding).toMatchObject({ userId: scope.userId, grantId, accountAddress: account,
      keyVersion: 7, scopeVersion: 1, expiresAt: input.expiresAt.toISOString() });
    expect(custodyBindingAad(wrapped.binding)).toContain('policyDigest');
    expect([...wrapped.plaintext]).toEqual([0,0,0]); expect([...input.secret]).toEqual([1,2,3]);
    expect('sealedSecret' in result).toBe(false); expect('plaintext' in result).toBe(false);
    expect(JSON.stringify(result)).not.toContain('inert-ciphertext');
  });
  it('never wraps or allocates material for a keyless vault', async () => {
    const f = fixture();
    const result = await createCustodyEnrollment(f.deps).enroll(scope, { chain: 'solana', grantKind: 'solana_vault',
      accountAddress: 'So11111111111111111111111111111111111111112' });
    expect(f.seal).not.toHaveBeenCalled(); expect(result.hasSealedSecret).toBe(false); expect(result.keyVersion).toBeNull();
    expect(f.record.mock.calls[0]![1].secretBinding).toBeNull();
  });
  it('rejects a keyless placeholder secret', async () => {
    const f = fixture();
    await expect(createCustodyEnrollment(f.deps).enroll(scope, { chain: 'solana', grantKind: 'solana_vault',
      accountAddress: 'So11111111111111111111111111111111111111112', secret: Uint8Array.from([0]) })).rejects.toThrow('custody-invalid');
    expect(f.record).not.toHaveBeenCalled(); expect(f.seal).not.toHaveBeenCalled();
  });
  it('missing wrap identity stays unavailable, even if a caller supplies opaque policy labels', async () => {
    const f = fixture(), enrollment = createCustodyEnrollment({ ...f.deps, wrap: undefined });
    await expect(enrollment.enroll(scope, keyed())).rejects.toThrow('custody-unavailable');
    expect(f.record).not.toHaveBeenCalled(); expect(f.deps.allocateGrantId).not.toHaveBeenCalled();
    expect(enrollment.readiness()).toMatchObject({ injectedPortsConfigured: false, runtimeAccepted: false, liveCapabilityAccepted: false });
    expect(createCustodyEnrollment(f.deps).readiness()).toMatchObject({ injectedPortsConfigured: true, runtimeAccepted: false, liveCapabilityAccepted: false });
  });
  it('wrap service errors are sanitized and owned bytes zeroed without persisting', async () => {
    const f = fixture(); let bytes: Uint8Array | undefined;
    f.seal.mockImplementation(async ({ plaintext }: any) => { bytes = plaintext; throw new Error('plaintext-sensitive-provider-error'); });
    await expect(createCustodyEnrollment(f.deps).enroll(scope, keyed())).rejects.toThrow('custody-unavailable');
    expect([...bytes!]).toEqual([0,0,0]); expect(f.record).not.toHaveBeenCalled();
  });
  it('storage errors containing ciphertext parameters never leak to public enrollment errors', async () => {
    const f = fixture(); f.record.mockRejectedValue(new Error('secret-ciphertext-sql-parameter-error'));
    await expect(createCustodyEnrollment(f.deps).enroll(scope, keyed())).rejects.toThrow('custody-unavailable');
  });
  it('caller mutations during await cannot substitute tenant, chain, secret, policy or expiry', async () => {
    const f = fixture(), input = keyed(), tenant = { ...scope };
    f.deps.allocateGrantId.mockImplementation(async () => {
      tenant.userId = 'other-user'; input.secret.fill(9); input.scopePolicy.max = '999'; input.expiresAt.setUTCFullYear(2040);
      return grantId;
    });
    await createCustodyEnrollment(f.deps).enroll(tenant as UserScope, input);
    expect(f.record.mock.calls[0]![0].userId).toBe('fixture-user');
    expect(f.record.mock.calls[0]![1].scopePolicy).toEqual({ max: '20' });
    expect(f.record.mock.calls[0]![1].expiresAt?.toISOString()).toBe('2030-01-01T00:00:00.000Z');
  });
  it('expiry crossing while wrap runs stops persistence', async () => {
    const f = fixture();
    f.seal.mockImplementation(async ({ binding }: any) => {
      f.setNow(new Date('2031-01-01T00:00:00Z'));
      return ['v2','fixture-wrapper',String(binding.keyVersion),Buffer.from('x').toString('base64'),
        Buffer.alloc(12).toString('base64'),Buffer.alloc(16).toString('base64'),Buffer.from('x').toString('base64')].join('.');
    });
    await expect(createCustodyEnrollment(f.deps).enroll(scope, keyed())).rejects.toThrow('custody-stale');
    expect(f.record).not.toHaveBeenCalled();
  });
  it.each(['userId','id','accountAddress','scopePolicy','expiresAt','keyVersion'])('denies storage result substituting %s', async field => {
    const f = fixture(), original = f.record.getMockImplementation()!;
    f.record.mockImplementation(async (s, input) => ({ ...await original(s, input), [field]:
      field === 'scopePolicy' ? { max: '999' } : field === 'expiresAt' ? new Date('2040-01-01') : field === 'keyVersion' ? 8 : 'substitute' } as any));
    await expect(createCustodyEnrollment(f.deps).enroll(scope, keyed())).rejects.toThrow();
  });
});
