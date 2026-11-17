import { describe, expect, it } from 'vitest';
import {
  assertCustodyBindingMatches, assertCustodyEnvelope, assertCustodyLifecycle, buildCustodySecretBinding,
  custodyBindingAad, custodyPolicyDigest, custodyPolicySnapshot
} from './custody-contract.js';
import { custodyEnvelopeContext } from './custody-envelope-context.js';
const account = '0x' + '1'.repeat(40);
const base = { deploymentId: 'fixture-deployment', chainId: '4663', userId: 'fixture-user',
  grantId: '11111111-1111-4111-8111-111111111111', chain: 'robinhood-chain' as const,
  grantKind: 'session_key_4337' as const, accountAddress: account, keyVersion: 7,
  scopePolicy: { rules: [{ target: 'fixture-router', max: '20' }] }, expiresAt: new Date('2030-01-01T00:00:00Z') };
function envelope(version = 7) {
  return ['v2', 'fixture-wrapper', String(version), Buffer.from('inert-wrapped').toString('base64'),
    Buffer.alloc(12, 1).toString('base64'), Buffer.alloc(16, 2).toString('base64'), Buffer.from('inert-ciphertext').toString('base64')].join('.');
}
describe('custody binding is metadata authenticated by injected service, not execution authority', () => {
  it('canonicalizes policy object order without altering exact string amounts', () => {
    expect(custodyPolicyDigest({ b: '20', a: { z: 1, y: 2 } })).toBe(custodyPolicyDigest({ a: { y: 2, z: 1 }, b: '20' }));
    expect(custodyPolicyDigest({ amount: '20' })).not.toBe(custodyPolicyDigest({ amount: '020' }));
  });
  it('bridges existing envelope AAD with full policy/expiry/scope digest in purpose', () => {
    const binding = buildCustodySecretBinding(base), context = custodyEnvelopeContext(binding);
    expect(context).toMatchObject({ contextVersion: 2, chainKind: 'evm', grantId: base.grantId, accountAddress: account });
    expect(context.purpose).toMatch(/^execution-grant:scope-v1:[0-9a-f]{64}$/);
    expect(custodyEnvelopeContext(buildCustodySecretBinding({ ...base, scopePolicy: { max: '999' } })).purpose).not.toBe(context.purpose);
    expect(custodyEnvelopeContext(buildCustodySecretBinding({ ...base, expiresAt: new Date('2031-01-01') })).purpose).not.toBe(context.purpose);
    expect(() => custodyEnvelopeContext({ ...binding, contextVersion: 1 } as any)).toThrow();
  });
  it('normalizes account and emits full scope/version AAD', () => {
    const binding = buildCustodySecretBinding({ ...base, accountAddress: `robinhood-chain:${account.toUpperCase().replace('0X','0x')}` });
    expect(binding.accountAddress).toBe(account);
    expect(binding.contextVersion).toBe(2); expect(binding.scopeVersion).toBe(1);
    expect(custodyBindingAad(binding)).toContain(base.grantId);
    assertCustodyBindingMatches(binding, { ...base, id: base.grantId });
  });
  it.each([
    ['tenant', { userId: 'other-user' }], ['row-id', { id: '22222222-2222-4222-8222-222222222222' }],
    ['account', { accountAddress: '0x' + '2'.repeat(40) }], ['key-version', { keyVersion: 8 }],
    ['policy', { scopePolicy: { rules: [{ target: 'attacker', max: '20' }] } }],
    ['expiry', { expiresAt: new Date('2030-01-02T00:00:00Z') }],
    ['kind', { grantKind: 'eip7702' }], ['chain', { chain: 'polygon' }]
  ])('rejects substituted %s before unwrap', (_name, change) => {
    const binding = buildCustodySecretBinding(base);
    expect(() => assertCustodyBindingMatches(binding, { ...base, id: base.grantId, ...change } as any)).toThrow();
  });
  it.each(['deploymentId', 'chainId', 'contextVersion', 'scopeVersion', 'purpose'])('rejects substituted binding %s', field => {
    const binding = buildCustodySecretBinding(base);
    expect(() => assertCustodyBindingMatches({ ...binding, [field]: 'substitute' } as any, { ...base, id: base.grantId }, { deploymentId: base.deploymentId, chainId: base.chainId })).toThrow();
  });
  it('rejects unknown binding fields rather than authenticating an incomplete projection', () => {
    expect(() => assertCustodyBindingMatches({ ...buildCustodySecretBinding(base), extra: true } as any, { ...base, id: base.grantId })).toThrow();
  });
  it('requires exact v2 key-version and canonical fields, not version-prefix appearance', () => {
    expect(() => assertCustodyEnvelope(envelope(), 7, 'fixture-wrapper')).not.toThrow();
    for (const value of ['v1.synthetic', envelope(8), envelope().replace('fixture-wrapper','other-wrapper'), envelope() + '.extra']) {
      expect(() => assertCustodyEnvelope(value, 7, 'fixture-wrapper')).toThrow();
    }
  });
  it.each([0, -1, 1.2, Number.MAX_SAFE_INTEGER + 1])('rejects key version %s', keyVersion => {
    expect(() => buildCustodySecretBinding({ ...base, keyVersion })).toThrow();
  });
  it.each(['0','01','-1','1.5','9223372036854775808',1])('requires canonical positive lifecycle revision %s', lifecycleRevision => {
    expect(() => assertCustodyLifecycle({ lifecycleRevision: lifecycleRevision as string, revocationTombstone: null, revokedAt: null }, new Date('2026-11-17')))
      .toThrow('custody-stale');
  });
  it('requires persistent Date tombstone at or after revocation, never string labels', () => {
    const now = new Date('2026-11-17'), old = new Date('2026-11-16');
    expect(() => assertCustodyLifecycle({ lifecycleRevision: '9223372036854775807', revocationTombstone: old, revokedAt: old }, now)).not.toThrow();
    for (const revocationTombstone of [null, '2026-11-17', new Date('2026-11-15'), new Date('invalid'), new Date('2030-01-01')]) {
      expect(() => assertCustodyLifecycle({ lifecycleRevision: '1', revocationTombstone: revocationTombstone as Date | null, revokedAt: old }, now)).toThrow('custody-stale');
    }
  });
  it('refuses non-JSON policy without evaluating an accessor', () => {
    let called = false;
    expect(() => custodyPolicySnapshot({ get secret() { called = true; return 'plaintext'; } })).toThrow();
    expect(called).toBe(false);
    expect(() => custodyPolicyDigest({ value: BigInt(1) })).toThrow();
    expect(() => custodyPolicyDigest(new Date())).toThrow();
  });
});
