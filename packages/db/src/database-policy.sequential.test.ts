import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const read = (relative: string) => readFile(new URL(relative, import.meta.url), 'utf8');
describe('package09 unapplied role and pooler deployment contracts', () => {
  it('never creates a login with a predictable password in the fresh-install path', async () => {
    const sql = await read('../sql/064_row_level_security.sql');
    expect(sql).not.toMatch(/LOGIN\s+PASSWORD\s+'[^']+'/i);
    expect(sql).not.toMatch(/GRANT swat_app TO swat\b/);
  });
  it('does not let legacy CI provisioning recreate the known bootstrap login', async () => {
    const source = await read('./ci-setup.ts');
    expect(source).not.toMatch(/LOGIN\s+PASSWORD\s+'[^']+'/i);
    expect(source).not.toContain("'postgresql://postgres:swat@");
    const { setup } = await import('./ci-setup.js');
    await expect(setup()).rejects.toThrow(/bootstrap is disabled/);
  });
  it('provides explicit credential-free provisioning and reconciliation of both separated roles', async () => {
    const sql = await read('../../../deploy/postgres/roles.sql');
    for (const role of ['swat_app', 'swat_migrator']) {
      expect(sql).toMatch(new RegExp(`ALTER ROLE ${role} NOLOGIN PASSWORD NULL NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION`));
    }
    expect(sql).toContain('REVOKE %I FROM %I');
    expect(sql).not.toMatch(/PASSWORD\s+'[^']+'/i);
  });
  it('upgrades existing roles with a strict bypass policy and no blanket future DML', async () => {
    const sql = await read('../sql/070_runtime_role_boundary.sql');
    expect(sql).toContain("current_user = 'swat_migrator' AND session_user = 'swat_migrator'");
    expect(sql).toContain('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM swat_app');
    expect(sql).toContain('ALTER DEFAULT PRIVILEGES FOR ROLE');
    expect(sql).toContain('FORCE ROW LEVEL SECURITY');
    expect(sql).toContain('CREATE POLICY tenant_isolation_policy');
    expect(sql).not.toMatch(/GRANT .*ON ALL TABLES/);
    expect(sql).not.toContain("current_setting('app.bypass_rls'");
  });
  it('keeps PgBouncer transactional without a bootstrap auth identity or migration endpoint', async () => {
    const ini = await read('../../../deploy/pgbouncer/pgbouncer.ini');
    expect(ini).toContain('pool_mode = transaction');
    expect(ini).not.toMatch(/auth_user=swat\b|^admin_users\s*=\s*swat\s*$/m);
    expect(ini).toContain('DIRECT_DATABASE_URL');
  });
});

it('revokes global default grants as well as schema grants, including PUBLIC function execution', async () => {
  const sql = await read('../sql/070_runtime_role_boundary.sql');
  expect(sql).toContain('ALTER DEFAULT PRIVILEGES FOR ROLE swat_migrator REVOKE ALL ON TABLES FROM swat_app');
  expect(sql).toContain('ALTER DEFAULT PRIVILEGES FOR ROLE swat_migrator REVOKE ALL ON SEQUENCES FROM swat_app');
  expect(sql).toContain('ALTER DEFAULT PRIVILEGES FOR ROLE swat_migrator REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC');
});
