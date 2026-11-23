import { createCipheriv, createDecipheriv } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createCustodyEnrollment } from '../../../packages/db/src/custody-enrollment.js';
import { createCustodyExecutionAccess } from '../../../packages/db/src/custody-execution.js';
import { custodyBindingAad, type CustodyGrantSnapshot } from '../../../packages/db/src/custody-contract.js';
import type { UserScope } from '../../../packages/db/src/tenancy.js';
import { custodySqlStores, qualifyCustodyBinding, type CustodyEnrollmentPorts, type CustodyExecutionPorts } from './custody-scenarios.js';

const scope = { userId: 'wave4-synthetic-user' } as UserScope;
const grantId = '11111111-1111-4111-8111-111111111111';
function fixture() {
  // Fixed inert test bytes, not provider/key generation or deployed material.
  const key = Buffer.alloc(32, 7), source = Uint8Array.from([17, 33, 65, 129]);
  let now = new Date('2026-11-18T12:00:00.000Z'), snapshot: CustodyGrantSnapshot | null = null;
  let failCommit = false, beforeOpen = () => {}, opens = 0, seals = 0;
  let providerBytes: Uint8Array | undefined, wrappedBytes: Uint8Array | undefined;
  const input = { chain: 'robinhood-chain' as const, grantKind: 'session_key_4337' as const,
    accountAddress: `0x${'1'.repeat(40)}`, secret: source, scopePolicy: { allowed: ['synthetic-no-effect'], maxRaw: '900719925474099312345' },
    expiresAt: new Date('2026-11-18T12:10:00.000Z') };
  const enrollment: CustodyEnrollmentPorts = { deploymentId: 'wave4-synthetic', chainIds: { 'robinhood-chain': '4663' },
    allocateGrantId: async () => grantId, now: () => now,
    wrap: { wrapperId: 'local-synthetic-aead', keyVersion: 1, seal: async ({ plaintext, binding }) => {
      seals++; wrappedBytes = plaintext;
      const nonce = Buffer.alloc(12, seals), cipher = createCipheriv('aes-256-gcm', key, nonce);
      const aad = Buffer.from(custodyBindingAad(binding)); cipher.setAAD(aad);
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return ['v2', 'local-synthetic-aead', '1', aad.toString('base64'), nonce.toString('base64'),
        cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join('.');
    } },
    store: { record: async (s, record) => {
      const working: CustodyGrantSnapshot = { ...record, userId: s.userId, status: 'active', lifecycleRevision: '1',
        revocationTombstone: null, revokedAt: null };
      if (failCommit) throw new Error('inert commit failure');
      snapshot = structuredClone(working);
      return { id: record.id, userId: s.userId, chain: record.chain, grantKind: record.grantKind, accountAddress: record.accountAddress,
        hasSealedSecret: !!record.sealedSecret, keyVersion: record.keyVersion, scopePolicy: record.scopePolicy,
        expiresAt: record.expiresAt, revokedAt: null, status: 'active', createdAt: now };
    } }
  };
  const execution: CustodyExecutionPorts = { deploymentId: 'wave4-synthetic', chainIds: { 'robinhood-chain': '4663' }, now: () => now,
    store: { load: async (s, id) => snapshot?.userId === s.userId && snapshot.id === id ? structuredClone(snapshot) : null },
    unwrap: { open: async ({ sealedSecret, binding }) => {
      opens++; beforeOpen();
      const parts = sealedSecret.split('.'), decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parts[4]!, 'base64'));
      decipher.setAAD(Buffer.from(custodyBindingAad(binding))); decipher.setAuthTag(Buffer.from(parts[5]!, 'base64'));
      providerBytes = Uint8Array.from(Buffer.concat([decipher.update(Buffer.from(parts[6]!, 'base64')), decipher.final()]));
      return providerBytes;
    } }
  };
  return { input, enrollment, execution, get snapshot() { return snapshot; }, get opens() { return opens; }, get seals() { return seals; },
    get providerBytes() { return providerBytes; }, get wrappedBytes() { return wrappedBytes; },
    change: (patch: Partial<CustodyGrantSnapshot>) => { if (!snapshot) throw new Error('fixture not enrolled'); snapshot = { ...snapshot, ...patch }; },
    setNow: (value: Date) => { now = value; }, failCommit: () => { failCommit = true; }, beforeOpen: (action: () => void) => { beforeOpen = action; },
    close: () => { key.fill(0); source.fill(0); providerBytes?.fill(0); } };
}
async function enrolled(f: ReturnType<typeof fixture>) {
  await createCustodyEnrollment(f.enrollment).enroll(scope, f.input);
  return createCustodyExecutionAccess(f.execution).session(scope, grantId);
}

describe('custody qualification source; local synthetic AEAD and inert store only', () => {
  it('roundtrips full AAD through production enrollment/session, single use and buffer zeroing', async () => {
    const f = fixture();
    try {
      const result = await qualifyCustodyBinding(f.enrollment, f.execution, scope, f.input);
      expect(result.boundary).toMatchObject({ runtimeAccepted: false, liveCapabilityAccepted: false, productionReady: false });
      expect(result.evidence.secretProjected).toBe(false); expect(result.blocked).toHaveLength(3);
      expect(f.seals).toBe(1); expect(f.opens).toBe(1);
      expect(f.providerBytes?.every(value => value === 0)).toBe(true); expect(f.wrappedBytes?.every(value => value === 0)).toBe(true);
      expect([...f.input.secret]).toEqual([17, 33, 65, 129]);
      expect(Object.keys(f.enrollment.wrap!).sort()).toEqual(['keyVersion', 'seal', 'wrapperId']);
      expect(Object.keys(f.execution.unwrap)).toEqual(['open']);
    } finally { f.close(); }
  });
  it('owned SQL transaction is mandatory rather than falling back to ambient pool', () => {
    expect(() => custodySqlStores(undefined as any)).toThrow('owned transaction required');
  });
  it('missing wrap capability refuses before persistence', async () => {
    const f = fixture(); try {
      await expect(createCustodyEnrollment({ ...f.enrollment, wrap: undefined }).enroll(scope, f.input)).rejects.toThrow('custody-unavailable');
      expect(f.snapshot).toBeNull(); expect(f.seals).toBe(0);
    } finally { f.close(); }
  });
  it('inert failed commit leaves no grant and zeros enrollment-owned plaintext', async () => {
    const f = fixture(); try {
      f.failCommit(); await expect(createCustodyEnrollment(f.enrollment).enroll(scope, f.input)).rejects.toThrow('custody-unavailable');
      expect(f.snapshot).toBeNull(); expect(f.wrappedBytes?.every(v => v === 0)).toBe(true);
    } finally { f.close(); }
  });
  it.each(['deployment', 'chain-domain'] as const)('wrong %s refuses before local unwrap', async field => {
    const f = fixture(); try {
      await enrolled(f);
      const access = createCustodyExecutionAccess({ ...f.execution, ...(field === 'deployment'
        ? { deploymentId: 'foreign' } : { chainIds: { 'robinhood-chain': '4664' } }) });
      await expect(access.session(scope, grantId)).rejects.toThrow('custody-invalid'); expect(f.opens).toBe(0);
    } finally { f.close(); }
  });
  it('foreign tenant cannot load or unwrap an enrolled grant', async () => {
    const f = fixture(); try {
      await enrolled(f); await expect(createCustodyExecutionAccess(f.execution).session({ userId: 'foreign' } as UserScope, grantId)).rejects.toThrow('custody-stale');
      expect(f.opens).toBe(0);
    } finally { f.close(); }
  });
  it.each(['account', 'policy', 'revision', 'expiry'] as const)('%s changed after session allocation refuses use', async field => {
    const f = fixture(); try {
      const session = await enrolled(f);
      f.change(field === 'account' ? { accountAddress: `0x${'2'.repeat(40)}` } : field === 'policy' ? { scopePolicy: { maxRaw: '1' } }
        : field === 'revision' ? { lifecycleRevision: '2' } : { expiresAt: new Date('2026-11-18T12:11:00.000Z') });
      await expect(session.use(async () => { throw new Error('must not consume'); })).rejects.toThrow(); expect(f.opens).toBe(0);
    } finally { f.close(); }
  });
  it.each(['before-open', 'during-open'] as const)('revoke-retire-reactivate ABA at %s never consumes bytes', async phase => {
    const f = fixture(); try {
      const session = await enrolled(f), revoked = new Date('2026-11-18T12:00:00.000Z');
      const aba = () => {
        f.change({ status: 'revoked', lifecycleRevision: '2', revokedAt: revoked, revocationTombstone: revoked });
        f.change({ status: 'retired', lifecycleRevision: '3' });
        f.change({ status: 'active', lifecycleRevision: '4', revokedAt: null });
      };
      if (phase === 'before-open') aba(); else f.beforeOpen(aba);
      let consumed = false;
      await expect(session.use(async () => { consumed = true; })).rejects.toThrow('custody-stale'); expect(consumed).toBe(false);
      expect(f.opens).toBe(phase === 'before-open' ? 0 : 1);
      if (f.providerBytes) expect(f.providerBytes.every(v => v === 0)).toBe(true);
    } finally { f.close(); }
  });
  it.each(['before-open', 'during-open'] as const)('expiry at exact deadline %s refuses consumption', async phase => {
    const f = fixture(); try {
      const session = await enrolled(f), expire = () => f.setNow(new Date(f.input.expiresAt));
      if (phase === 'before-open') expire(); else f.beforeOpen(expire);
      let consumed = false;
      await expect(session.use(async () => { consumed = true; })).rejects.toThrow('custody-stale'); expect(consumed).toBe(false);
      if (f.providerBytes) expect(f.providerBytes.every(v => v === 0)).toBe(true);
    } finally { f.close(); }
  });
  it('changed authenticated ciphertext fails local AEAD and cannot echo its contents', async () => {
    const f = fixture(); try {
      await enrolled(f); const parts = f.snapshot!.sealedSecret!.split('.');
      const ciphertext = Buffer.from(parts[6]!, 'base64'); ciphertext[0] = ciphertext[0]! ^ 1; parts[6] = ciphertext.toString('base64');
      f.change({ sealedSecret: parts.join('.') }); const session = await createCustodyExecutionAccess(f.execution).session(scope, grantId);
      await expect(session.use(async () => { throw new Error('cannot consume'); })).rejects.toThrow('custody-unavailable');
    } finally { f.close(); }
  });
});
