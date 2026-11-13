/**
 * SWAT Unified System Logger
 * 
 * Hijacks console.log and console.error globally.
 * Logs are automatically printed to the terminal (so ./start.sh works as usual)
 * and sent to Redis to be streamed on the dashboard live log panel.
 */
import { Redis } from 'ioredis';
import { inspect } from 'node:util';
import { redactLogValue } from './redaction.js';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const MAX_LOG_MESSAGE_LENGTH = 20_000;
let redis: Redis | null = null;
let currentService = 'unknown';

const originalLog = console.log;
const originalError = console.error;

export function serializeLogArgument(value: unknown): string {
  try {
    value = redactLogValue(value);
    if (typeof value === 'string') return value;
    if (typeof value === 'bigint') return `${value}n`;
    if (
      (typeof value === 'object' && value !== null)
      || typeof value === 'function'
    ) {
      return inspect(value, {
        breakLength: Infinity,
        compact: true,
        customInspect: false,
        depth: 6,
        getters: false,
        maxArrayLength: 100,
        maxStringLength: 10_000
      });
    }
    return String(value);
  } catch {
    try {
      return `[Unserializable ${Object.prototype.toString.call(value)}]`;
    } catch {
      return '[Unserializable value]';
    }
  }
}

export function serializeLogArguments(args: unknown[]): string {
  try {
    const message = args.map(serializeLogArgument).join(' ');
    if (message.length <= MAX_LOG_MESSAGE_LENGTH) return message;
    return `${message.slice(0, MAX_LOG_MESSAGE_LENGTH)}...[truncated]`;
  } catch {
    return '[Log serialization failed]';
  }
}

function getRedisInstance(): Redis {
  if (!redis) {
    redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
    redis.on('error', (err: any) => {
      // Print directly to console without looping
      originalError('[logger-internal] Redis connection error');
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
    originalError('[logger-internal] Failed to publish log');
  }
}

/**
 * Intercepts console output globally for this service.
 */
export function initLogger(serviceName: string) {
  currentService = serviceName;

  console.log = (...args: any[]) => {
    const message = serializeLogArguments(args);
    originalLog(message);
    // Avoid double logging redis errors or our own internal hooks
    if (message.startsWith('[logger-internal]')) return;
    publishToRedis('info', message);
  };

  console.error = (...args: any[]) => {
    const message = serializeLogArguments(args);
    originalError(message);
    if (message.startsWith('[logger-internal]')) return;
    publishToRedis('error', message);
  };

  originalLog(`[logger-internal] Registered console interceptor for service: ${serviceName}`);
}
