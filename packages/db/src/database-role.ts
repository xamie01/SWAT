import type { Client, PoolClient } from 'pg';

/** Checked on the backend doing the work, never cached across pool checkouts. */
export async function assertDatabaseRole(
  client: Pick<Client | PoolClient, 'query'>,
  purpose: 'runtime' | 'migration'
): Promise<void> {
  const { rows } = await client.query(`
    SELECT current_user AS role_name, session_user AS session_role,
      r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, r.rolreplication, r.rolinherit,
      EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member = r.oid) AS has_memberships,
      (EXISTS (SELECT 1 FROM pg_catalog.pg_shdepend d
         WHERE d.refclassid = 'pg_authid'::regclass AND d.refobjid = r.oid AND d.deptype = 'o')
        OR EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datdba = r.oid)) AS owns_objects,
      (has_schema_privilege(current_user, 'public', 'CREATE')
        OR has_database_privilege(current_user, current_database(), 'CREATE')) AS can_create,
      current_setting('row_security') AS row_security
    FROM pg_catalog.pg_roles r WHERE rolname = current_user
  `);
  const role = rows[0];
  const name = purpose === 'runtime' ? 'swat_app' : 'swat_migrator';
  const denied = ['rolsuper', 'rolbypassrls', 'rolcreaterole', 'rolcreatedb', 'rolreplication', 'rolinherit', 'has_memberships'];
  if (purpose === 'runtime') denied.push('owns_objects', 'can_create');
  if (rows.length !== 1 || role?.role_name !== name || role?.session_role !== name
      || role.row_security !== 'on' || denied.some(flag => role[flag] !== false)) {
    throw new Error(`Unsafe ${purpose} database role; separate least-privilege credentials required`);
  }
}
