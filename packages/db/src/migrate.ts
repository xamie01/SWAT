import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function main() {
  const migrationPath = resolve(__dirname, '../sql/001_init.sql');
  const sql = await readFile(migrationPath, 'utf-8');
  await pool.query(sql);
  console.log('Migration completed: 001_init.sql');
  await pool.end();
}

main().catch(async (error) => {
  console.error('Migration failed', error);
  await pool.end();
  process.exit(1);
});
