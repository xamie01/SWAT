import { Pool, types, type QueryResultRow } from 'pg';
import {
  attachPoolErrorHandler,
  buildDatabaseRuntimeConfig,
  createPoolCloser,
  installDatabaseShutdownHandlers
} from './client-runtime.js';
import { configurePostgresNumericParsers } from './numeric.js';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required');
}

configurePostgresNumericParsers(types);

export const databaseRuntimeConfig = buildDatabaseRuntimeConfig(databaseUrl);
export const pool = new Pool(databaseRuntimeConfig.pool);
attachPoolErrorHandler(pool);

export const closePool = createPoolCloser(pool);

if (process.env.NODE_ENV !== 'test') {
  installDatabaseShutdownHandlers({
    close: closePool,
    timeoutMs: databaseRuntimeConfig.shutdownTimeoutMs
  });
}

export async function query<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<T[]> {
  const result = await pool.query<T>(text, values);
  return result.rows;
}
