import type { PoolConfig } from 'pg';

const DEFAULT_POOL_MAX = 10;
const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_QUERY_TIMEOUT_MS = 60_000;
const DEFAULT_IDLE_TRANSACTION_TIMEOUT_MS = 60_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

type Environment = Record<string, string | undefined>;

export type DatabaseRuntimeConfig = {
  pool: PoolConfig;
  shutdownTimeoutMs: number;
};

type PoolErrorSource = {
  on(event: 'error', listener: (error: Error) => void): unknown;
};

type ClosablePool = {
  end(): Promise<void>;
};

export type DatabaseShutdownProcess = {
  once(signal: NodeJS.Signals, listener: () => void): unknown;
  removeListener(signal: NodeJS.Signals, listener: () => void): unknown;
  exit(code: number): void;
};

type ShutdownOptions = {
  close: () => Promise<void>;
  timeoutMs: number;
  processRef?: DatabaseShutdownProcess;
  logError?: (message: string, error: unknown) => void;
};

function readBoundedInteger(
  env: Environment,
  name: string,
  fallback: number,
  min: number,
  max: number
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;

  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

export function buildDatabaseRuntimeConfig(
  databaseUrl: string,
  env: Environment = process.env
): DatabaseRuntimeConfig {
  const poolMax = readBoundedInteger(env, 'DB_POOL_MAX', DEFAULT_POOL_MAX, 1, 100);
  const connectionTimeoutMs = readBoundedInteger(
    env,
    'DB_CONNECTION_TIMEOUT_MS',
    DEFAULT_CONNECTION_TIMEOUT_MS,
    100,
    120_000
  );
  const idleTimeoutMs = readBoundedInteger(
    env,
    'DB_IDLE_TIMEOUT_MS',
    DEFAULT_IDLE_TIMEOUT_MS,
    1_000,
    600_000
  );
  const queryTimeoutMs = readBoundedInteger(
    env,
    'DB_QUERY_TIMEOUT_MS',
    DEFAULT_QUERY_TIMEOUT_MS,
    1_000,
    900_000
  );
  const idleTransactionTimeoutMs = readBoundedInteger(
    env,
    'DB_IDLE_TRANSACTION_TIMEOUT_MS',
    DEFAULT_IDLE_TRANSACTION_TIMEOUT_MS,
    1_000,
    900_000
  );
  const shutdownTimeoutMs = readBoundedInteger(
    env,
    'DB_SHUTDOWN_TIMEOUT_MS',
    DEFAULT_SHUTDOWN_TIMEOUT_MS,
    1_000,
    60_000
  );

  const isPgBouncer = env.DB_PGBOUNCER === 'true' || databaseUrl.includes(':6432');

  return {
    pool: {
      connectionString: databaseUrl,
      max: poolMax,
      connectionTimeoutMillis: connectionTimeoutMs,
      idleTimeoutMillis: idleTimeoutMs,
      query_timeout: queryTimeoutMs,
      statement_timeout: isPgBouncer ? undefined : queryTimeoutMs,
      idle_in_transaction_session_timeout: isPgBouncer ? undefined : idleTransactionTimeoutMs,
      allowExitOnIdle: true,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000
    },
    shutdownTimeoutMs
  };
}

export function attachPoolErrorHandler(
  source: PoolErrorSource,
  logError: (message: string, error: unknown) => void = console.error
): void {
  source.on('error', (error) => {
    logError('[db] unexpected error on an idle PostgreSQL client', error);
  });
}

export function createPoolCloser(pool: ClosablePool): () => Promise<void> {
  let closePromise: Promise<void> | null = null;

  return () => {
    closePromise ??= Promise.resolve().then(() => pool.end());
    return closePromise;
  };
}

export function installDatabaseShutdownHandlers({
  close,
  timeoutMs,
  processRef = process,
  logError = console.error
}: ShutdownOptions): () => void {
  let shuttingDown = false;

  const startShutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    let finished = false;

    const finish = (code: number) => {
      if (finished) return;
      finished = true;
      clearTimeout(forceTimer);
      processRef.exit(code);
    };

    const forceTimer = setTimeout(() => {
      logError(
        `[db] PostgreSQL pool shutdown timed out after ${timeoutMs}ms (${signal})`,
        new Error('Database shutdown timeout')
      );
      finish(1);
    }, timeoutMs);
    forceTimer.unref?.();

    void Promise.resolve().then(close).then(
      () => finish(0),
      (error) => {
        logError(`[db] PostgreSQL pool shutdown failed (${signal})`, error);
        finish(1);
      }
    );
  };

  const onSigint = () => startShutdown('SIGINT');
  const onSigterm = () => startShutdown('SIGTERM');
  processRef.once('SIGINT', onSigint);
  processRef.once('SIGTERM', onSigterm);

  return () => {
    processRef.removeListener('SIGINT', onSigint);
    processRef.removeListener('SIGTERM', onSigterm);
  };
}
