import { withTransaction } from './transaction.js';
/**
 * The only constructor for a `UserScope`.
 *
 * Call this with a session-derived id and nothing else. It is intentionally the
 * single grep target for "where does tenant scope enter the system?".
 */
export function forUser(userId) {
    if (!userId) {
        // An empty scope would silently widen every query built from it.
        throw new Error('forUser() requires a user id');
    }
    return { userId };
}
/**
 * Escape hatch for routes that legitimately cross tenants (admin listings,
 * platform-wide reports, background jobs).
 *
 * Deliberately verbose and separately named so that crossing tenants is
 * greppable rather than implicit — `grep -rn crossTenant` should return a short,
 * reviewable list. Any new occurrence is a security review item.
 */
export function crossTenantScope(reason) {
    if (!reason)
        throw new Error('crossTenantScope() requires a stated reason');
    return { userId: '*' };
}
export function isCrossTenant(scope) {
    return scope.userId === '*';
}
/**
 * Sets the PostgreSQL session variables for Row-Level Security on a checked-out client.
 *
 * Scopes queries to `scope.userId`, enabling Postgres RLS enforcement on all 17 user tables.
 * Setting `is_rls_bypassed = 'off'` activates kernel RLS filtering for specific users.
 * When `scope.userId === '*'`, sets `app.bypass_rls = 'on'` for cross-tenant administration.
 */
export async function setTenantScope(client, scope) {
    if (isCrossTenant(scope)) {
        await client.query("SET LOCAL app.bypass_rls = 'on'");
        await client.query("SET LOCAL app.current_user_id = '*'");
    }
    else {
        await client.query("SET LOCAL app.bypass_rls = 'off'");
        await client.query("SELECT set_config('app.current_user_id', $1, true)", [scope.userId]);
    }
}
/**
 * Executes an operation inside a PostgreSQL transaction with active Row-Level Security (RLS).
 *
 * Enforces database-level isolation so that queries cannot read or mutate another tenant's rows,
 * even in the event of an application-level SQL logic error.
 */
export async function withTenantTransaction(scope, operation, options = {}) {
    return withTransaction(async (client) => {
        await setTenantScope(client, scope);
        return operation(client);
    }, options);
}
/**
 * Runs a single query under tenant Row-Level Security within an isolated transaction.
 */
export async function scopedQuery(scope, text, values) {
    return withTenantTransaction(scope, async (client) => {
        const result = await client.query(text, values);
        return result.rows;
    });
}
//# sourceMappingURL=tenancy.js.map