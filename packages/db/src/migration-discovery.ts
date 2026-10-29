import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export type MigrationProfile = 'core' | 'lp';

export type MigrationFile = {
  readonly file: string;
  readonly path: string;
  readonly profile: MigrationProfile;
};

export function migrationProfileFromEnv(value: string | undefined): MigrationProfile {
  if (value === undefined || value === '') return 'core';
  if (value === 'core' || value === 'lp') return value;
  throw new Error(`SWAT_DB_PROFILE must be "core" or "lp", got ${value}`);
}

async function sqlFiles(root: string, profile: MigrationProfile): Promise<MigrationFile[]> {
  const files = (await readdir(root))
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => ({ file, path: join(root, file), profile }));
  return files;
}

/**
 * Core is the default and never reads the LP migration root. The LP profile is
 * additive: it applies the same core schema plus explicitly isolated LP SQL.
 */
export async function discoverMigrations(
  sqlRoot: string,
  lpSqlRoot: string,
  profile: MigrationProfile
): Promise<MigrationFile[]> {
  const core = await sqlFiles(resolve(sqlRoot), 'core');
  if (profile === 'core') return core;
  const lp = await sqlFiles(resolve(lpSqlRoot), 'lp');
  return [...core, ...lp].sort((left, right) => left.file.localeCompare(right.file));
}
