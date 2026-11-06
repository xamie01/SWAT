import { Pool, types } from 'pg';
import { attachPoolErrorHandler, buildDatabaseRuntimeConfig, createPoolCloser, installDatabaseShutdownHandlers } from './client-runtime.js';
import { configurePostgresNumericParsers } from './numeric.js';
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
}
configurePostgresNumericParsers(types);
export const databaseRuntimeConfig = buildDatabaseRuntimeConfig(databaseUrl);
/**
 * Writes, transactions, and any read that must observe them.
 *
 * `pool` is kept as an alias so the ~40 call sites that reach for it directly
 * (`pool.connect()` for transactions, `pool.query()` in tests) keep working.
 */
export const writePool = new Pool(databaseRuntimeConfig.pool);
export const pool = writePool;
attachPoolErrorHandler(writePool);
/**
 * Reads that tolerate replica lag.
 *
 * Points at `DATABASE_READ_URL` when set, otherwise at the same database as
 * `writePool` — in which case it *is* `writePool`, so no second connection pool
 * is opened for a deployment with no replica.
 *
 * The seam is deliberately opt-in via `readQuery()` rather than `query()`
 * silently switching pools: 92 of the ~200 `query()` call sites in this package
 * are INSERT/UPDATE/DELETE. Routing `query()` at large to a replica would send
 * every one of those to a read-only endpoint the day a replica is configured.
 * A caller has to state that a read is lag-tolerant.
 */
const readUrl = process.env.DATABASE_READ_URL;
export const readPool = readUrl && readUrl !== databaseUrl
    ? new Pool(buildDatabaseRuntimeConfig(readUrl).pool)
    : writePool;
if (readPool !== writePool) {
    attachPoolErrorHandler(readPool);
}
const closeWritePool = createPoolCloser(writePool);
const closeReadPool = readPool === writePool ? null : createPoolCloser(readPool);
export const closePool = async () => {
    await Promise.all([closeWritePool(), closeReadPool?.()]);
};
if (process.env.NODE_ENV !== 'test') {
    installDatabaseShutdownHandlers({
        close: closePool,
        timeoutMs: databaseRuntimeConfig.shutdownTimeoutMs
    });
}
export async function query(text, values) {
    const result = await writePool.query(text, values);
    return result.rows;
}
/**
 * Run a read that tolerates replica lag. Identical to `query()` until
 * `DATABASE_READ_URL` is set.
 *
 * Do not use for a read that a write in the same logical operation depends on
 * (a read-modify-write, or a read that must see a row just inserted) — those
 * belong on `query()` or inside a transaction.
 */
export async function readQuery(text, values) {
    const result = await readPool.query(text, values);
    return result.rows;
}
//# sourceMappingURL=client.js.map