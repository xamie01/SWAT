import type { UserScope } from '@swat/db';

export type UserCacheResource =
  | 'feed'
  | 'signals'
  | 'exec_settings'
  | 'wallets_list'
  | 'positions';

export const USER_CACHE_RESOURCES: readonly UserCacheResource[] = [
  'feed',
  'signals',
  'exec_settings',
  'wallets_list',
  'positions'
] as const;

export interface UserCacheRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
}

export interface UserReadCache {
  getOrLoad<T>(
    scope: UserScope,
    resource: UserCacheResource,
    loader: () => Promise<T>,
    options?: {
      readonly matchMeta?: unknown;
      readonly ttlSeconds?: number;
    }
  ): Promise<T>;
  invalidateUser(userId: string, resources?: readonly UserCacheResource[]): Promise<void>;
  invalidateUsers(userIds: readonly string[], resources?: readonly UserCacheResource[]): Promise<void>;
}

const KEY_PREFIX = 'swat:ucache:v1';

interface CachedEnvelope<T> {
  readonly v: T;
  readonly meta?: unknown;
}

function readTtlEnv(envKey: string, fallback: number): number {
  const raw = process.env[envKey];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

function defaultTtlFor(resource: UserCacheResource): number {
  switch (resource) {
    case 'feed':
      return readTtlEnv('USER_CACHE_FEED_TTL_SECONDS', 5);
    case 'signals':
      return readTtlEnv('USER_CACHE_SIGNALS_TTL_SECONDS', 5);
    case 'positions':
      return readTtlEnv('USER_CACHE_POSITIONS_TTL_SECONDS', 5);
    case 'wallets_list':
      return readTtlEnv('USER_CACHE_WALLETS_TTL_SECONDS', 10);
    case 'exec_settings':
      return readTtlEnv('USER_CACHE_SETTINGS_TTL_SECONDS', 15);
  }
}

function assertValidUserId(userId: string): void {
  if (typeof userId !== 'string' || !userId.trim() || userId.trim() === '*' || userId.includes(':')) {
    throw new Error('UserReadCache requires a concrete single-user id');
  }
}

export function userReadCacheKey(userId: string, resource: UserCacheResource): string {
  assertValidUserId(userId);
  return `${KEY_PREFIX}:${userId}:${resource}`;
}

export function createUserReadCache(
  redis: Partial<UserCacheRedis> | null | undefined,
  options: { readonly defaultTtls?: Partial<Record<UserCacheResource, number>> } = {}
): UserReadCache {
  const canReadWrite = Boolean(
    redis && typeof redis.get === 'function' && typeof redis.set === 'function'
  );
  const canDel = Boolean(redis && typeof redis.del === 'function');
  const inFlight = new Map<string, Promise<unknown>>();
  const epochs = new Map<string, number>();

  function resolveTtl(resource: UserCacheResource, override?: number): number {
    if (override !== undefined) {
      return Number.isFinite(override) && override > 0 ? Math.floor(override) : 0;
    }
    const fromOpts = options.defaultTtls?.[resource];
    if (fromOpts !== undefined) {
      return Number.isFinite(fromOpts) && fromOpts > 0 ? Math.floor(fromOpts) : 0;
    }
    return defaultTtlFor(resource);
  }

  return {
    async getOrLoad<T>(
      scope: UserScope,
      resource: UserCacheResource,
      loader: () => Promise<T>,
      callOptions: { readonly matchMeta?: unknown; readonly ttlSeconds?: number } = {}
    ): Promise<T> {
      if (!scope || typeof scope.userId !== 'string' || scope.userId.trim() === '*') {
        throw new Error('UserReadCache refused cross-tenant scope');
      }
      const key = userReadCacheKey(scope.userId, resource);
      const ttlSeconds = resolveTtl(resource, callOptions.ttlSeconds);
      if (ttlSeconds <= 0) {
        return loader();
      }

      const startEpoch = epochs.get(key) ?? 0;

      if (canReadWrite && redis?.get) {
        try {
          const raw = await redis.get(key);
          if ((epochs.get(key) ?? 0) === startEpoch && raw) {
            const parsed = JSON.parse(raw) as CachedEnvelope<T>;
            if (
              parsed
              && typeof parsed === 'object'
              && 'v' in parsed
              && (callOptions.matchMeta === undefined || parsed.meta === callOptions.matchMeta)
            ) {
              return parsed.v;
            }
          }
        } catch {
          // Fail open to Postgres loader if cache Redis is unavailable or corrupt.
        }
      }

      const flightKey =
        callOptions.matchMeta === undefined ? key : `${key}::${String(callOptions.matchMeta)}`;
      const existing = inFlight.get(flightKey) as Promise<T> | undefined;
      if (existing) {
        return existing;
      }

      const pending = (async (): Promise<T> => {
        const loaded = await loader();
        // Do not populate Redis if this tenant resource was invalidated while Postgres query was in flight.
        if ((epochs.get(key) ?? 0) === startEpoch && canReadWrite && redis?.set) {
          try {
            const envelope: CachedEnvelope<T> =
              callOptions.matchMeta === undefined
                ? { v: loaded }
                : { v: loaded, meta: callOptions.matchMeta };
            await redis.set(key, JSON.stringify(envelope), 'EX', ttlSeconds);
          } catch {
            // Non-fatal: cache write failure must not abort user reads.
          }
        }
        return loaded;
      })();

      inFlight.set(flightKey, pending);
      try {
        return await pending;
      } finally {
        if (inFlight.get(flightKey) === pending) {
          inFlight.delete(flightKey);
        }
      }
    },

    async invalidateUser(
      userId: string,
      resources: readonly UserCacheResource[] = USER_CACHE_RESOURCES
    ): Promise<void> {
      assertValidUserId(userId);
      if (resources.length === 0) return;

      const keys: string[] = [];
      for (const resource of resources) {
        const key = userReadCacheKey(userId, resource);
        epochs.set(key, (epochs.get(key) ?? 0) + 1);
        for (const flightKey of inFlight.keys()) {
          if (flightKey === key || flightKey.startsWith(`${key}::`)) {
            inFlight.delete(flightKey);
          }
        }
        keys.push(key);
      }

      if (canDel && redis?.del && keys.length > 0) {
        try {
          await redis.del(...keys);
        } catch {
          // Non-fatal; epoch bump still prevents local stale cache writes.
        }
      }
    },

    async invalidateUsers(
      userIds: readonly string[],
      resources: readonly UserCacheResource[] = USER_CACHE_RESOURCES
    ): Promise<void> {
      const unique = [...new Set(userIds)].filter((id) => Boolean(id && id.trim() && id !== '*'));
      if (unique.length === 0 || resources.length === 0) return;

      const keys: string[] = [];
      for (const userId of unique) {
        for (const resource of resources) {
          const key = userReadCacheKey(userId, resource);
          epochs.set(key, (epochs.get(key) ?? 0) + 1);
          for (const flightKey of inFlight.keys()) {
            if (flightKey === key || flightKey.startsWith(`${key}::`)) {
              inFlight.delete(flightKey);
            }
          }
          keys.push(key);
        }
      }

      if (canDel && redis?.del && keys.length > 0) {
        try {
          await redis.del(...keys);
        } catch {
          // Non-fatal.
        }
      }
    }
  };
}
