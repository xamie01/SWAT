import { describe, expect, it, vi } from 'vitest';
import { createSharedReadCache, type SharedCacheRedis } from './shared-cache.js';

function fakeSharedRedis(): SharedCacheRedis & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async get(key) {
      return store.get(key) ?? null;
    },
    async set(key, value) {
      store.set(key, value);
      return 'OK';
    },
    async mget(...keys) {
      return keys.map((k) => store.get(k) ?? null);
    }
  };
}

describe('SharedReadCache', () => {
  it('coalesces concurrent master list loads and serves subsequent hits from Redis', async () => {
    const redis = fakeSharedRedis();
    const cache = createSharedReadCache(redis, { ttlSeconds: 12 });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const loader = vi.fn(async () => {
      await gate;
      return [{ address: 'solana:m1', chain: 'solana', nickname: 'Alpha', composite_score: 95, tier: 'pro', win_rate: 0.7, realized_roi: 1.5 }];
    });

    const p1 = cache.getMastersTop20(loader);
    const p2 = cache.getMastersTop20(loader);
    release();
    const [r1, r2] = await Promise.all([p1, p2]);
    const r3 = await cache.getMastersTop20(loader);

    expect(loader).toHaveBeenCalledTimes(1);
    expect(r1).toHaveLength(1);
    expect(r2[0].address).toBe('solana:m1');
    expect(r3[0].address).toBe('solana:m1');
  });

  it('fetches only missing wallet stats across Redis mget partial hits', async () => {
    const redis = fakeSharedRedis();
    const cache = createSharedReadCache(redis, { ttlSeconds: 12 });
    const loader = vi.fn(async (missing: string[]) =>
      missing.map((address) => ({
        address,
        chain: 'solana' as const,
        status: 'active',
        composite_score: 88,
        tier: 'pro',
        win_rate: 0.65,
        realized_roi: 0.9,
        total_trades: 42,
        last_active: null
      }))
    );

    const first = await cache.getWalletStats(['solana:w1'], loader);
    expect(first).toHaveLength(1);
    expect(loader).toHaveBeenCalledWith(['solana:w1']);

    const second = await cache.getWalletStats(['solana:w1', 'solana:w2'], loader);
    expect(second.map((r) => r.address)).toEqual(['solana:w1', 'solana:w2']);
    expect(loader).toHaveBeenCalledTimes(2);
    expect(loader).toHaveBeenLastCalledWith(['solana:w2']);
  });

  it('falls open to Postgres loader when Redis throws', async () => {
    const brokenRedis: SharedCacheRedis = {
      async get() { throw new Error('redis down'); },
      async set() { throw new Error('redis down'); },
      async mget() { throw new Error('redis down'); }
    };
    const cache = createSharedReadCache(brokenRedis, { ttlSeconds: 12 });
    const masters = await cache.getMastersTop20(async () => [
      { address: 'solana:m1', chain: 'solana', nickname: null, composite_score: 80, tier: 'pro', win_rate: null, realized_roi: null }
    ]);
    expect(masters).toHaveLength(1);
  });
});
