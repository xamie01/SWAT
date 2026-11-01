import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export type MigrationProfile = 'core' | 'lp';

export type MigrationFile = {
  readonly file: string;
  readonly path: string;
  readonly profile: MigrationProfile;
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
  const files = (await readdir(root))
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => ({ file, path: join(root, file), profile: 'core' as const }));
  return files;
}
