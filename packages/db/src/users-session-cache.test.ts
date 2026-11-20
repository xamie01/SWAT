import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashToken } from './credentials.js';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('./client.js', () => ({ query: mocks.query, pool: {}, writePool: {}, readPool: {} }));

import {
  resolveSession, revokeSession, revokeAllSessions, clearSessionCache,
  sessionCacheSize, invalidateUserSessionCache, SESSION_CACHE_MAX_ENTRIES, SESSION_CACHE_TTL_MS,
} from './users.js';

const mockUserRow = {
  session_id: 'sess-123', id: 'usr-456', email: 'trader@example.invalid',
  display_name: 'Alpha Trader', role: 'user' as const, tier: 'operator' as const,
  tier_expires_at: null, status: 'active' as const, created_at: new Date('2026-08-01T00:00:00Z'),
};

function resolved(row = mockUserRow): void {
  mocks.query.mockResolvedValueOnce([{ session_id: row.session_id }]).mockResolvedValueOnce([row]);
}

beforeEach(() => { mocks.query.mockReset(); clearSessionCache(); });
afterEach(() => { clearSessionCache(); });

describe('session cache compatibility without cached authorization', () => {
  it('touches and reselects authoritative state on every resolution', async () => {
    resolved();
    const first = await resolveSession('token-abc');
    expect(first?.sessionId).toBe('sess-123');
    expect(first?.user.email).toBe('trader@example.invalid');
    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(mocks.query.mock.calls[0]?.[0]).toMatch(/^UPDATE user_sessions SET last_seen_at/);
    expect(mocks.query.mock.calls[1]?.[0]).toMatch(/FROM user_sessions s JOIN users u/);
    resolved();
    expect(await resolveSession('token-abc')).toEqual(first);
    expect(mocks.query).toHaveBeenCalledTimes(4);
    expect(sessionCacheSize()).toBe(0);
    expect(SESSION_CACHE_MAX_ENTRIES).toBe(0);
    expect(SESSION_CACHE_TTL_MS).toBe(0);
  });

  it('consults committed revocation rather than a prior successful resolution', async () => {
    resolved();
    expect(await resolveSession('token-to-revoke')).not.toBeNull();
    mocks.query.mockResolvedValueOnce([]);
    await revokeSession('token-to-revoke');
    expect(mocks.query.mock.calls[2]).toEqual([
      'UPDATE user_sessions SET revoked_at = NOW() WHERE token_hash = $1 AND revoked_at IS NULL',
      [hashToken('token-to-revoke')],
    ]);
    mocks.query.mockResolvedValueOnce([]);
    expect(await resolveSession('token-to-revoke')).toBeNull();
    expect(mocks.query).toHaveBeenCalledTimes(4);
    expect(sessionCacheSize()).toBe(0);
  });

  it('returns the persisted all-session revocation count without retaining authorization', async () => {
    resolved();
    expect(await resolveSession('token-user-1')).not.toBeNull();
    mocks.query.mockResolvedValueOnce([{ id: 'sess-123' }, { id: 'sess-456' }]);
    expect(await revokeAllSessions({ userId: 'usr-456' } as any)).toBe(2);
    expect(mocks.query.mock.calls[2]?.[1]).toEqual(['usr-456']);
    mocks.query.mockResolvedValueOnce([]);
    expect(await resolveSession('token-user-1')).toBeNull();
    expect(sessionCacheSize()).toBe(0);
  });

  it('keeps invalidation hooks inert and reselects each tenant independently', async () => {
    const other = { ...mockUserRow, session_id: 'sess-999', id: 'usr-789' };
    resolved(); resolved(other);
    expect((await resolveSession('token-1'))?.user.id).toBe('usr-456');
    expect((await resolveSession('token-2'))?.user.id).toBe('usr-789');
    invalidateUserSessionCache('usr-456');
    expect(sessionCacheSize()).toBe(0);
    mocks.query.mockResolvedValueOnce([]);
    resolved(other);
    expect(await resolveSession('token-1')).toBeNull();
    expect((await resolveSession('token-2'))?.user.id).toBe('usr-789');
    expect(mocks.query).toHaveBeenCalledTimes(7);
    expect(mocks.query.mock.calls[4]?.[1]?.[0]).toEqual(hashToken('token-1'));
    expect(mocks.query.mock.calls[5]?.[1]?.[0]).toEqual(hashToken('token-2'));
  });
});
