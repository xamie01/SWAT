import { Pool, types, type PoolClient, type PoolConfig, type QueryResultRow } from 'pg';
import {
  attachPoolErrorHandler, buildDatabaseRuntimeConfig, createPoolCloser, installDatabaseShutdownHandlers
} from './client-runtime.js';
import { assertDatabaseRole } from './database-role.js';
import { configurePostgresNumericParsers } from './numeric.js';
import {
  isRuntimePoolClient,
  markRuntimePoolClient,
  registerReadPool
} from './runtime-client-registry.js';

export { isRuntimePoolClient };

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
configurePostgresNumericParsers(types);
export const databaseRuntimeConfig = buildDatabaseRuntimeConfig(databaseUrl);

/** No raw pool export: validate on the backend pinned by BEGIN, including with PgBouncer.
 * Unscoped calls have no tenant authority. Auth/admin need separately reviewed capabilities,
 * not a bootstrap login or a flag that silently bypasses RLS.
 */
function runtimePool(config: PoolConfig) {
  const underlying = new Pool(config);
  attachPoolErrorHandler(underlying);
  async function connect(): Promise<PoolClient> {
    const client = await underlying.connect();
    const execute = client.query.bind(client);
    let transaction = false;
    let broken = false;
    let sessionError: Error | undefined;
    const onError = (error: Error) => { broken = true; sessionError ??= error; };
    client.on('error', onError);
    const checkedQuery = async (text: string, values?: unknown[]) => {
      if (sessionError && text !== 'ROLLBACK') throw sessionError;
      if (broken && text !== 'ROLLBACK') throw new Error('Unsafe runtime database role/session cannot execute queries');
      if (typeof text !== 'string') throw new Error('Runtime query must be SQL text');
      if (/^BEGIN(?: ISOLATION LEVEL (?:READ COMMITTED|REPEATABLE READ|SERIALIZABLE))?(?: READ ONLY)?$/i.test(text)) {
        if (transaction) throw new Error('Nested runtime transaction is not supported');
        try {
          const result = await execute(text);
          transaction = true;
          await assertDatabaseRole({ query: execute }, 'runtime');
          await execute("SELECT set_config('app.bypass_rls', 'off', true), set_config('app.current_user_id', $1, true)", ['']);
          return result;
        } catch (error) { broken = true; throw error; }
      }
      if (!transaction && text !== 'ROLLBACK') throw new Error('Runtime query requires an explicit transaction');
      const result = await execute(text, values);
      if (text === 'COMMIT' || text === 'ROLLBACK') transaction = false;
      return result;
    };
    const wrapped = new Proxy(client, {
      get(target, property) {
        if (property === 'query') return checkedQuery;
        if (property === 'release') return (error?: Error | boolean) => {
          client.off('error', onError);
          client.release(broken || transaction || error);
        };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    markRuntimePoolClient(wrapped);
    return wrapped;
  }
  return {
    connect,
    end: () => underlying.end(),
    async query<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) {
      const client = await connect();
      let broken = false;
      try {
        await client.query('BEGIN');
        const result = await client.query<T>(text, values);
        const commit = await client.query('COMMIT');
        if (commit.command !== 'COMMIT') throw new Error('Runtime transaction did not commit');
        return result;
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { broken = true; }
        throw error;
      } finally { client.release(broken); }
    }
  };
}

export const writePool = runtimePool(databaseRuntimeConfig.pool);
export const pool = writePool;
const readUrl = process.env.DATABASE_READ_URL;
export const readPool = readUrl && readUrl !== databaseUrl
  ? runtimePool(buildDatabaseRuntimeConfig(readUrl).pool) : writePool;
registerReadPool(writePool, readPool);
const closeWritePool = createPoolCloser(writePool);
const closeReadPool = readPool === writePool ? null : createPoolCloser(readPool);
export const closePool = async (): Promise<void> => {
  await closeWritePool();
  await closeReadPool?.();
};
if (process.env.NODE_ENV !== 'test') {
  installDatabaseShutdownHandlers({ close: closePool, timeoutMs: databaseRuntimeConfig.shutdownTimeoutMs });
}
export async function query<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<T[]> {
  return (await writePool.query<T>(text, values)).rows;
}
/** Explicitly opt in to replica lag; writes and read-after-write stay on query(). */
export async function readQuery<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<T[]> {
  return (await readPool.query<T>(text, values)).rows;
}
