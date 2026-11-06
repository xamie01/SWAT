export type MigrationProfile = 'core' | 'lp';
export type MigrationFile = {
    readonly file: string;
    readonly path: string;
    readonly profile: MigrationProfile;
};
export declare function migrationProfileFromEnv(value: string | undefined): MigrationProfile;
/**
 * Discovers and sorts all SQL migrations in packages/db/sql/.
 * All platform migrations execute sequentially in a single unified pipeline.
 */
export declare function discoverMigrations(sqlRoot: string, _lpSqlRoot?: string, _profile?: MigrationProfile): Promise<MigrationFile[]>;
//# sourceMappingURL=migration-discovery.d.ts.map