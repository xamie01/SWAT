import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createUserReadCache, userReadCacheKey } from './user-read-cache.js';

function scope(userId: string) {
  return { userId } as any;
}

function mockRedis() {
  const store = new Map<string, string>();
  const get = vi.fn(async (key: string) => store.get(key) ?? null);
  const set = vi.fn(async (key: string, value: string, _mode: 'EX', _seconds: number) => {
    store.set(key, value);
    return 'OK';
  });
  const del = vi.fn(async (...keys: string[]) => {
    let removed = 0;
    for (const key of keys) {
      if (store.delete(key)) removed += 1;
    }
    return removed;
  });
  return { store, get, set, del };
}

describe('UserReadCache (tenant isolation & read-after-write)', () => {
  it('strictly isolates cached reads by userId and never leaks across tenants', async () => {
    const redis = mockRedis();
    const cache = createUserReadCache(redis, { defaultTtls: { feed: 5 } });

    const alice = '11111111-1111-4111-8111-111111111111';
    const bob = '22222222-2222-4222-8222-222222222222';

    const aliceLoad = vi.fn(async () => ({ events: [{ id: 'evt-alice' }] }));
    const bobLoad = vi.fn(async () => ({ events: [{ id: 'evt-bob' }] }));

    expect(await cache.getOrLoad(scope(alice), 'feed', aliceLoad)).toEqual({
      events: [{ id: 'evt-alice' }]
    });
    expect(await cache.getOrLoad(scope(alice), 'feed', aliceLoad)).toEqual({
      events: [{ id: 'evt-alice' }]
    });
    expect(aliceLoad).toHaveBeenCalledTimes(1);

    expect(await cache.getOrLoad(scope(bob), 'feed', bobLoad)).toEqual({
      events: [{ id: 'evt-bob' }]
    });
    expect(bobLoad).toHaveBeenCalledTimes(1);
    expect(redis.store.has(userReadCacheKey(alice, 'feed'))).toBe(true);
    expect(redis.store.has(userReadCacheKey(bob, 'feed'))).toBe(true);
  });

  it('refuses cross-tenant wildcard scope', async () => {
    const cache = createUserReadCache(mockRedis());
    await expect(cache.getOrLoad(scope('*'), 'feed', async () => ({ events: [] }))).rejects.toThrow(
      /cross-tenant/i
    );
  });

  it('invalidates user resources synchronously before returning read-after-write consistency', async () => {
    const redis = mockRedis();
    const cache = createUserReadCache(redis, { defaultTtls: { exec_settings: 15 } });
    const userId = '33333333-3333-4333-8333-333333333333';

    let version = 1;
    const loader = vi.fn(async () => ({ maxPositionPct: version * 5 }));

    expect(await cache.getOrLoad(scope(userId), 'exec_settings', loader)).toEqual({ maxPositionPct: 5 });
    expect(await cache.getOrLoad(scope(userId), 'exec_settings', loader)).toEqual({ maxPositionPct: 5 });
    expect(loader).toHaveBeenCalledTimes(1);

    // Mutate DB and synchronously invalidate cache before next read
    version = 2;
    await cache.invalidateUser(userId, ['exec_settings']);

    expect(await cache.getOrLoad(scope(userId), 'exec_settings', loader)).toEqual({ maxPositionPct: 10 });
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('does not write stale in-flight Postgres result if invalidated concurrently', async () => {
    const redis = mockRedis();
    const cache = createUserReadCache(redis, { defaultTtls: { signals: 5 } });
    const userId = '44444444-4444-4444-8444-444444444444';

    let releaseRead!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });

    const staleRead = cache.getOrLoad(
      scope(userId),
      'signals',
      async () => {
        await gate;
        return { signals: ['stale'] };
      },
      { matchMeta: 300 }
    );

    // Commit happens while staleRead is still waiting on Postgres
    await cache.invalidateUser(userId, ['signals']);
    releaseRead();
    await staleRead;

    // Key must remain absent in Redis so subsequent read hits fresh DB state
    expect(redis.store.has(userReadCacheKey(userId, 'signals'))).toBe(false);

    const fresh = await cache.getOrLoad(
      scope(userId),
      'signals',
      async () => ({ signals: ['fresh'] }),
      { matchMeta: 300 }
    );
    expect(fresh).toEqual({ signals: ['fresh'] });
  });

  it('misses when matchMeta changes (e.g., tier signalDelaySeconds upgrade)', async () => {
    const redis = mockRedis();
    const cache = createUserReadCache(redis, { defaultTtls: { signals: 5 } });
    const userId = '55555555-5555-4555-8555-555555555555';

    const delayed = await cache.getOrLoad(
      scope(userId),
      'signals',
      async () => ({ delayedSeconds: 300 }),
      { matchMeta: 300 }
    );
    expect(delayed).toEqual({ delayedSeconds: 300 });

    const realtime = await cache.getOrLoad(
      scope(userId),
      'signals',
      async () => ({ delayedSeconds: 0 }),
      { matchMeta: 0 }
    );
    expect(realtime).toEqual({ delayedSeconds: 0 });
  });

  it('degrades cleanly (fails open) when Redis throws', async () => {
    const cache = createUserReadCache({
      get: async () => {
        throw new Error('ECONNRESET');
      },
      set: async () => {
        throw new Error('ECONNRESET');
      },
      del: async () => {
        throw new Error('ECONNRESET');
      }
    });
    const userId = createHash('sha256').update('u').digest('hex').slice(0, 32);
    const loaded = await cache.getOrLoad(scope(userId), 'positions', async () => ({ positions: [] }));
    expect(loaded).toEqual({ positions: [] });
    await expect(cache.invalidateUser(userId, ['positions'])).resolves.toBeUndefined();
  });
});
