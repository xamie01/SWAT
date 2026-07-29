import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closePool, pool } from './client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function main() {
  try {
    const sqlDir = resolve(__dirname, '../sql');
    const files = await readdir(sqlDir);
    const sqlFiles = files.filter(f => f.endsWith('.sql')).sort();

    const client = await pool.connect();
    try {
      // Acquire a session-level advisory lock (ID 1 for migrations)
      await client.query('SELECT pg_advisory_lock(1)');

      for (const file of sqlFiles) {
        const filePath = join(sqlDir, file);
        const sql = await readFile(filePath, 'utf-8');
        
        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query('COMMIT');
          console.log(`Migration completed: ${file}`);
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
