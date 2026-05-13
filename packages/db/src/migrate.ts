import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function main() {
  const sqlDir = resolve(__dirname, '../sql');
  const files = await readdir(sqlDir);
  const sqlFiles = files.filter(f => f.endsWith('.sql')).sort();
  
  for (const file of sqlFiles) {
    const filePath = join(sqlDir, file);
    const sql = await readFile(filePath, 'utf-8');
    await pool.query(sql);
    console.log(`Migration completed: ${file}`);
  }
  
  await pool.end();
}

main().catch(async (error) => {
  console.error('Migration failed', error);
  await pool.end();
  process.exit(1);
});
