import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

export type MigrationProfile = 'core' | 'lp';

export type MigrationFile = {
  readonly file: string;
  readonly path: string;
  readonly profile: MigrationProfile;
  readonly sql: string;
  readonly checksum: string;
};

export function migrationProfileFromEnv(value: string | undefined): MigrationProfile {
  if (value === undefined || value === '' || value === 'core' || value === 'lp') return 'core';
  throw new Error(`SWAT_DB_PROFILE must be "core" or "lp", got ${value}`);
}

/**
 * Discovers and sorts all SQL migrations in packages/db/sql/.
 * All platform migrations execute sequentially in a single unified pipeline.
 */
export async function discoverMigrations(
  sqlRoot: string,
  _lpSqlRoot?: string,
  _profile?: MigrationProfile
): Promise<MigrationFile[]> {
  const root = resolve(sqlRoot);
  const names = (await readdir(root)).filter(file => file.endsWith('.sql')).sort();
  const versions = new Set<string>();
  const files: MigrationFile[] = [];
  for (const file of names) {
    const version = /^(\d{3})_[a-z0-9_]+\.sql$/.exec(file)?.[1];
    if (!version) throw new Error(`Invalid migration filename: ${file}`);
    if (versions.has(version)) throw new Error(`Duplicate migration version: ${version}`);
    versions.add(version);
    const path = join(root, file);
    const bytes = await readFile(path);
    files.push({ file, path, profile: 'core', sql: bytes.toString('utf8'),
      checksum: createHash('sha256').update(bytes).digest('hex') });
  }
  if (!files.length) throw new Error('No migrations discovered');
  return files;
}
