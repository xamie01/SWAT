import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ files: {} as Record<string, string>, journal: null as any[] | null,
  objects: true, statements: [] as string[], applied: [] as string[], busy: false, unlock: true,
  pause: undefined as undefined | (() => Promise<void>), failSql: '', failCommit: false, role: 'swat_migrator', ends: 0, held: false }));
vi.mock('node:fs/promises', async importOriginal => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return { ...real,
    readdir: (...args: any[]) => String(args[0]) === '/synthetic/package09' ? Promise.resolve(Object.keys(db.files)) : (real.readdir as any)(...args),
    readFile: (...args: any[]) => String(args[0]).startsWith('/synthetic/package09/')
      ? Promise.resolve(args[1] ? db.files[String(args[0]).split('/').at(-1)!] : Buffer.from(db.files[String(args[0]).split('/').at(-1)!]))
      : (real.readFile as any)(...args)
  };
});
vi.mock('pg', async () => {
  const { EventEmitter } = await import('node:events');
  class Client extends EventEmitter {
    snapshot: { journal: any[] | null; applied: string[] } | undefined;
    async connect() { return this; }
    async end() { db.ends++; }
    release() { db.ends++; }
    async query(sql: string, values: any[] = []) {
      db.statements.push(sql);
      if (sql === 'BEGIN') this.snapshot = { journal: db.journal?.map(r => ({ ...r })) ?? null, applied: [...db.applied] };
      if (sql === 'ROLLBACK' && this.snapshot) { db.journal = this.snapshot.journal; db.applied = this.snapshot.applied; }
      if (sql === 'COMMIT') {
        if (db.failCommit) return { rows: [], command: 'ROLLBACK' };
        return { rows: [], command: 'COMMIT' };
      }
      if (sql.includes('FROM pg_catalog.pg_roles')) return { rows: [{ role_name: db.role, session_role: db.role,
        rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false,
        rolreplication: false, rolinherit: false, has_memberships: false, row_security: 'on' }] };
      if (sql.includes('pg_try_advisory_lock')) {
        const locked = !db.busy && !db.held; if (locked) db.held = true;
        return { rows: [{ locked, backend_pid: 100 }] };
      }
      if (sql.includes('pg_advisory_unlock')) { db.held = false; return { rows: [{ unlocked: db.unlock, backend_pid: 100 }] }; }
      if (sql.startsWith('SELECT to_regclass(')) {
        await db.pause?.();
        return { rows: [{ journal: db.journal === null ? null : 'swat_schema_migrations', database: 'review_test' }] };
      }
      if (sql.includes('AS has_objects')) return { rows: [{ has_objects: db.objects }] };
      if (/^\s*SELECT file, checksum/.test(sql)) return { rows: db.journal ?? [] };
      if (sql.includes('CREATE TABLE public.swat_schema_migrations')) db.journal = [];
      if (sql.includes('INSERT INTO public.swat_schema_migrations')) db.journal!.push({ file: values[0], checksum: values[1], installed_checksum: values[2], audit_reference: values[3] });
      if (Object.values(db.files).includes(sql)) {
        if (sql === db.failSql) throw new Error('fixture migration rejected');
        db.applied.push(sql);
      }
      return { rows: [] };
    }
  }
  return { Client, Pool: Client, types: { setTypeParser() {} } };
});
// Old runner used this pool; it must disappear from the migration path.
vi.mock('./client.js', async () => {
  const { Client } = await import('pg');
  return { pool: { connect: async () => new Client() }, closePool: async () => {} };
});
import { discoverMigrationInventory, discoverMigrations } from './migration-discovery.js';
import { createMigrationSelectionProposal, reviewMigrationSelection } from './migration-selection.js';
import { createInstallationPlan } from './installation-plan.js';
import { runMigrations } from './migrate.js';
const checksum = (text: string) => createHash('sha256').update(text).digest('hex');
const records = () => Object.entries(db.files).sort().map(([file, sql]) => ({ file, checksum: checksum(sql), installed_checksum: checksum(sql), audit_reference: null }));
const run = (options: Record<string, unknown> = {}) => runMigrations({ sqlDir: '/synthetic/package09', quiesced: true, ...options });
beforeEach(() => {
  db.files = { '066_lp_dashboard.sql': '-- fixture066: old transition\nSELECT 66;', '067_lp_auto_rebalance.sql': '-- fixture067: active to rebalancing\nSELECT 67;' };
  db.pause = undefined; db.journal = null; db.objects = true; db.statements = []; db.applied = []; db.busy = false;
  db.unlock = true; db.failSql = ''; db.failCommit = false; db.role = 'swat_migrator'; db.ends = 0; db.held = false;
  vi.stubEnv('DIRECT_DATABASE_URL', 'postgresql://swat_migrator:fixture@127.0.0.1:59998/review_test');
  vi.stubEnv('DIRECT_DATABASE_SESSION_CONFIRMED', 'true');
});

afterEach(() => vi.unstubAllEnvs());

describe('package09 migration history and discovery', () => {
  it('refuses an existing untracked database without guessing or executing SQL', async () => {
    await expect(run()).rejects.toThrow(/untracked|baseline/i);
    expect(db.applied).toEqual([]); expect(db.journal).toBeNull();
  });
  it('does not treat an empty journal on an existing database as permission to replay', async () => {
    db.journal = []; await expect(run({ initialize: true })).rejects.toThrow(/untracked|baseline/i);
    expect(db.applied).toEqual([]);
  });
  it('skips every checksummed applied migration, including 066 before the wider 067 transition', async () => {
    db.journal = records(); await run();
    expect(db.applied).toEqual([]); expect(db.ends).toBe(1);
  });
  it.each(['changed', 'gap', 'unknown'])('refuses %s journal history before any SQL executes', async mode => {
    db.journal = records();
    if (mode === 'changed') db.journal[0].checksum = '0'.repeat(64);
    if (mode === 'gap') db.journal.shift();
    if (mode === 'unknown') db.journal.push({ file: '999_unknown.sql', checksum: '0'.repeat(64) });
    await expect(run()).rejects.toThrow(/checksum|history|prefix|journal/i); expect(db.applied).toEqual([]);
  });
  it('applies and journals the pending suffix atomically, never committing a 066-only window', async () => {
    db.objects = false;
    await run({ initialize: true });
    expect(db.journal).toEqual(records()); expect(db.applied).toEqual(Object.values(db.files));
    expect(db.statements.filter(s => s === 'COMMIT')).toHaveLength(1);
    db.applied = []; await run(); expect(db.applied).toEqual([]);
  });
  it('rolls back SQL and journal together on failure', async () => {
    db.objects = false; db.failSql = db.files['067_lp_auto_rebalance.sql'];
    await expect(run({ initialize: true })).rejects.toThrow('fixture migration rejected');
    expect(db.journal).toBeNull(); expect(db.applied).toEqual([]); expect(db.ends).toBe(1);
  });
  it('requires explicit initialization and a quiesced apply gate', async () => {
    db.objects = false;
    await expect(run()).rejects.toThrow(/initializ/i);
    await expect(run({ initialize: true, quiesced: false })).rejects.toThrow(/quiesc/i);
    expect(db.applied).toEqual([]);
  });
  it('adopts only an audited exact prefix, recording installed and reviewed-source hashes without applying pending SQL', async () => {
    const first = records()[0];
    const baseline = { database: 'review_test', auditReference: 'change-090: schema and old064 independently audited',
      migrations: [{ file: first.file, checksum: first.checksum, installedChecksum: 'a'.repeat(64) }] };
    await run({ baseline });
    expect(db.applied).toEqual([]);
    expect(db.journal).toEqual([{ ...first, installed_checksum: 'a'.repeat(64), audit_reference: baseline.auditReference }]);
    await run(); expect(db.applied).toEqual([db.files['067_lp_auto_rebalance.sql']]);
  });
  it.each(['database', 'hash', 'audit', 'prefix'])('refuses a baseline with invalid %s', async mode => {
    const baseline = { database: 'review_test', auditReference: 'audited-change-090', migrations: records().map(r => ({ ...r, installedChecksum: r.checksum })) };
    if (mode === 'database') baseline.database = 'wrong_database';
    if (mode === 'hash') baseline.migrations[0].checksum = 'f'.repeat(64);
    if (mode === 'audit') baseline.auditReference = '';
    if (mode === 'prefix') baseline.migrations.shift();
    await expect(run({ baseline })).rejects.toThrow(/baseline/i); expect(db.applied).toEqual([]); expect(db.journal).toBeNull();
  });
  it('refuses concurrent migration ownership, before inspecting or mutating history', async () => {
    db.held = true;
    await expect(run()).rejects.toThrow(/migration.*lock|already|busy/i);
    expect(db.statements.some(s => s.includes('to_regclass'))).toBe(false); expect(db.applied).toEqual([]);
  });
  it('rejects a false migration unlock and destroys its dedicated session', async () => {
    db.journal = records(); db.unlock = false;
    await expect(run()).rejects.toThrow(/unlock/i); expect(db.ends).toBe(1);
  });
  it('refuses runtime credentials for migration ownership', async () => {
    db.role = 'swat_app'; await expect(run()).rejects.toThrow(/migration.*role/i); expect(db.applied).toEqual([]);
  });
  it('detects a COMMIT that PostgreSQL answered with ROLLBACK', async () => {
    db.objects = false; db.failCommit = true;
    await expect(run({ initialize: true })).rejects.toThrow(/commit/i);
  });
  it('discovers immutable SQL with a byte checksum and rejects duplicate versions', async () => {
    const files = await discoverMigrations('/synthetic/package09');
    expect(files[0]).toMatchObject({ file: '066_lp_dashboard.sql', sql: db.files['066_lp_dashboard.sql'], checksum: checksum(db.files['066_lp_dashboard.sql']) });
    db.files['066_duplicate.sql'] = 'SELECT 1;';
    await expect(discoverMigrations('/synthetic/package09')).rejects.toThrow(/duplicate/i);
  });
});


it('serializes two actual runner invocations at the dedicated-session seam', async () => {
  db.journal = records();
  let arrived!: () => void; let resume!: () => void;
  const ready = new Promise<void>(resolve => { arrived = resolve; });
  const wait = new Promise<void>(resolve => { resume = resolve; });
  db.pause = async () => { arrived(); await wait; };
  const first = run(); await ready;
  await expect(run()).rejects.toThrow(/lock is busy/);
  expect(db.held).toBe(true); expect(db.ends).toBe(1);
  resume(); await first;
  expect(db.held).toBe(false); expect(db.ends).toBe(2); expect(db.applied).toEqual([]);
});
it.each(['installed_checksum', 'audit_reference'])('refuses forged reviewed-plan %s before migration work', async field => {
  const sqlDir = fileURLToPath(new URL('../sql', import.meta.url));
  const selection = reviewMigrationSelection(createMigrationSelectionProposal(await discoverMigrationInventory(sqlDir)), 'offline-migration-identity-not-runtime-authorization');
  const source = await discoverMigrations(sqlDir, undefined, undefined, selection);
  const plan = createInstallationPlan(source, { selection, auditReference: selection.auditReference });
  db.journal = plan.migrations.map(m => ({ file: m.file, checksum: m.checksum, installed_checksum: m.installedChecksum, audit_reference: m.auditReference }));
  const index = db.journal.findIndex(row => row.installed_checksum !== row.checksum);
  db.journal[index][field] = field === 'installed_checksum' ? db.journal[index].checksum : 'unrelated-audit';
  await expect(runMigrations({ sqlDir, selection })).rejects.toThrow('exact reviewed source/installed/audit');
  expect(db.statements).not.toContain('BEGIN');
  expect(db.applied).toEqual([]);
});
it('skips the real checked-in 066/067 source SQL when the whole source history is recorded', async () => {
  const sqlDir = fileURLToPath(new URL('../sql', import.meta.url));
  const selection = reviewMigrationSelection(createMigrationSelectionProposal(await discoverMigrationInventory(sqlDir)), 'offline-migration-skip-not-runtime-authorization');
  const source = await discoverMigrations(sqlDir, undefined, undefined, selection);
  const plan = createInstallationPlan(source, { selection, auditReference: selection.auditReference });
  db.journal = plan.migrations.map(m => ({ file: m.file, checksum: m.checksum, installed_checksum: m.installedChecksum, audit_reference: m.auditReference }));
  await runMigrations({ sqlDir, selection });
  expect(db.statements).not.toContain(source.find(m => m.file === '066_lp_dashboard.sql')!.sql);
  expect(db.statements).not.toContain(source.find(m => m.file === '067_lp_auto_rebalance.sql')!.sql);
  expect(db.statements).not.toContain('BEGIN');
});
