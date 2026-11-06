import { Pool, type QueryResultRow } from 'pg';
export declare const databaseRuntimeConfig: import("./client-runtime.js").DatabaseRuntimeConfig;
/**
 * Writes, transactions, and any read that must observe them.
 *
 * `pool` is kept as an alias so the ~40 call sites that reach for it directly
 * (`pool.connect()` for transactions, `pool.query()` in tests) keep working.
 */
export declare const writePool: Pool;
export declare const pool: Pool;
export declare const readPool: Pool;
export declare const closePool: () => Promise<void>;
export declare function query<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<T[]>;
/**
 * Run a read that tolerates replica lag. Identical to `query()` until
 * `DATABASE_READ_URL` is set.
 *
 * Do not use for a read that a write in the same logical operation depends on
 * (a read-modify-write, or a read that must see a row just inserted) — those
 * belong on `query()` or inside a transaction.
 */
export declare function readQuery<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<T[]>;
//# sourceMappingURL=client.d.ts.map