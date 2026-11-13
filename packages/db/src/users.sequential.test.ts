import { beforeEach, describe, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ query: vi.fn(), revoked: false, status: 'active', expired: false }));
vi.mock('./client.js', () => ({ query: db.query }));
vi.mock('./transaction.js', () => ({ withTransaction: async (fn: any) => fn({ query: async (...args: any[]) => ({ rows: await db.query(...args) }) }) }));
vi.mock('./credentials.js', () => ({ hashToken: (v: string) => Buffer.from(v), generateToken: vi.fn(), hashPassword: async () => 'fixture-hash', verifyPassword: vi.fn(), verifyPasswordAgainstDummy: vi.fn() }));
import { changePassword, clearSessionCache, resolveSession, revokeAllSessions, revokeSession, sessionCacheSize } from './users.js';
const row = () => ({ session_id: 's1', id: 'u1', email: 'fixture@example.invalid', display_name: null, role: 'user', tier: 'free', tier_expires_at: null, status: db.status, created_at: new Date(0) });
beforeEach(() => {
  clearSessionCache(); db.revoked = false; db.status = 'active'; db.expired = false;
  db.query.mockReset().mockImplementation(async (sql: string) => {
    if (/^UPDATE user_sessions SET revoked_at/.test(sql)) { db.revoked = true; return [{ id: 's1' }]; }
    if (/^UPDATE users/.test(sql)) return [];
    return db.revoked || db.expired || db.status !== 'active' ? [] : [row()];
  });
});
describe('authoritative session resolution', () => {
  it('does not restore an in-flight pre-revoke result after logout commits', async () => {
    const snapshot = row(); let finish!: (rows: any[]) => void;
    db.query.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const inFlight = resolveSession('fixture');
    await revokeSession('fixture'); finish([snapshot]);
    expect(await inFlight).toBeNull();
    expect(await resolveSession('fixture')).toBeNull();
    expect(sessionCacheSize()).toBe(0);
  });
  it('consults current database revocation from another replica on every request', async () => {
    expect((await resolveSession('fixture'))?.user.id).toBe('u1');
    db.revoked = true;
    expect(await resolveSession('fixture')).toBeNull();
  });
  it.each(['suspended', 'deleted'])('does not retain authorization after %s', async status => {
    expect(await resolveSession('fixture')).not.toBeNull(); db.status = status;
    expect(await resolveSession('fixture')).toBeNull();
  });
  it('honors database absolute/idle expiry without a cache grace period', async () => {
    expect(await resolveSession('fixture')).not.toBeNull(); db.expired = true;
    expect(await resolveSession('fixture')).toBeNull();
  });
  it('revokes all sessions with a password change', async () => {
    expect(await resolveSession('fixture')).not.toBeNull();
    await changePassword({ userId: 'u1' } as any, 'fixture-password');
    expect(await resolveSession('fixture')).toBeNull();
  });
  it('revokes every session on explicit account logout', async () => {
    expect(await resolveSession('fixture')).not.toBeNull();
    expect(await revokeAllSessions({ userId: 'u1' } as any)).toBe(1);
    expect(await resolveSession('fixture')).toBeNull();
  });
});
