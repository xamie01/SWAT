import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * `client.ts` builds a real `pg.Pool` at import time, so the URL has to exist
 * before this module's mock of it is resolved.
 */
vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgres://user:pw@localhost:5432/swat_test';
});

const connect = vi.fn();

vi.mock('./client.js', () => ({
  pool: { connect: () => connect() }
}));

const { withTransaction } = await import('./transaction.js');

/** Minimal stand-in for a checked-out `PoolClient`, with real event semantics. */
function fakeClient(behaviour: Partial<Record<string, () => Promise<unknown>>> = {}) {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const statements: string[] = [];
  const released: Array<boolean | undefined> = [];

  return {
    statements,
    released,
    listenerCount: (event: string) => listeners.get(event)?.size ?? 0,
    /** Emit like an EventEmitter: throw when nothing is listening for `error`. */
    emit(event: string, payload: unknown) {
      const handlers = listeners.get(event);
      if (!handlers || handlers.size === 0) {
        if (event === 'error') throw payload;
        return;
      }
      for (const handler of handlers) handler(payload);
    },
    on(event: string, handler: (payload: unknown) => void) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
    },
    off(event: string, handler: (payload: unknown) => void) {
      listeners.get(event)?.delete(handler);
    },
    query: vi.fn(async (text: string) => {
      statements.push(text);
      const override = behaviour[text];
      if (override) return override();
      return { rows: [] };
    }),
    release: vi.fn((destroy?: boolean) => {
      released.push(destroy);
    })
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('withTransaction', () => {
  it('commits and returns the operation result', async () => {
    const client = fakeClient();
    connect.mockResolvedValue(client);

    await expect(withTransaction(async () => 'result')).resolves.toBe('result');

    expect(client.statements).toEqual(['BEGIN', 'COMMIT']);
    expect(client.released).toEqual([false]);
  });

  it('rolls back and rethrows when the operation fails', async () => {
    const client = fakeClient();
    connect.mockResolvedValue(client);

    await expect(
      withTransaction(async () => {
        throw new Error('operation failed');
      })
    ).rejects.toThrow('operation failed');

    expect(client.statements).toEqual(['BEGIN', 'ROLLBACK']);
    // The connection is fine; returning it to the pool is correct.
    expect(client.released).toEqual([false]);
  });

  // The failure the chaos suite found: a terminated backend emits `'error'` on
  // the checked-out client, which the pool's own handler does not cover. With
  // no listener, Node turns it into an uncaught exception and the service dies
  // rather than the one transaction.
  it('listens for client errors so a dying backend cannot crash the process', async () => {
    const client = fakeClient();
    connect.mockResolvedValue(client);

    await withTransaction(async () => {
      expect(client.listenerCount('error')).toBe(1);
      expect(() => client.emit('error', new Error('terminating connection'))).not.toThrow();
    });
  });

  it('removes its listener once the transaction is over', async () => {
    const client = fakeClient();
    connect.mockResolvedValue(client);

    await withTransaction(async () => undefined);

    expect(client.listenerCount('error')).toBe(0);
  });

  // Reporting the rollback failure would tell the operator the connection died
  // while hiding what the transaction was doing when it did.
  it('keeps the original error when the rollback itself fails', async () => {
    const client = fakeClient({
      ROLLBACK: async () => {
        throw new Error('terminating connection due to administrator command');
      }
    });
    connect.mockResolvedValue(client);

    await expect(
      withTransaction(async () => {
        throw new Error('insert violated a constraint');
      })
    ).rejects.toThrow('insert violated a constraint');
  });

  it('destroys the client when the rollback proves the connection is gone', async () => {
    const client = fakeClient({
      ROLLBACK: async () => {
        throw new Error('connection terminated');
      }
    });
    connect.mockResolvedValue(client);

    await expect(withTransaction(async () => {
      throw new Error('commit never happened');
    })).rejects.toThrow('commit never happened');

    // `release(true)` discards the socket instead of handing a dead client to
    // the next caller.
    expect(client.released).toEqual([true]);
  });

  it('releases the client even when BEGIN itself fails', async () => {
    const client = fakeClient({
      BEGIN: async () => {
        throw new Error('pool is shutting down');
      }
    });
    connect.mockResolvedValue(client);

    await expect(withTransaction(async () => 'unreached')).rejects.toThrow('pool is shutting down');

    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.listenerCount('error')).toBe(0);
  });
});
