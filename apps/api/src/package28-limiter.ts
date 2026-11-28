import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isIP } from 'node:net';

export interface Package28LimiterConfig {
  readonly max: number;
  readonly authIpMax: number;
  readonly authAccountMax: number;
  readonly trustedProxy: string | null;
}

function bounded(env: Record<string, string | undefined>, name: string, fallback: number, cap: number): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > cap) {
    throw new Error(`${name} must be an integer between 1 and ${cap}`);
  }
  return Number(raw);
}

export function loadPackage28LimiterConfig(env: Record<string, string | undefined>): Package28LimiterConfig {
  const proxy = env.RATE_LIMIT_TRUSTED_PROXY;
  if (proxy !== undefined && (!isIP(proxy) || proxy === '0.0.0.0' || proxy === '::')) {
    throw new Error('RATE_LIMIT_TRUSTED_PROXY must be one exact non-wildcard IP address');
  }
  return Object.freeze({
    max: bounded(env, 'RATE_LIMIT_MAX', 300, 10000),
    authIpMax: bounded(env, 'AUTH_RATE_LIMIT_MAX', 10, 1000),
    authAccountMax: bounded(env, 'AUTH_ACCOUNT_RATE_LIMIT_MAX', 10, 1000),
    trustedProxy: proxy ?? null
  });
}

// The API imports this module first: reject invalid limiter settings before
// later static dependencies (notably @swat/db) construct runtime clients.
loadPackage28LimiterConfig(process.env);

export function package28TrustProxy(config: Package28LimiterConfig): false | ((address: string, hop: number) => boolean) {
  if (config.trustedProxy === null) return false;
  return (address, hop) => hop === 0 && address === config.trustedProxy;
}

function credentialEndpoint(request: FastifyRequest): boolean {
  const path = request.url.split('?')[0];
  return path?.startsWith('/v1/auth/') === true
    && path !== '/v1/auth/me'
    && !path.startsWith('/v1/auth/wallet/');
}

function normalizedAccount(request: FastifyRequest): string | null {
  const body = request.body;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const email = (body as { email?: unknown }).email;
  if (typeof email !== 'string' || email.length > 320) return null;
  return email.trim().toLowerCase() || null;
}

export async function registerPackage28Limiters(app: FastifyInstance, config: Package28LimiterConfig): Promise<void> {
  // Opt-in distributed Redis rate limiting (Wave 4b): dynamic import preserves
  // zero eager Redis/DB side effects at module load time while sharing buckets across workers.
  let limiterRedis: { quit(): Promise<unknown> } | undefined;
  if (process.env.RATE_LIMIT_USE_REDIS === 'true' && process.env.REDIS_URL) {
    const { Redis } = await import('ioredis');
    const client = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2 });
    limiterRedis = client;
    app.addHook('onClose', async () => {
      await client.quit().catch(() => undefined);
    });
  }

  // Register once, then use independent child stores. rateLimit() handlers share a
  // per-request "already ran" symbol; createRateLimit() does not skip later phases.
  await app.register(rateLimit, {
    global: false,
    skipOnError: false,
    cache: 10000,
    ...(limiterRedis ? { redis: limiterRedis, nameSpace: 'swat:rl:' } : {})
  });
  const globalIp = app.createRateLimit({ max: config.max, timeWindow: 60000, keyGenerator: request => request.ip });
  const authIp = app.createRateLimit({ max: config.authIpMax, timeWindow: 900000, keyGenerator: request => request.ip });
  const account = app.createRateLimit({ max: config.authAccountMax, timeWindow: 900000,
    keyGenerator: request => normalizedAccount(request) ?? '' });
  async function enforce(request: FastifyRequest, reply: FastifyReply, limiter: typeof globalIp) {
    const result = await limiter(request);
    if (!result.isAllowed && result.isExceeded) {
      reply.header('Retry-After', result.ttlInSeconds);
      await reply.code(429).send({ statusCode: 429, error: 'Too Many Requests', message: 'Rate limit exceeded' });
    }
  }
  app.addHook('onRequest', async (request, reply) => {
    await enforce(request, reply, globalIp);
    if (!reply.sent && credentialEndpoint(request)) await enforce(request, reply, authIp);
  });
  app.addHook('preValidation', async (request, reply) => {
    if (credentialEndpoint(request) && normalizedAccount(request) !== null) await enforce(request, reply, account);
  });
}
