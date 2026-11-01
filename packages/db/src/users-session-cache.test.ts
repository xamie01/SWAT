import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock('./client.js', () => ({
  query: mocks.query,
  pool: {},
  writePool: {},
  readPool: {},
}));

import {
  resolveSession,
  revokeSession,
  revokeAllSessions,
  clearSessionCache,
  sessionCacheSize,
  invalidateUserSessionCache,
  SESSION_CACHE_MAX_ENTRIES,
  SESSION_CACHE_TTL_MS,
} from './users.js';

describe('user session resolution cache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSessionCache();
  });

  afterEach(() => {
    clearSessionCache();
  });

  const mockUserRow = {
    session_id: 'sess-123',
    id: 'usr-456',
    email: 'trader@wake.trade',
    display_name: 'Alpha Trader',
    role: 'user' as const,
    tier: 'operator' as const,
    tier_expires_at: null,
    status: 'active' as const,
    created_at: new Date('2026-08-01T00:00:00Z'),
  };

  it('queries database on first resolve, then serves subsequent reads from cache', async () => {
    mocks.query.mockResolvedValueOnce([mockUserRow]);

    // 1st call: cache miss, hits database
    const session1 = await resolveSession('token-abc');
    expect(session1).not.toBeNull();
    expect(session1?.sessionId).toBe('sess-123');
    expect(session1?.user.email).toBe('trader@wake.trade');
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(sessionCacheSize()).toBe(1);

    // 2nd call: cache hit within 60s, database is NOT queried again
    const session2 = await resolveSession('token-abc');
    expect(session2).toEqual(session1);
    expect(mocks.query).toHaveBeenCalledTimes(1); // Still 1!
  });

  it('revokeSession immediately invalidates the cache for that token', async () => {
    mocks.query.mockResolvedValueOnce([mockUserRow]);

    await resolveSession('token-to-revoke');
    expect(sessionCacheSize()).toBe(1);

    mocks.query.mockResolvedValueOnce([]); // For UPDATE user_sessions SET revoked_at
    await revokeSession('token-to-revoke');

    expect(sessionCacheSize()).toBe(0);

    // Next resolve should miss cache and query DB again
    mocks.query.mockResolvedValueOnce([]); // Expired / revoked in DB
    const res = await resolveSession('token-to-revoke');
    expect(res).toBeNull();
    expect(mocks.query).toHaveBeenCalledTimes(3);
  });

  it('revokeAllSessions clears all cached sessions for the target user', async () => {
    mocks.query.mockResolvedValueOnce([mockUserRow]);
    await resolveSession('token-user-1');
    expect(sessionCacheSize()).toBe(1);

    mocks.query.mockResolvedValueOnce([{ id: 'sess-123' }]);
    await revokeAllSessions({ userId: 'usr-456' } as any);

    expect(sessionCacheSize()).toBe(0);
  });

  it('invalidateUserSessionCache selectively removes target user sessions', async () => {
    mocks.query.mockResolvedValueOnce([mockUserRow]);
    mocks.query.mockResolvedValueOnce([{ ...mockUserRow, session_id: 'sess-999', id: 'usr-789' }]);

    await resolveSession('token-1');
    await resolveSession('token-2');
    expect(sessionCacheSize()).toBe(2);

    invalidateUserSessionCache('usr-456');
    expect(sessionCacheSize()).toBe(1);
  });
});
