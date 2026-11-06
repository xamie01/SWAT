import type { PoolClient } from 'pg';
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
}
export declare function withTransaction<T>(operation: (client: PoolClient) => Promise<T>, options?: TransactionOptions): Promise<T>;
//# sourceMappingURL=transaction.d.ts.map