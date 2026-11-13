import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ clients: [] as any[], role: {} as Record<string, unknown>, reuse: false }));
vi.mock('pg', () => {
  class Pool {
    constructor(readonly options: any) {}
    on() { return this; }
    end = vi.fn(async () => {});
    async connect() {
      if (fake.reuse && fake.clients.length) return fake.clients[0];
      const client = Object.assign(new EventEmitter(), {
        release: vi.fn(), tenant: '', transaction: false, statements: [] as string[],
        query: vi.fn(async (sql: string, values?: unknown[]) => {
          client.statements.push(sql);
          if (sql.startsWith('BEGIN')) client.transaction = true;
          if (sql === 'COMMIT' || sql === 'ROLLBACK') { client.transaction = false; client.tenant = ''; }
          if (sql.includes('FROM pg_catalog.pg_roles')) return { rows: [fake.role] };
          if (sql.includes("set_config('app.current_user_id'")) client.tenant = String(values?.[0]);
          if (sql === 'SELECT visible_tenants') return { rows: ['tenant-a', 'tenant-b'].filter(tenant => tenant === client.tenant).map(tenant => ({ tenant })) };
          if (sql === 'SELECT tenant_fixture') return { rows: [{ tenant: client.tenant, endpoint: this.options.connectionString }] };
          return { rows: [], command: sql === 'COMMIT' ? 'COMMIT' : sql };
        })
      });
      fake.clients.push(client);
      return client;
    }
    async query(sql: string, values?: unknown[]) { return (await this.connect()).query(sql, values); }
  }
  return { Pool, types: { setTypeParser() {} } };
});

const url = 'postgresql://swat_app:fixture@127.0.0.1:59998/review_test';
beforeEach(() => {
  vi.resetModules(); fake.clients = []; fake.reuse = false;
  fake.role = { role_name: 'swat_app', session_role: 'swat_app', rolsuper: false, rolbypassrls: false,
    rolcreaterole: false, rolcreatedb: false, rolreplication: false, rolinherit: false,
    has_memberships: false, owns_objects: false, can_create: false, row_security: 'on' };
  vi.stubEnv('DATABASE_URL', url); vi.stubEnv('DATABASE_READ_URL', '');
});
afterEach(() => vi.unstubAllEnvs());

describe('package09 runtime query authority', () => {
  it.each([
    { role_name: 'swat' }, { session_role: 'swat' }, { rolsuper: true }, { rolbypassrls: true },
    { rolcreaterole: true }, { rolcreatedb: true }, { rolreplication: true }, { rolinherit: true },
    { has_memberships: true }, { owns_objects: true }, { can_create: true }, { row_security: 'off' }
  ])('rejects unsafe runtime authority before executing tenant SQL: %j', async (bad) => {
    Object.assign(fake.role, bad);
    const { query } = await import('./client.js');
    await expect(query('SELECT tenant_fixture')).rejects.toThrow(/runtime.*role|role.*runtime/i);
    expect(fake.clients.flatMap(c => c.statements)).not.toContain('SELECT tenant_fixture');
    expect(fake.clients[0].release).toHaveBeenCalledWith(true);
  });
  it('pins validation and tenant scope to the transaction and clears scope on reuse', async () => {
    fake.reuse = true;
    const { scopedQuery, forUser } = await import('./tenancy.js');
    const { query } = await import('./client.js');
    await expect(scopedQuery(forUser('tenant-a'), 'SELECT tenant_fixture')).resolves.toEqual([{ tenant: 'tenant-a', endpoint: url }]);
    await expect(scopedQuery(forUser('tenant-b'), 'SELECT tenant_fixture')).resolves.toEqual([{ tenant: 'tenant-b', endpoint: url }]);
    await expect(query('SELECT tenant_fixture')).resolves.toEqual([{ tenant: '', endpoint: url }]);
    for (const client of fake.clients) {
      const validation = client.statements.findIndex((sql: string) => sql.includes('FROM pg_catalog.pg_roles'));
      expect(validation).toBeGreaterThan(client.statements.indexOf('BEGIN'));
      expect(client.statements.at(-1)).toBe('COMMIT');
    }
  });
  it('does not accept a wildcard as a verified user or implicitly bypass for administrators', async () => {
    const { forUser, crossTenantScope, scopedQuery } = await import('./tenancy.js');
    expect(() => forUser('*')).toThrow();
    await expect(scopedQuery(crossTenantScope('report'), 'SELECT tenant_fixture')).rejects.toThrow(/cross.tenant|privileged/i);
    expect(fake.clients.flatMap(c => c.statements)).not.toContain('SELECT tenant_fixture');
  });
  it('validates replica authority too without moving writes to the replica', async () => {
    vi.stubEnv('DATABASE_READ_URL', url.replace('59998', '59996'));
    const { query, readQuery, readPool, writePool, pool, closePool } = await import('./client.js');
    expect(pool).toBe(writePool); expect(readPool).not.toBe(writePool);
    expect((await query('SELECT tenant_fixture'))[0].endpoint).toBe(url);
    expect((await readQuery('SELECT tenant_fixture'))[0].endpoint).toContain('59996');
    fake.role.rolsuper = true;
    await expect(readQuery('SELECT tenant_fixture')).rejects.toThrow(/runtime.*role|role.*runtime/i);
    await closePool();
  });
});

it('keeps reused-session tenant visibility separate, denies unscoped reads and rolls back a failed scoped operation', async () => {
  fake.reuse = true;
  const { scopedQuery, forUser, withTenantTransaction } = await import('./tenancy.js');
  const { query, pool } = await import('./client.js');
  await expect(scopedQuery(forUser('tenant-a'), 'SELECT visible_tenants')).resolves.toEqual([{ tenant: 'tenant-a' }]);
  await expect(scopedQuery(forUser('tenant-b'), 'SELECT visible_tenants')).resolves.toEqual([{ tenant: 'tenant-b' }]);
  await expect(withTenantTransaction(forUser('tenant-a'), async () => { throw new Error('fixture operation failed'); })).rejects.toThrow('fixture operation failed');
  await expect(query('SELECT visible_tenants')).resolves.toEqual([]);
  expect(fake.clients).toHaveLength(1);
  const client = await pool.connect();
  await expect(client.query('SELECT visible_tenants')).rejects.toThrow(/explicit transaction/);
  client.release();
});

it('cannot keep querying a checked-out connection after runtime role validation failed', async () => {
  fake.role.rolsuper = true;
  const { pool } = await import('./client.js');
  const client = await pool.connect();
  try {
    await expect(client.query('BEGIN')).rejects.toThrow(/runtime.*role/);
    await expect(client.query('SELECT tenant_fixture')).rejects.toThrow(/unsafe|role/);
    expect(fake.clients[0].statements).not.toContain('SELECT tenant_fixture');
  } finally { client.release(); }
  expect(fake.clients[0].release).toHaveBeenCalledWith(true);
});
