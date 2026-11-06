import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
export function migrationProfileFromEnv(value) {
    if (value === undefined || value === '' || value === 'core' || value === 'lp')
        return 'core';
    throw new Error(`SWAT_DB_PROFILE must be "core" or "lp", got ${value}`);
}
/**
 * Discovers and sorts all SQL migrations in packages/db/sql/.
 * All platform migrations execute sequentially in a single unified pipeline.
 */
export async function discoverMigrations(sqlRoot, _lpSqlRoot, _profile) {
    const root = resolve(sqlRoot);
    const files = (await readdir(root))
        .filter((file) => file.endsWith('.sql'))
        .sort()
        .map((file) => ({ file, path: join(root, file), profile: 'core' }));
    return files;
}
//# sourceMappingURL=migration-discovery.js.map