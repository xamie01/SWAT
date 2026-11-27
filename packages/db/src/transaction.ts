import type { PoolClient } from 'pg';
import { pool } from './client.js';
import { resolveReadPool, type ConnectablePool } from './runtime-client-registry.js';

/**
 * Transaction helper hardened against the connection dying mid-transaction.
 *
 * The obvious version — `BEGIN` / operation / `COMMIT`, `ROLLBACK` in the
 * catch, `release()` in the finally — has three failure modes when PostgreSQL
 * restarts or an administrator terminates the backend. All three were found by
 * the chaos suite (`tests/integration/chaos.integration.test.ts`):
 *
 *  1. `pg` emits `'error'` on the checked-out client. A checked-out client is
 *     not covered by the pool's error handler, and an `EventEmitter` that emits
 *     `'error'` with no listener throws — so a database restart took the whole
 *     service down rather than failing the one transaction in flight.
 *  2. `ROLLBACK` on a dead backend rejects, and that rejection replaced the
 *     original error. The operator got "terminating connection due to
 *     administrator command" instead of the failure they needed to see.
 *  3. `release()` returns the client to the pool. A client whose backend is
 *     gone must be destroyed instead, or the next caller checks out a socket
 *     that is already closed.
 *
 * The uncommitted work is discarded by the server either way — that part was
 * never in doubt, and the chaos suite asserts it. What this adds is that the
 * *process* survives to retry.
 */
export interface TransactionOptions {
  /**
   * Appended to `BEGIN`. Only pass a literal from this union — it is
   * interpolated, not parameterized, because PostgreSQL does not accept a bind
   * parameter for an isolation level.
   */
  isolationLevel?: 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';
  /** Appends `READ ONLY` to `BEGIN` when true. */
  readOnly?: boolean;
}

async function runPoolTransaction<T>(
  targetPool: ConnectablePool,
  operation: (client: PoolClient) => Promise<T>,
  options: TransactionOptions = {}
): Promise<T> {
  const isoClause = options.isolationLevel
    ? ` ISOLATION LEVEL ${options.isolationLevel}`
    : '';
  const readOnlyClause = options.readOnly ? ' READ ONLY' : '';
  const begin = `BEGIN${isoClause}${readOnlyClause}`;
  const client = await targetPool.connect();
  // Registered before the first statement: the backend can die at any point
  // after checkout, including before BEGIN is acknowledged.
  let sessionError: Error | undefined;
  const swallowClientError = (error: Error): void => { sessionError ??= error; };
  client.on('error', swallowClientError);

  let connectionBroken = false;
  try {
    await client.query(begin);
    if (sessionError) throw sessionError;
    const result = await operation(client);
    if (sessionError) throw sessionError;
    const commit = await client.query('COMMIT');
    if (commit.command !== 'COMMIT') throw new Error('Transaction did not commit');
    if (sessionError) throw sessionError;
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The backend is unreachable, so the transaction is already gone. Keep
      // the original error: the rollback failure is a symptom, not the cause.
      connectionBroken = true;
    }
    throw error;
  } finally {
    client.off('error', swallowClientError);
    client.release(connectionBroken || sessionError !== undefined);
  }
}

export async function withTransaction<T>(
  operation: (client: PoolClient) => Promise<T>,
  options: TransactionOptions = {}
): Promise<T> {
  return runPoolTransaction(pool, operation, options);
}

/**
 * Read transaction routed to `readPool` (falling back to `pool` when no read
 * replica is configured), enforcing `BEGIN READ ONLY` on distinct replicas.
 */
export async function withReadTransaction<T>(
  operation: (client: PoolClient) => Promise<T>,
  options: TransactionOptions = {}
): Promise<T> {
  const { pool: targetPool, isDistinctReplica } = resolveReadPool(pool);
  return runPoolTransaction(targetPool, operation, {
    ...options,
    readOnly: options.readOnly ?? isDistinctReplica
  });
}
