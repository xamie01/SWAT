import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closePool, pool } from './client.js';
import { discoverMigrations, migrationProfileFromEnv } from './migration-discovery.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function main() {
  try {
    const sqlDir = resolve(__dirname, '../sql');
    const migrations = await discoverMigrations(sqlDir);
    console.log(`Discovered ${migrations.length} migrations from ${sqlDir}`);

    const client = await pool.connect();
    try {
      // Acquire a session-level advisory lock (ID 1 for migrations)
      await client.query('SELECT pg_advisory_lock(1)');

      for (const migration of migrations) {
        const sql = await readFile(migration.path, 'utf-8');
        
        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query('COMMIT');
          console.log(`Migration completed (${migration.profile}): ${migration.file}`);
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      }
    } finally {
      // Always unlock and release the client back to the pool
      await client.query('SELECT pg_advisory_unlock(1)');
      client.release();
    }
  } finally {
    await closePool();
  }
}

main().catch((error) => {
  console.error('Migration failed', error);
  process.exitCode = 1;
});
