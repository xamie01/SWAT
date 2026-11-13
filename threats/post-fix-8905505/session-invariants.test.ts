import { afterEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../packages/db/src/client.js', () => ({ query: fixture.query }));
vi.mock('../../packages/db/src/transaction.js', () => ({ withTransaction: vi.fn() }));
vi.mock('../../packages/db/src/credentials.js', () => ({
  hashToken: () => Buffer.from('synthetic-hash'), generateToken: vi.fn(), hashPassword: vi.fn(),
  verifyPassword: vi.fn(), verifyPasswordAgainstDummy: vi.fn()
}));
import { clearSessionCache, resolveSession, revokeSession } from '../../packages/db/src/users.js';

afterEach(() => { clearSessionCache(); vi.clearAllMocks(); });

describe('Session revocation concurrency', () => {
  it('DB-03: an in-flight pre-revocation lookup must not repopulate the cache after logout', async () => {
    clearSessionCache();
    let finish!: (rows: unknown[]) => void;
    fixture.query.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const inFlight = resolveSession('synthetic-token');
    fixture.query.mockResolvedValueOnce([]);
    await revokeSession('synthetic-token');
    finish([{ session_id: 'fixture-session', id: 'fixture-user', email: 'fixture@example.invalid', display_name: null,
      role: 'user', tier: 'free', tier_expires_at: null, status: 'active', created_at: new Date() }]);
    await inFlight;
    fixture.query.mockResolvedValueOnce([]);
    expect(await resolveSession('synthetic-token')).toBeNull();
  });
});
