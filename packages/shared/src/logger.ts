/**
 * SWAT Unified System Logger
 * 
 * Hijacks console.log and console.error globally.
 * Logs are automatically printed to the terminal (so ./start.sh works as usual)
 * and sent to Redis to be streamed on the dashboard live log panel.
 */
import { Redis } from 'ioredis';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
let redis: Redis | null = null;
let currentService = 'unknown';

const originalLog = console.log;
const originalError = console.error;

function getRedisInstance(): Redis {
  if (!redis) {
    redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
    redis.on('error', (err: any) => {
      // Print directly to console without looping
      originalError(`[logger-internal] Redis connection error: ${err.message}`);
    });
  }
  return redis;
}

function publishToRedis(level: 'info' | 'error', message: string) {
  try {
    const client = getRedisInstance();
    const logItem = {
      timestamp: new Date().toISOString(),
      service: currentService,
      level,
      message
    };
    const logStr = JSON.stringify(logItem);

    // Push to list and trim to keep last 500 entries
    client.lpush('swat:logs:list', logStr).then(() => {
      client.ltrim('swat:logs:list', 0, 499).catch(() => {});
    }).catch(() => {});

    // Publish to live pub/sub stream channel
    client.publish('swat:logs:stream', logStr).catch(() => {});
  } catch (err: any) {
    originalError(`[logger-internal] Failed to publish log: ${err.message}`);
  }
}

/**
 * Intercepts console output globally for this service.
 */
export function initLogger(serviceName: string) {
  currentService = serviceName;

  console.log = (...args: any[]) => {
    originalLog(...args);
    const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
    // Avoid double logging redis errors or our own internal hooks
    if (message.startsWith('[logger-internal]')) return;
    publishToRedis('info', message);
  };

  console.error = (...args: any[]) => {
    originalError(...args);
    const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
    if (message.startsWith('[logger-internal]')) return;
    publishToRedis('error', message);
  };

  originalLog(`[logger-internal] Registered console interceptor for service: ${serviceName}`);
}
