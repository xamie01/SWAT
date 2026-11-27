import { createHash } from 'node:crypto';
import type { ResolvedSession, UserRecord } from '@swat/db/dist/users.js';

export interface SessionCacheRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
  sadd(key: string, ...members: string[]): Promise<unknown>;
  smembers(key: string): Promise<string[]>;
  expire(key: string, seconds: number): Promise<unknown>;
}

export interface SessionCacheOptions {
  /** Cache entry TTL in seconds (0 disables caching). Defaults to `20`. */
  readonly ttlSeconds?: number;
}

export interface SessionCache {
  readonly ttlSeconds: number;
  resolve(
    token: string,
    dbResolve: (token: string) => Promise<ResolvedSession | null>
  ): Promise<ResolvedSession | null>;
  invalidateToken(token: string): Promise<void>;
  invalidateUser(userId: string): Promise<void>;
  invalidateUsers(userIds: readonly string[]): Promise<void>;
}

interface SerializedSession {
  readonly sessionId: string;
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly displayName: string | null;
    readonly role: UserRecord['role'];
    readonly tier: UserRecord['tier'];
    readonly tierExpiresAt: string | null;
    readonly status: UserRecord['status'];
    readonly createdAt: string;
  };
}

const SESSION_KEY_PREFIX = 'swat:auth:sess:';
const USER_SESSIONS_KEY_PREFIX = 'swat:auth:user_sess:';

export function hashSessionTokenForCache(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function sessionCacheKey(tokenHash: string): string {
  return `${SESSION_KEY_PREFIX}${tokenHash}`;
}

export function userSessionSetKey(userId: string): string {
  return `${USER_SESSIONS_KEY_PREFIX}${userId}`;
}

function serializeSession(resolved: ResolvedSession): string {
  const payload: SerializedSession = {
    sessionId: resolved.sessionId,
    user: {
      id: resolved.user.id,
      email: resolved.user.email,
      displayName: resolved.user.displayName,
      role: resolved.user.role,
      tier: resolved.user.tier,
      tierExpiresAt: resolved.user.tierExpiresAt ? resolved.user.tierExpiresAt.toISOString() : null,
      status: resolved.user.status,
      createdAt: resolved.user.createdAt.toISOString()
    }
  };
  return JSON.stringify(payload);
}

function deserializeSession(raw: string): ResolvedSession | null {
  try {
    const parsed = JSON.parse(raw) as SerializedSession;
    if (!parsed || typeof parsed.sessionId !== 'string' || !parsed.user || typeof parsed.user.id !== 'string') {
      return null;
    }
    const createdAt = new Date(parsed.user.createdAt);
    const tierExpiresAt = parsed.user.tierExpiresAt ? new Date(parsed.user.tierExpiresAt) : null;
    if (Number.isNaN(createdAt.getTime())) return null;
    if (tierExpiresAt && Number.isNaN(tierExpiresAt.getTime())) return null;
    return {
      sessionId: parsed.sessionId,
      user: {
        id: parsed.user.id,
        email: parsed.user.email,
        displayName: parsed.user.displayName ?? null,
        role: parsed.user.role,
        tier: parsed.user.tier,
        tierExpiresAt,
        status: parsed.user.status,
        createdAt
      }
    };
  } catch {
    return null;
  }
}

export async function invalidateCachedUserSessions(
  redis: Pick<SessionCacheRedis, 'smembers' | 'del'>,
  userId: string
): Promise<void> {
  if (!userId) return;
  const setKey = userSessionSetKey(userId);
  try {
    const hashes = await redis.smembers(setKey);
    const keys = [setKey, ...hashes.map((hash) => sessionCacheKey(hash))];
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  } catch {
    // Redis invalidation failure must not block auth/billing state changes; short TTL bounds staleness.
  }
}

export function createRedisSessionCache(
  redis: Partial<SessionCacheRedis> | null | undefined,
  options: SessionCacheOptions = {}
): SessionCache {
  const configuredTtl = options.ttlSeconds ?? Number(process.env.AUTH_SESSION_CACHE_TTL_SECONDS ?? 20);
  const ttlSeconds = Number.isFinite(configuredTtl) && configuredTtl > 0 ? Math.floor(configuredTtl) : 0;
  const hasRedis = Boolean(
    ttlSeconds > 0
    && redis
    && typeof redis.get === 'function'
    && typeof redis.set === 'function'
    && typeof redis.del === 'function'
  );

  // Coalesce concurrent cold lookups for the same token and prevent pre-invalidation
  // DB reads from writing stale snapshots into Redis.
  const inFlight = new Map<string, Promise<ResolvedSession | null>>();
  let globalEpoch = 0;

  async function writeThrough(tokenHash: string, resolved: ResolvedSession): Promise<void> {
    if (!hasRedis || !redis?.set || !redis?.del) return;
    try {
      const ops: Promise<unknown>[] = [
        redis.set(sessionCacheKey(tokenHash), serializeSession(resolved), 'EX', ttlSeconds)
      ];
      if (typeof redis.sadd === 'function' && typeof redis.expire === 'function') {
        const setKey = userSessionSetKey(resolved.user.id);
        ops.push(redis.sadd(setKey, tokenHash), redis.expire(setKey, ttlSeconds + 60));
      }
      await Promise.all(ops);
    } catch {
      // Cache write failure is non-fatal; DB remains source of truth.
    }
  }

  return {
    ttlSeconds,
    async resolve(token, dbResolve) {
      if (!token) return null;
      const tokenHash = hashSessionTokenForCache(token);

      if (hasRedis && redis?.get) {
        try {
          const cached = await redis.get(sessionCacheKey(tokenHash));
          if (cached) {
            const parsed = deserializeSession(cached);
            if (parsed) return parsed;
          }
        } catch {
          // Fall open to DB lookup on Redis read errors.
        }
      }

      const existing = inFlight.get(tokenHash);
      if (existing) return existing;

      const startEpoch = globalEpoch;
      const pending = (async () => {
        const resolved = await dbResolve(token);
        if (resolved && resolved.user.status === 'active' && hasRedis && globalEpoch === startEpoch) {
          await writeThrough(tokenHash, resolved);
        }
        return resolved;
      })();

      inFlight.set(tokenHash, pending);
      try {
        return await pending;
      } finally {
        if (inFlight.get(tokenHash) === pending) {
          inFlight.delete(tokenHash);
        }
      }
    },

    async invalidateToken(token) {
      globalEpoch += 1;
      if (!token || !redis?.del) return;
      const tokenHash = hashSessionTokenForCache(token);
      inFlight.delete(tokenHash);
      try {
        await redis.del(sessionCacheKey(tokenHash));
      } catch {
        // Non-fatal; TTL bounds exposure.
      }
    },

    async invalidateUser(userId) {
      globalEpoch += 1;
      inFlight.clear();
      if (!userId || !redis?.smembers || !redis?.del) return;
      await invalidateCachedUserSessions(redis as Pick<SessionCacheRedis, 'smembers' | 'del'>, userId);
    },

    async invalidateUsers(userIds) {
      globalEpoch += 1;
      inFlight.clear();
      if (!userIds.length || !redis?.smembers || !redis?.del) return;
      await Promise.all(
        userIds.map((userId) => invalidateCachedUserSessions(redis as Pick<SessionCacheRedis, 'smembers' | 'del'>, userId))
      );
    }
  };
}
