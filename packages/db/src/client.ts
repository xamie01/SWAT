import { Pool, type QueryResultRow } from 'pg';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required');
}

export const pool = new Pool({ connectionString: databaseUrl });

export async function query<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<T[]> {
  const result = await pool.query<T>(text, values);
  return result.rows;
}
