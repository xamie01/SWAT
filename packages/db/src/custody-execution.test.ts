import { describe, expect, it, vi } from 'vitest';
import { createCustodyExecutionAccess } from './custody-execution.js';
import { buildCustodySecretBinding, type CustodyGrantSnapshot } from './custody-contract.js';
import type { UserScope } from './tenancy.js';
const scope = { userId: 'fixture-user' } as UserScope;
const grantId = '11111111-1111-4111-8111-111111111111';
function fixture() {
  const data = { id: grantId, userId: scope.userId, chain: 'robinhood-chain' as const, grantKind: 'session_key_4337' as const,
    accountAddress: '0x' + '1'.repeat(40), scopePolicy: { max: '20' }, keyVersion: 7, expiresAt: new Date('2030-01-01') };
  let grant: CustodyGrantSnapshot = { ...data, status: 'active', lifecycleRevision: '1', revocationTombstone: null, revokedAt: null,
    sealedSecret: ['v2','fixture-wrapper','7',Buffer.from('inert').toString('base64'),Buffer.alloc(12).toString('base64'),
      Buffer.alloc(16).toString('base64'),Buffer.from('inert').toString('base64')].join('.'),
    secretBinding: buildCustodySecretBinding({ ...data, grantId, deploymentId: 'fixture-deployment', chainId: '4663' }) };
  const providerBytes = Uint8Array.from([1,2,3]);
  const open = vi.fn(async () => providerBytes);
  const load = vi.fn(async () => structuredClone(grant));
  const access = createCustodyExecutionAccess({ deploymentId: 'fixture-deployment',
    chainIds: { solana: 'fixture-genesis', polygon: '137', 'robinhood-chain': '4663' },
    store: { load }, unwrap: { open }, now: () => new Date('2026-11-17') });
  return { access, open, load, providerBytes, change: (v: Partial<CustodyGrantSnapshot>) => { grant = { ...grant, ...v }; } };
}
describe('execution-only single-use custody sessions', () => {
  it('loads current scoped snapshot before unwrap and after unwrap, zeros both owned buffers', async () => {
    const f = fixture(); const session = await f.access.session(scope, grantId);
    let retained: Uint8Array | undefined;
    const value = await session.use(async secret => { retained = secret; expect([...secret]).toEqual([1,2,3]); return 'inert-effect-receipt'; });
    expect(value).toBe('inert-effect-receipt'); expect([...retained!]).toEqual([0,0,0]);
    expect([...f.providerBytes]).toEqual([0,0,0]); expect(f.load).toHaveBeenCalledTimes(3);
    await expect(session.use(async () => 'retry')).rejects.toThrow('custody-stale'); expect(f.open).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['tenant', { userId: 'other-user' }], ['row-id', { id: '22222222-2222-4222-8222-222222222222' }],
    ['account', { accountAddress: '0x' + '2'.repeat(40) }], ['key-version', { keyVersion: 8 }],
    ['policy', { scopePolicy: { max: '999' } }], ['expiry', { expiresAt: new Date('2040-01-01') }],
    ['status', { status: 'revoked' }]
  ])('rejects %s substitution before opening bytes', async (_field, change) => {
    const f = fixture(); const session = await f.access.session(scope, grantId);
    f.change(change as any); const consumer = vi.fn(async () => 'effect');
    await expect(session.use(consumer)).rejects.toThrow(); expect(f.open).not.toHaveBeenCalled(); expect(consumer).not.toHaveBeenCalled();
  });
  it('revocation during unwrap refuses effect and zeros bytes', async () => {
    const f = fixture(); f.open.mockImplementation(async () => { f.change({ status: 'revoked' }); return f.providerBytes; });
    const session = await f.access.session(scope, grantId), consumer = vi.fn(async () => 'effect');
    await expect(session.use(consumer)).rejects.toThrow('custody-stale'); expect(consumer).not.toHaveBeenCalled();
    expect([...f.providerBytes]).toEqual([0,0,0]);
  });
  it.each(['before-open','during-open'] as const)('revoke/retire/reactivate ABA at %s refuses stale effect', async phase => {
    const f = fixture(), session = await f.access.session(scope, grantId);
    const revoked = new Date('2026-11-17');
    const aba = () => {
      f.change({ status: 'revoked', lifecycleRevision: '2', revokedAt: revoked, revocationTombstone: revoked });
      f.change({ status: 'retired', lifecycleRevision: '3' });
      f.change({ status: 'active', lifecycleRevision: '4', revokedAt: null });
    };
    if (phase === 'before-open') aba();
    else f.open.mockImplementation(async () => { aba(); return f.providerBytes; });
    const consume = vi.fn(async () => 'effect');
    await expect(session.use(consume)).rejects.toThrow('custody-stale'); expect(consume).not.toHaveBeenCalled();
    if (phase === 'before-open') expect(f.open).not.toHaveBeenCalled();
    else expect([...f.providerBytes]).toEqual([0,0,0]);
  });
  it('passes pinned lifecycle and persistent Date tombstone to scoped effect consumer', async () => {
    const f = fixture(), revoked = new Date('2026-11-16');
    f.change({ lifecycleRevision: '9', revocationTombstone: revoked });
    const session = await f.access.session(scope, grantId);
    await session.use(async (_secret, boundary) => {
      expect(boundary).toEqual({ grantId, lifecycleRevision: '9', revocationTombstone: revoked, expiresAt: new Date('2030-01-01') });
      expect(boundary.revocationTombstone).toBeInstanceOf(Date); return 'inert';
    });
  });
  it('keyless vault never receives an unwrap placeholder', async () => {
    const f = fixture(); f.change({ chain: 'solana', grantKind: 'solana_vault', keyVersion: null, secretBinding: null, sealedSecret: null });
    await expect(f.access.session(scope, grantId)).rejects.toThrow('custody-invalid'); expect(f.open).not.toHaveBeenCalled();
  });
  it('provider and consumer errors never echo secret or provider message', async () => {
    const f = fixture(); f.open.mockRejectedValue(new Error('sensitive-provider-material'));
    const session = await f.access.session(scope, grantId);
    await expect(session.use(async () => 'effect')).rejects.toThrow('custody-unavailable');
    const g = fixture(), next = await g.access.session(scope, grantId);
    await expect(next.use(async () => { throw new Error('sensitive-consumer-material'); })).rejects.toThrow('custody-unavailable');
    expect([...g.providerBytes]).toEqual([0,0,0]);
  });
});
