import { describe, expect, it, vi } from 'vitest';
import {
  createRedisSessionCache,
  hashSessionTokenForCache,
  sessionCacheKey,
  userSessionSetKey,
  type SessionCacheRedis
} from './session-cache.js';

function fakeRedis(): SessionCacheRedis & { store: Map<string, string>; sets: Map<string, Set<string>> } {
  const store = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  return {
    store,
    sets,
    async get(key) {
      return store.get(key) ?? null;
    },
    async set(key, value) {
      store.set(key, value);
      return 'OK';
    },
    async del(...keys) {
      let deleted = 0;
      for (const k of keys) {
        if (store.delete(k)) deleted += 1;
        if (sets.delete(k)) deleted += 1;
      }
      return deleted;
    },
    async sadd(key, ...members) {
      let s = sets.get(key);
      if (!s) {
        s = new Set();
        sets.set(key, s);
      }
      members.forEach((m) => s!.add(m));
      return members.length;
    },
    async smembers(key) {
      return [...(sets.get(key) ?? [])];
    },
    async expire() {
      return 1;
    }
  };
}

function makeResolved(userId = 'user-1', tier: 'free' | 'operator' = 'free') {
  return {
    sessionId: 'sess-1',
    user: {
      id: userId,
      email: 'alice@example.com',
      displayName: 'Alice',
      role: 'user' as const,
      tier,
      tierExpiresAt: new Date('2027-01-01T00:00:00Z'),
      status: 'active' as const,
      createdAt: new Date('2026-01-01T00:00:00Z')
    }
  };
}

describe('Redis session cache', () => {
  it('caches resolved sessions keyed by SHA-256 hash and preserves Date types', async () => {
    const redis = fakeRedis();
    const cache = createRedisSessionCache(redis, { ttlSeconds: 20 });
    const dbResolve = vi.fn(async () => makeResolved());

    const rawToken = 'raw-secret-token-value';
    const first = await cache.resolve(rawToken, dbResolve);
    const second = await cache.resolve(rawToken, dbResolve);

    expect(dbResolve).toHaveBeenCalledTimes(1);
    expect(first?.user.createdAt).toBeInstanceOf(Date);
    expect(second?.user.tierExpiresAt?.toISOString()).toBe('2027-01-01T00:00:00.000Z');
    const hashed = hashSessionTokenForCache(rawToken);
    expect(redis.store.has(sessionCacheKey(hashed))).toBe(true);
    expect(redis.store.has(rawToken)).toBe(false);
  });

  it('coalesces concurrent misses via single-flight deduplication', async () => {
    const redis = fakeRedis();
    const cache = createRedisSessionCache(redis, { ttlSeconds: 20 });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const dbResolve = vi.fn(async () => {
      await gate;
      return makeResolved();
    });

    const p1 = cache.resolve('tok-burst', dbResolve);
    const p2 = cache.resolve('tok-burst', dbResolve);
    const p3 = cache.resolve('tok-burst', dbResolve);
    release();
    const results = await Promise.all([p1, p2, p3]);

    expect(dbResolve).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r?.sessionId === 'sess-1')).toBe(true);
  });

  it('invalidates single token and user-wide sessions cleanly', async () => {
    const redis = fakeRedis();
    const cache = createRedisSessionCache(redis, { ttlSeconds: 20 });
    const dbResolve = vi.fn(async () => makeResolved('user-42'));

    await cache.resolve('tok-a', dbResolve);
    await cache.resolve('tok-b', dbResolve);
    expect(redis.sets.get(userSessionSetKey('user-42'))?.size).toBe(2);

    await cache.invalidateToken('tok-a');
    expect(redis.store.has(sessionCacheKey(hashSessionTokenForCache('tok-a')))).toBe(false);
    expect(redis.store.has(sessionCacheKey(hashSessionTokenForCache('tok-b')))).toBe(true);

    await cache.invalidateUser('user-42');
    expect(redis.store.has(sessionCacheKey(hashSessionTokenForCache('tok-b')))).toBe(false);
    expect(redis.sets.has(userSessionSetKey('user-42'))).toBe(false);
  });

  it('fails open to database resolution when Redis throws', async () => {
    const brokenRedis: SessionCacheRedis = {
      async get() { throw new Error('redis down'); },
      async set() { throw new Error('redis down'); },
      async del() { throw new Error('redis down'); },
      async sadd() { throw new Error('redis down'); },
      async smembers() { throw new Error('redis down'); },
      async expire() { throw new Error('redis down'); }
    };
    const cache = createRedisSessionCache(brokenRedis, { ttlSeconds: 20 });
    const dbResolve = vi.fn(async () => makeResolved());

    const res = await cache.resolve('tok-ok', dbResolve);
    expect(res?.user.id).toBe('user-1');
    await expect(cache.invalidateUser('user-1')).resolves.toBeUndefined();
  });

  it('prevents an in-flight DB lookup from writing stale data after concurrent invalidation', async () => {
    const redis = fakeRedis();
    const cache = createRedisSessionCache(redis, { ttlSeconds: 20 });
    let finishDb!: () => void;
    const dbGate = new Promise<void>((r) => { finishDb = r; });

    const pending = cache.resolve('tok-race', async () => {
      await dbGate;
      return makeResolved('user-race', 'free');
    });
    await new Promise((r) => setTimeout(r, 10));
    await cache.invalidateUser('user-race');
    finishDb();
    await pending;

    expect(redis.store.has(sessionCacheKey(hashSessionTokenForCache('tok-race')))).toBe(false);
  });
});
