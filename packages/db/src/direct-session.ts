import { Client } from 'pg';
import { buildDatabaseRuntimeConfig } from './client-runtime.js';
import { assertDatabaseRole } from './database-role.js';

/** A new physical session, never a transaction-pool checkout. No URL fallback.
 * The attestation is an operator gate, not proof that an arbitrary proxy is direct.
 * Migration processes supply their separate swat_migrator identity via this URL.
 */
export async function withDirectAdvisoryLock<T>(
  purpose: 'runtime' | 'migration',
  key: string | 1,
  run: (client: Client) => Promise<T>
): Promise<{ acquired: true; result: T } | { acquired: false }> {
  const url = process.env.DIRECT_DATABASE_URL;
  let parsed: URL;
  try { parsed = new URL(url ?? ''); } catch { throw new Error('DIRECT_DATABASE_URL is required'); }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname
      || parsed.port === '6432' || /pgbouncer|pooler/i.test(parsed.hostname)
      || [...parsed.searchParams.keys()].some(k => k !== 'sslmode')
      || process.env.DIRECT_DATABASE_SESSION_CONFIRMED !== 'true') {
    throw new Error('DIRECT_DATABASE_URL requires an explicitly confirmed direct PostgreSQL session endpoint');
  }
  const client = new Client(buildDatabaseRuntimeConfig(url!, { ...process.env, DB_PGBOUNCER: 'false' }).pool);
  let sessionError: Error | undefined;
  const onError = (error: Error) => { sessionError ??= error; };
  client.on('error', onError);
  let held = false;
  let pid: number | undefined;
  let failure: unknown;
  let failed = false;
  let outcome: { acquired: true; result: T } | { acquired: false } = { acquired: false };
  const expression = key === 1 ? '1' : 'hashtextextended($1, 0)';
  const values = key === 1 ? [] : [key];
  const recordFailure = (error: unknown) => {
    failure = failed ? new AggregateError([failure, error], 'Database session work/cleanup failed', { cause: failure }) : error;
    failed = true;
  };
  try {
    await client.connect();
    await assertDatabaseRole(client, purpose);
    const { rows } = await client.query(`SELECT pg_try_advisory_lock(${expression}) AS locked, pg_backend_pid() AS backend_pid`, values);
    held = rows[0]?.locked === true;
    pid = rows[0]?.backend_pid;
    if (typeof rows[0]?.locked !== 'boolean' || !Number.isInteger(pid)) throw new Error('Invalid advisory session lock result');
    if (sessionError) throw sessionError;
    if (held) outcome = { acquired: true, result: await run(client) };
    if (sessionError) throw sessionError;
  } catch (error) { recordFailure(error); }
  finally {
    if (held) {
      try {
        const { rows } = await client.query(`SELECT pg_advisory_unlock(${expression}) AS unlocked, pg_backend_pid() AS backend_pid`, values);
        if (rows[0]?.unlocked !== true || rows[0]?.backend_pid !== pid) throw new Error('Advisory unlock failed or session ownership changed');
      } catch (error) { recordFailure(error); }
    }
    // Always destroy this dedicated session, including uncertain acquisition or false unlock.
    // Do not race the work against an error and free the lock while work is still running.
    try { await client.end(); } catch (error) { recordFailure(error); }
    client.off('error', onError);
    if (sessionError && !failed) recordFailure(sessionError);
  }
  if (failed) throw failure;
  return outcome;
}
