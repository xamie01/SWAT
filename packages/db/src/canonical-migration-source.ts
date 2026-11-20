import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { discoverMigrations } from './migration-discovery.js';
import { createInstallationPlan } from './installation-plan.js';
import type { ReviewedMigrationSelection } from './migration-selection.js';

const sqlRoot = fileURLToPath(new URL('../sql/', import.meta.url));
const lpRoot = fileURLToPath(new URL('../sql-lp/', import.meta.url));
const sha = (bytes: string) => createHash('sha256').update(bytes).digest('hex');

/** Source inspection only; no database acquisition or migration execution. */
export async function canonicalMigrationSource(selection?: ReviewedMigrationSelection) {
  const lp = await readdir(lpRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []; throw error;
  });
  if (lp.some(file => file.endsWith('.sql'))) throw new Error('sql-lp is nonempty but ignored by actual canonical migration discovery');
  const files = await discoverMigrations(sqlRoot, undefined, undefined, selection);
  const plan = selection ? createInstallationPlan(files, { selection, auditReference: selection.auditReference }) : null;
  return { files, plan, digest: sha(JSON.stringify({ profile: 'core',
    migrations: files.map(({ file,checksum }) => ({ file,checksum })),
    selectionChecksum: selection?.manifestChecksum ?? null, planChecksum: plan?.planChecksum ?? null })) };
}
