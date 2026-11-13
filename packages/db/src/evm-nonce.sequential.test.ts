import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ clients: [] as any[], locked: true as unknown, unlocked: true as unknown,
  unlockError: false, acquireError: false, pid: 101, role: 'swat_app', poolConnect: vi.fn() }));
vi.mock('pg', async () => {
  const { EventEmitter } = await import('node:events');
  class Client extends EventEmitter {
    statements: string[] = [];
    connect = vi.fn(async () => {});
    end = vi.fn(async () => {});
    constructor(readonly options: any) { super(); fake.clients.push(this); }
    query = vi.fn(async (sql: string) => {
      this.statements.push(sql);
      if (sql.includes('FROM pg_catalog.pg_roles')) return { rows: [{ role_name: fake.role, session_role: fake.role,
        rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false,
        rolinherit: false, has_memberships: false, owns_objects: false, can_create: false, row_security: 'on' }] };
      if (sql.includes('pg_try_advisory_lock')) {
        if (fake.acquireError) throw new Error('acquisition uncertain');
        return { rows: [{ locked: fake.locked, backend_pid: 101 }] };
      }
      if (sql.includes('pg_advisory_unlock')) {
        if (fake.unlockError) throw new Error('unlock transport failed');
        return { rows: [{ unlocked: fake.unlocked, backend_pid: fake.pid }] };
      }
      return { rows: [] };
    });
  }
  return { Client };
});
vi.mock('./client.js', () => ({ pool: { connect: fake.poolConnect } }));
import { withEvmNonceLock } from './evm-nonce.js';

beforeEach(() => {
  fake.clients = []; fake.locked = true; fake.unlocked = true; fake.unlockError = false;
  fake.acquireError = false; fake.pid = 101; fake.role = 'swat_app'; fake.poolConnect.mockReset();
  fake.poolConnect.mockRejectedValue(new Error('transaction pool cannot own a session lock'));
  vi.stubEnv('DIRECT_DATABASE_URL', 'postgresql://swat_app:fixture@127.0.0.1:59998/review_test');
  vi.stubEnv('DIRECT_DATABASE_SESSION_CONFIRMED', 'true'); vi.stubEnv('DB_PGBOUNCER', 'true');
});
afterEach(() => vi.unstubAllEnvs());
const lock = (run = vi.fn(async () => 'submitted')) => withEvmNonceLock({ chain: 'polygon', account: '0xabc', run });

describe('package09 direct nonce session', () => {
  it('holds a dedicated direct session over work, with no transaction-pool routing or open transaction', async () => {
    await expect(lock(vi.fn(async () => {
      expect(fake.clients[0].end).not.toHaveBeenCalled();
      expect(fake.clients[0].statements.some((sql: string) => sql.includes('pg_advisory_unlock'))).toBe(false);
      return 'submitted';
    }))).resolves.toEqual({ acquired: true, result: 'submitted' });
    expect(fake.poolConnect).not.toHaveBeenCalled();
    expect(fake.clients[0].options.connectionString).toBe(process.env.DIRECT_DATABASE_URL);
    expect(fake.clients[0].statements).not.toContain('BEGIN');
    expect(fake.clients[0].end).toHaveBeenCalledOnce();
  });
  it('refuses a busy lock without work or an unlock', async () => {
    fake.locked = false; const run = vi.fn();
    await expect(lock(run)).resolves.toEqual({ acquired: false });
    expect(run).not.toHaveBeenCalled();
    expect(fake.clients[0].statements.some((sql: string) => sql.includes('pg_advisory_unlock'))).toBe(false);
    expect(fake.clients[0].end).toHaveBeenCalledOnce();
  });
  it.each(['false', 'error', 'other-backend'])('fails and destroys the session when unlock is %s', async mode => {
    if (mode === 'false') fake.unlocked = false;
    if (mode === 'error') fake.unlockError = true;
    if (mode === 'other-backend') fake.pid = 202;
    await expect(lock()).rejects.toThrow(/unlock|session/i);
    expect(fake.clients[0].end).toHaveBeenCalledOnce();
  });
  it('propagates work failure after checked unlock', async () => {
    const error = new Error('submission uncertain');
    await expect(lock(vi.fn().mockRejectedValue(error))).rejects.toBe(error);
    expect(fake.clients[0].end).toHaveBeenCalledOnce();
  });
  it('discards a session after uncertain lock acquisition', async () => {
    fake.acquireError = true; const run = vi.fn();
    await expect(lock(run)).rejects.toThrow('acquisition uncertain');
    expect(run).not.toHaveBeenCalled(); expect(fake.clients[0].end).toHaveBeenCalledOnce();
  });
  it('does not report success when the session emits an error during work', async () => {
    await expect(lock(vi.fn(async () => {
      fake.clients[0].emit('error', new Error('session lost'));
      return 'submitted';
    }))).rejects.toThrow('session lost');
    expect(fake.clients[0].end).toHaveBeenCalledOnce();
  });
  it.each(['missing', 'pooler', 'unconfirmed'])('refuses %s direct topology before connecting or running', async mode => {
    if (mode === 'missing') vi.stubEnv('DIRECT_DATABASE_URL', '');
    if (mode === 'pooler') vi.stubEnv('DIRECT_DATABASE_URL', 'postgresql://swat_app:fixture@127.0.0.1:6432/review_test');
    if (mode === 'unconfirmed') vi.stubEnv('DIRECT_DATABASE_SESSION_CONFIRMED', 'false');
    const run = vi.fn(); await expect(lock(run)).rejects.toThrow(/DIRECT_DATABASE|direct/i);
    expect(fake.clients).toHaveLength(0); expect(run).not.toHaveBeenCalled();
  });
  it('rejects bootstrap credentials even on the direct session', async () => {
    fake.role = 'swat'; const run = vi.fn();
    await expect(lock(run)).rejects.toThrow(/role/i);
    expect(run).not.toHaveBeenCalled(); expect(fake.clients[0].end).toHaveBeenCalledOnce();
  });
});
