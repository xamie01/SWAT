import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  attachPoolErrorHandler,
  buildDatabaseRuntimeConfig,
  createPoolCloser,
  installDatabaseShutdownHandlers,
  type DatabaseShutdownProcess
} from './client-runtime.js';

function createFakeProcess() {
  const listeners = new Map<NodeJS.Signals, () => void>();
  const processRef: DatabaseShutdownProcess = {
    once: vi.fn((signal, listener) => {
      listeners.set(signal, listener);
      return processRef;
    }),
    removeListener: vi.fn((signal, listener) => {
      if (listeners.get(signal) === listener) listeners.delete(signal);
      return processRef;
    }),
    exit: vi.fn()
  };
  return { listeners, processRef };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('database runtime configuration', () => {
  it('applies bounded defaults for pool and timeout behavior', () => {
    const config = buildDatabaseRuntimeConfig('postgresql://db', {});

    expect(config).toEqual({
      pool: {
        connectionString: 'postgresql://db',
        max: 10,
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 30_000,
        query_timeout: 60_000,
        statement_timeout: 60_000,
        idle_in_transaction_session_timeout: 60_000,
        allowExitOnIdle: true
      },
      shutdownTimeoutMs: 10_000
    });
  });

  it('accepts valid overrides and rejects invalid values', () => {
    const config = buildDatabaseRuntimeConfig('postgresql://db', {
      DB_POOL_MAX: '20',
      DB_CONNECTION_TIMEOUT_MS: '2500',
      DB_IDLE_TIMEOUT_MS: '45000',
      DB_QUERY_TIMEOUT_MS: '90000',
      DB_IDLE_TRANSACTION_TIMEOUT_MS: '120000',
      DB_SHUTDOWN_TIMEOUT_MS: '15000'
    });

    expect(config.pool).toMatchObject({
      max: 20,
      connectionTimeoutMillis: 2_500,
      idleTimeoutMillis: 45_000,
      query_timeout: 90_000,
      statement_timeout: 90_000,
      idle_in_transaction_session_timeout: 120_000
    });
    expect(config.shutdownTimeoutMs).toBe(15_000);
    expect(() => buildDatabaseRuntimeConfig('postgresql://db', {
      DB_POOL_MAX: '0'
    })).toThrow(/DB_POOL_MAX/);
    expect(() => buildDatabaseRuntimeConfig('postgresql://db', {
      DB_QUERY_TIMEOUT_MS: 'not-a-number'
    })).toThrow(/DB_QUERY_TIMEOUT_MS/);
  });
});

describe('database pool lifecycle', () => {
  it('handles idle-client errors without throwing from the event source', () => {
    let listener: ((error: Error) => void) | undefined;
    const source = {
      on: vi.fn((_event: 'error', callback: (error: Error) => void) => {
        listener = callback;
      })
    };
    const logError = vi.fn();

    attachPoolErrorHandler(source, logError);
    const error = new Error('connection reset');
    expect(() => listener?.(error)).not.toThrow();
    expect(logError).toHaveBeenCalledWith(
      '[db] unexpected error on an idle PostgreSQL client',
      error
    );
  });

  it('closes the pool once across concurrent callers', async () => {
    const end = vi.fn().mockResolvedValue(undefined);
    const close = createPoolCloser({ end });
    const first = close();
    const second = close();

    expect(first).toBe(second);
    await Promise.all([first, second]);
    expect(end).toHaveBeenCalledOnce();
  });

  it('closes once and exits cleanly on repeated shutdown signals', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const { listeners, processRef } = createFakeProcess();

    installDatabaseShutdownHandlers({
      close,
      timeoutMs: 5_000,
      processRef
    });
    listeners.get('SIGTERM')?.();
    listeners.get('SIGINT')?.();

    await vi.waitFor(() => {
      expect(close).toHaveBeenCalledOnce();
      expect(processRef.exit).toHaveBeenCalledOnce();
    });
    expect(processRef.exit).toHaveBeenCalledWith(0);
  });

  it('logs failed and timed-out shutdowns before exiting non-zero', async () => {
    const failed = createFakeProcess();
    const failure = new Error('close failed');
    const failureLog = vi.fn();

    installDatabaseShutdownHandlers({
      close: vi.fn(() => {
        throw failure;
      }),
      timeoutMs: 5_000,
      processRef: failed.processRef,
      logError: failureLog
    });
    failed.listeners.get('SIGINT')?.();

    await vi.waitFor(() => {
      expect(failureLog).toHaveBeenCalledWith(
        '[db] PostgreSQL pool shutdown failed (SIGINT)',
        failure
      );
    });
    expect(failed.processRef.exit).toHaveBeenCalledWith(1);

    vi.useFakeTimers();
    const timedOut = createFakeProcess();
    const timeoutLog = vi.fn();
    installDatabaseShutdownHandlers({
      close: vi.fn(() => new Promise<void>(() => {})),
      timeoutMs: 1_000,
      processRef: timedOut.processRef,
      logError: timeoutLog
    });
    timedOut.listeners.get('SIGTERM')?.();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(timeoutLog).toHaveBeenCalledWith(
      '[db] PostgreSQL pool shutdown timed out after 1000ms (SIGTERM)',
      expect.any(Error)
    );
    expect(timedOut.processRef.exit).toHaveBeenCalledWith(1);
  });
});
