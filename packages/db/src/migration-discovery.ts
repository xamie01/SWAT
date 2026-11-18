import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { selectMigrations, type ReviewedMigrationSelection } from './migration-selection.js';

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
 * Production discovery refuses unreviewed forward proposals. An explicit reviewed
 * selection accounts for every source file, including the checksummed084 omission.
 */
export async function discoverMigrations(
  sqlRoot: string,
  _lpSqlRoot?: string,
  _profile?: MigrationProfile,
  selection?: ReviewedMigrationSelection
): Promise<MigrationFile[]> {
  const files = await discoverMigrationInventory(sqlRoot);
  if (selection !== undefined) return selectMigrations(files, selection);
  if (files.some(row => Number(row.file.slice(0, 3)) >= 84)) {
    throw new Error('Unreviewed migration proposals/refused 084 present; explicit reviewed selection required (no SQL silently omitted)');
  }
  return files;
}

/** Inspection only: complete source inventory, including refused proposals. Never implies permission to apply. */
export async function discoverMigrationInventory(sqlRoot: string): Promise<MigrationFile[]> {
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
