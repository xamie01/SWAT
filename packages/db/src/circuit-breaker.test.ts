import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const clientQuery = vi.fn();
  const release = vi.fn();
  return {
    clientQuery,
    release,
    // `on`/`off`: a real PoolClient is an EventEmitter, and withTransaction
    // attaches an 'error' listener so a mid-transaction socket failure cannot
    // crash the process. transaction.test.ts covers that behaviour itself.
    connect: vi.fn(async () => ({ query: clientQuery, release, on: vi.fn(), off: vi.fn() })),
    query: vi.fn()
  };
});

vi.mock('./client.js', () => ({
  pool: { connect: mocks.connect },
  query: mocks.query
}));

import {
  claimCircuitBreakerProbe,
  CircuitBreakerStateCorruptionError,
  readCircuitBreakerState,
  recordCircuitBreakerFailure,
  recordCircuitBreakerSuccess
} from './circuit-breaker.js';

describe('database circuit breaker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.query.mockResolvedValue([]);
    mocks.clientQuery.mockImplementation(async (sql: string) => ({
      rows: sql.includes('SELECT value')
        ? [{ value: { consecutiveFailures: 0, trippedAt: null } }]
        : []
    }));
  });

  it('reads the chain-specific persisted state without process-local caching', async () => {
    mocks.query
      .mockResolvedValueOnce([{
        value: { consecutiveFailures: 2, trippedAt: null }
      }])
      .mockResolvedValueOnce([{
        value: { consecutiveFailures: 3, trippedAt: '2026-07-27T10:00:00.000Z' }
      }]);

    await expect(readCircuitBreakerState('operator', 'polygon')).resolves.toEqual({
      consecutiveFailures: 2,
      trippedAt: null
    });
    await expect(readCircuitBreakerState('operator', 'polygon')).resolves.toEqual({
      consecutiveFailures: 3,
      trippedAt: '2026-07-27T10:00:00.000Z'
    });
    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(mocks.query).toHaveBeenCalledWith(expect.any(String), ['breaker:operator:polygon']);
  });

  it.each([
    null,
    [],
    { consecutiveFailures: -1, trippedAt: null },
    { consecutiveFailures: 1.5, trippedAt: null },
    { consecutiveFailures: 1, trippedAt: 'not-a-date' },
    { consecutiveFailures: 1, trippedAt: null, open: true }
  ])('fails closed when stored state is malformed: %j', async (value) => {
    mocks.query.mockResolvedValue([{ value }]);

    await expect(readCircuitBreakerState('operator', 'solana')).rejects.toBeInstanceOf(
      CircuitBreakerStateCorruptionError
    );
  });

  it('fails closed when the migrated chain key is missing', async () => {
    mocks.query.mockResolvedValue([]);

    await expect(readCircuitBreakerState('operator', 'robinhood-chain')).rejects.toBeInstanceOf(
      CircuitBreakerStateCorruptionError
    );
  });

  it('increments under a row lock and trips at the exact threshold', async () => {
    const failedAt = new Date('2026-07-27T12:34:56.789Z');
    mocks.clientQuery.mockImplementation(async (sql: string) => ({
      rows: sql.includes('SELECT value')
        ? [{ value: { consecutiveFailures: 2, trippedAt: null } }]
        : []
    }));

    await expect(
      recordCircuitBreakerFailure('operator', 'robinhood-chain', 3, failedAt)
    ).resolves.toEqual({
      consecutiveFailures: 3,
      trippedAt: failedAt.toISOString()
    });

    expect(mocks.clientQuery.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      expect.stringContaining('FOR UPDATE'),
      expect.stringContaining('UPDATE config'),
      'COMMIT'
    ]);
    expect(mocks.clientQuery).toHaveBeenNthCalledWith(
      3,
      expect.any(String),
      [
        'breaker:operator:robinhood-chain',
        JSON.stringify({ consecutiveFailures: 3, trippedAt: failedAt.toISOString() })
      ]
    );
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it('rolls back a failure when the migrated chain key is missing', async () => {
    mocks.clientQuery.mockResolvedValue({ rows: [] });

    await expect(recordCircuitBreakerFailure('operator', 'polygon', 3)).rejects.toBeInstanceOf(
      CircuitBreakerStateCorruptionError
    );
    expect(mocks.clientQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(mocks.clientQuery.mock.calls.some(([sql]) => String(sql).includes('UPDATE config')))
      .toBe(false);
  });

  it('preserves the original trip time after additional failures', async () => {
    const trippedAt = '2026-07-27T09:00:00.000Z';
    mocks.clientQuery.mockImplementation(async (sql: string) => ({
      rows: sql.includes('SELECT value')
        ? [{ value: { consecutiveFailures: 3, trippedAt } }]
        : []
    }));

    await expect(
      recordCircuitBreakerFailure('operator', 'solana', 3, new Date('2026-07-27T10:00:00.000Z'))
    ).resolves.toEqual({ consecutiveFailures: 4, trippedAt });
  });

  it.each([0, 101, 1.5, Number.NaN])(
    'rejects invalid threshold %s before opening a transaction',
    async (threshold) => {
      await expect(recordCircuitBreakerFailure('operator', 'solana', threshold)).rejects.toThrow(
        /integer from 1 through 100/
      );
      expect(mocks.connect).not.toHaveBeenCalled();
    }
  );

  it('rolls back and leaves malformed persisted state closed', async () => {
    mocks.clientQuery.mockImplementation(async (sql: string) => ({
      rows: sql.includes('SELECT value')
        ? [{ value: { consecutiveFailures: '2', trippedAt: null } }]
        : []
    }));

    await expect(recordCircuitBreakerFailure('operator', 'polygon', 3)).rejects.toBeInstanceOf(
      CircuitBreakerStateCorruptionError
    );
    expect(mocks.clientQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(mocks.clientQuery.mock.calls.some(([sql]) => String(sql).includes('UPDATE config')))
      .toBe(false);
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it('resets exactly one chain to the canonical success state', async () => {
    await expect(recordCircuitBreakerSuccess('operator', 'polygon')).resolves.toEqual({
      consecutiveFailures: 0,
      trippedAt: null
    });

    expect(mocks.clientQuery.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      expect.stringContaining('FOR UPDATE'),
      expect.stringContaining('UPDATE config'),
      'COMMIT'
    ]);
    expect(mocks.clientQuery).toHaveBeenNthCalledWith(
      3,
      expect.any(String),
      [
        'breaker:operator:polygon',
        JSON.stringify({ consecutiveFailures: 0, trippedAt: null })
      ]
    );
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it('rolls back success without hiding malformed persisted state', async () => {
    mocks.clientQuery.mockImplementation(async (sql: string) => ({
      rows: sql.includes('SELECT value')
        ? [{ value: { consecutiveFailures: 3, trippedAt: false } }]
        : []
    }));

    await expect(recordCircuitBreakerSuccess('operator', 'solana')).rejects.toBeInstanceOf(
      CircuitBreakerStateCorruptionError
    );
    expect(mocks.clientQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(mocks.clientQuery.mock.calls.some(([sql]) => String(sql).includes('UPDATE config')))
      .toBe(false);
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it('leases one half-open probe after the persisted cooldown', async () => {
    const now = new Date('2026-07-27T10:05:00.000Z');
    mocks.clientQuery.mockImplementation(async (sql: string) => ({
      rows: sql.includes('SELECT value')
        ? [{ value: { consecutiveFailures: 3, trippedAt: '2026-07-27T10:00:00.000Z' } }]
        : []
    }));

    await expect(claimCircuitBreakerProbe('operator', 'solana', 300_000, now)).resolves.toBe(true);
    expect(mocks.clientQuery).toHaveBeenNthCalledWith(3, expect.any(String), [
      'breaker:operator:solana',
      JSON.stringify({ consecutiveFailures: 3, trippedAt: now.toISOString() })
    ]);
  });

  it('does not lease a closed or cooling-down breaker', async () => {
    mocks.clientQuery
      .mockImplementationOnce(async () => ({ rows: [] }))
      .mockImplementationOnce(async () => ({
        rows: [{ value: { consecutiveFailures: 0, trippedAt: null } }]
      }))
      .mockImplementationOnce(async () => ({ rows: [] }));
    await expect(claimCircuitBreakerProbe(
      'operator',
      'polygon',
      300_000,
      new Date('2026-07-27T10:01:00.000Z')
    )).resolves.toBe(false);

    mocks.clientQuery.mockImplementation(async (sql: string) => ({
      rows: sql.includes('SELECT value')
        ? [{ value: { consecutiveFailures: 3, trippedAt: '2026-07-27T10:00:00.000Z' } }]
        : []
    }));
    await expect(claimCircuitBreakerProbe(
      'operator',
      'polygon',
      300_000,
      new Date('2026-07-27T10:04:59.999Z')
    )).resolves.toBe(false);
    expect(mocks.clientQuery.mock.calls.some(([sql]) => String(sql).includes('UPDATE config')))
      .toBe(false);
  });

  it.each([0, -1, 1.5, Number.NaN])(
    'rejects an invalid probe cooldown before opening a transaction: %s',
    async (cooldownMs) => {
      await expect(claimCircuitBreakerProbe('operator', 'solana', cooldownMs)).rejects.toThrow(
        'positive safe integer'
      );
      expect(mocks.connect).not.toHaveBeenCalled();
    }
  );

  it('seeds every chain idempotently without overwriting operator state', async () => {
    const sql = await readFile(
      resolve(import.meta.dirname, '../sql/032_circuit_breaker_state.sql'),
      'utf8'
    );

    expect(sql).toContain("'breaker:solana'");
    expect(sql).toContain("'breaker:polygon'");
    expect(sql).toContain("'breaker:robinhood-chain'");
    expect(sql).toContain('ON CONFLICT (key) DO NOTHING');
    expect(sql).not.toMatch(/DO UPDATE/i);
  });
});
