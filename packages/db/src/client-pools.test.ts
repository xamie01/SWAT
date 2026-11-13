import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The read/write pool seam. `client.ts` builds its pools at import time, so
 * each case resets the module registry and re-imports under different env.
 */

const constructed: Array<{ connectionString?: string }> = [];
const endings: Array<string | undefined> = [];

vi.mock('pg', () => {
  class Pool {
    options: { connectionString?: string };
    constructor(options: { connectionString?: string }) {
      this.options = options;
      constructed.push(options);
    }
    on = vi.fn();
    async connect() {
      return { on() {}, off() {}, release() {}, query: async (sql: string) => {
        if (sql.includes('FROM pg_catalog.pg_roles')) return { rows: [{ role_name: 'swat_app', session_role: 'swat_app',
          rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false,
          rolreplication: false, rolinherit: false, has_memberships: false,
          owns_objects: false, can_create: false, row_security: 'on' }] };
        return { rows: [{ pool: this.options.connectionString }], command: sql };
      } };
    }
    end = vi.fn(async () => { endings.push(this.options.connectionString); });
  }
  return { Pool, types: { setTypeParser: vi.fn() } };
});

const WRITE_URL = 'postgres://user:pw@primary/swat';
const READ_URL = 'postgres://user:pw@replica/swat';

async function loadClient(env: { read?: string }) {
  vi.resetModules();
  constructed.length = 0;
  endings.length = 0;
  process.env.DATABASE_URL = WRITE_URL;
  if (env.read === undefined) {
    delete process.env.DATABASE_READ_URL;
  } else {
    process.env.DATABASE_READ_URL = env.read;
  }
  return import('./client.js');
}

const originalRead = process.env.DATABASE_READ_URL;
const originalWrite = process.env.DATABASE_URL;

beforeEach(() => {
  process.env.NODE_ENV = 'test';
});

afterEach(() => {
  if (originalRead === undefined) delete process.env.DATABASE_READ_URL;
  else process.env.DATABASE_READ_URL = originalRead;
  if (originalWrite === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalWrite;
});

describe('read and write pools', () => {
  // The common deployment. A second pool against the same database would double
  // the connection count for no benefit.
  it('shares one pool when no replica is configured', async () => {
    const client = await loadClient({});

    expect(client.readPool).toBe(client.writePool);
    expect(constructed).toHaveLength(1);
  });

  it('keeps `pool` as an alias of the write pool', async () => {
    const client = await loadClient({});

    expect(client.pool).toBe(client.writePool);
  });

  it('opens a separate pool for a distinct replica URL', async () => {
    const client = await loadClient({ read: READ_URL });

    expect(client.readPool).not.toBe(client.writePool);
    expect(constructed.map((options) => options.connectionString)).toEqual([
      WRITE_URL,
      READ_URL
    ]);
  });

  // A replica URL that resolves to the primary is a config mistake, not a
  // reason to open a redundant pool.
  it('does not open a second pool when the replica URL equals the primary', async () => {
    const client = await loadClient({ read: WRITE_URL });

    expect(client.readPool).toBe(client.writePool);
    expect(constructed).toHaveLength(1);
  });

  // This is the guarantee that makes the seam safe: 92 of the ~200 query()
  // calls in this package are writes, so query() must never drift to the
  // replica.
  it('sends query() to the write pool and readQuery() to the read pool', async () => {
    const client = await loadClient({ read: READ_URL });

    await expect(client.query('SELECT 1')).resolves.toEqual([{ pool: WRITE_URL }]);
    await expect(client.readQuery('SELECT 1')).resolves.toEqual([{ pool: READ_URL }]);
  });

  it('closes both pools', async () => {
    const client = await loadClient({ read: READ_URL });

    await client.closePool();

    expect(endings).toEqual([WRITE_URL, READ_URL]);
  });

  it('closes the shared pool exactly once', async () => {
    const client = await loadClient({});

    await client.closePool();
    await client.closePool();

    expect(endings).toEqual([WRITE_URL]);
  });
});
