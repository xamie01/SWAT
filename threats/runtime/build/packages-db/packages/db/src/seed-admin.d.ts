import { type UserRecord } from './users.js';
/**
 * Idempotent admin bootstrap.
 *
 * Kept out of migration `039` on purpose. A migration that seeds a credential
 * would put a password hash into a file that replays on every deploy (D16), and
 * would make the schema undeployable without also choosing an admin password.
 * This is a separate, explicitly-invoked step.
 *
 * Existing operator `trades` and `copy_executions` are deliberately **not**
 * backfilled to this user (ADR-0001). Attributing historical single-operator
 * activity to an account would corrupt that account's P&L, expectancy, and
 * exposure caps with trades it never made.
 */
export interface SeedAdminResult {
    readonly created: boolean;
    readonly user: UserRecord | null;
    readonly reason?: string;
}
export declare function seedAdminUser(input: {
    email: string | undefined;
    password: string | undefined;
}): Promise<SeedAdminResult>;
//# sourceMappingURL=seed-admin.d.ts.map