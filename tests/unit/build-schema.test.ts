import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { canonicalMigrationSource, assertDisposableOwnedInfrastructure,
  generateCanonicalReference, compareCanonicalCandidate } from '../integration/helpers/schema-guard.js';
import { validatePackage28IsolationDeclarations, assertPackage28IsolationPreflight } from '../integration/helpers/package28-isolation.js';

const runId = '12345678-1234-4234-8234-123456789abc';
const env = { INTEGRATION_DISPOSABLE: 'true', INTEGRATION_RUN_ID: runId, SWAT_DB_PROFILE: 'core',
  INTEGRATION_DATABASE_URL: 'postgresql://127.0.0.1:55432/swat_integration_12345678123442348234123456789abc',
  INTEGRATION_REDIS_URL: 'redis://127.0.0.1:56379/0', INTEGRATION_REDIS_NAMESPACE: `swat:integration:${runId}` };
const owned = { env, postgresId: 'a'.repeat(64), redisId: 'b'.repeat(64),
  postgresImageId: 'c'.repeat(64), redisImageId: 'd'.repeat(64), purpose: 'reference' as const };
const effects = vi.hoisted(() => ({ calls: [] as string[][], container: {} as Record<string,unknown> }));
vi.mock('node:child_process', () => ({ execFile: (command: string, args: string[], _options: unknown, callback: Function) => {
  effects.calls.push([command,...args]);
  callback(null, JSON.stringify([effects.container]), '');
} }));
const root = new URL('../../',import.meta.url);
const source = (name: string) => readFileSync(new URL(name,root),'utf8');

describe('schema canonical source and fail-closed qualification', () => {
  it('declarations return no schema/disposal authority and runtime still refuses', () => {
    expect(validatePackage28IsolationDeclarations(env)).toEqual({ runId,
      databaseUrl: env.INTEGRATION_DATABASE_URL, redisUrl: env.INTEGRATION_REDIS_URL,
      redisNamespace: env.INTEGRATION_REDIS_NAMESPACE });
    expect(() => assertPackage28IsolationPreflight({ ...env, INTEGRATION_SCHEMA_VERIFIED: 'true' }))
      .toThrow(/independently generated canonical schema baseline/);
  });
  it('digest binds every exact discovered source byte, not last filename or existence', async () => {
    const canonical = await canonicalMigrationSource();
    for (const file of canonical.files) {
      expect(file.checksum).toBe(createHash('sha256').update(readFileSync(file.path)).digest('hex'));
    }
    expect(canonical.files.some(f => f.file === '071_durable_source_fanout.sql')).toBe(true);
    expect(canonical.files.some(f => f.file === '072_durable_risk_reservations.sql')).toBe(true);
    expect(canonical.files.some(f => f.file === '073_durable_notification_discovery.sql')).toBe(true);
    const independent = createHash('sha256').update(JSON.stringify({ profile: 'core',
      migrations: canonical.files.map(({file,checksum}) => ({file,checksum})) })).digest('hex');
    expect(canonical.digest).toBe(independent);
    expect(createHash('sha256').update(JSON.stringify({ profile: 'lp',
      migrations: canonical.files.map(({file,checksum}) => ({file,checksum})) })).digest('hex')).not.toBe(canonical.digest);
  });
  it('generator refuses candidate purpose before inspection, imports or DB work', async () => {
    effects.calls.length = 0;
    await expect(generateCanonicalReference({ ...owned,purpose: 'candidate' })).rejects.toThrow(/independent reference/);
    expect(effects.calls).toEqual([]);
  });
  it('current candidate can never self-certify itself as reference', async () => {
    effects.calls.length = 0;
    await expect(compareCanonicalCandidate(owned,{...owned,purpose:'candidate'})).rejects.toThrow(/physically independent/);
    expect(effects.calls).toEqual([]);
  });
  it('rejects shared Docker project even if its labels pretend disposal', async () => {
    effects.calls.length = 0;
    effects.container = { Id: owned.postgresId, Image: `sha256:${owned.postgresImageId}`, State:{Running:true},
      Config:{Labels:{'swat.integration.run-id':runId,'swat.integration.purpose':'reference',
        'swat.integration.owned':'true','com.docker.compose.project':'swat'}},
      HostConfig:{Privileged:false,ReadonlyRootfs:true,Binds:[],CapDrop:['ALL'],SecurityOpt:['no-new-privileges'],PidMode:'',IpcMode:''},
      Mounts:[{Type:'tmpfs',Destination:'/var/lib/postgresql/data'}],
      NetworkSettings:{Ports:{'5432/tcp':[{HostIp:'127.0.0.1',HostPort:'55432'}]},Networks:{only:{NetworkID:'e'.repeat(64)}}} };
    await expect(assertDisposableOwnedInfrastructure(owned)).rejects.toThrow(/exact disposable-owned/);
    expect(effects.calls).toEqual([['docker','container','inspect',owned.postgresId]]);
  });
  it('rejects abbreviated/injected Docker identities without spawning', async () => {
    effects.calls.length = 0;
    await expect(assertDisposableOwnedInfrastructure({...owned,postgresId:'shared;docker stop all'})).rejects.toThrow(/full Docker identity/);
    expect(effects.calls).toEqual([]);
  });
  it('real generator applies SQL on pristine reference and independent real pg_dump, never fake catalog', () => {
    const text = source('tests/integration/helpers/schema-guard.ts');
    expect(text).toContain('await client.query(migration.sql)');
    expect(text).toContain("execute('pg_dump', ['--schema-only'");
    expect(text).toContain("if (clean.rows[0]?.dirty !== false)");
    expect(text).toContain('row.installed_checksum !== row.checksum');
    expect(text).not.toMatch(/docker.*(?:stop|start|create|kill|rm)|FLUSHALL|pg_terminate_backend|DROP DATABASE/);
  });
});

describe('forward proposal schema contracts (static, not SQL/runtime acceptance)', () => {
  it.each(['071_durable_source_fanout.sql','072_durable_risk_reservations.sql','073_durable_notification_discovery.sql'])('%s keeps explicit least privilege and forced RLS', file => {
    const text = source(`packages/db/sql/${file}`);
    expect(text).toContain('UNAPPLIED');
    expect(text).toContain('FORCE ROW LEVEL SECURITY');
    expect(text).toContain('ENABLE ROW LEVEL SECURITY');
    expect(text).toContain('REVOKE ALL');
    expect(text).not.toMatch(/CREATE ROLE|CREATE TABLE IF NOT EXISTS|SECURITY DEFINER|GRANT .*ALL TABLES|app\.bypass_rls|PASSWORD/);
  });
  it('fanout allows empty cohorts and operator exclusions, committed cohort is deferred and immutable', () => {
    const text = source('packages/db/sql/071_durable_source_fanout.sql');
    expect(text).toContain('jsonb_array_length(recipients) > 1001');
    expect(text).toContain('jsonb_array_length(exclusions) > 1001');
    expect(text).toContain("item->'userId' = 'null'::jsonb");
    expect(text).toContain('RETURN operators = 1');
    expect(text).toContain('DEFERRABLE INITIALLY DEFERRED');
    expect(text).toContain('UNIQUE NULLS NOT DISTINCT');
    expect(text).toContain('fanout snapshot descriptor/source/identity mismatch');
    expect(text).toContain('durable fanout obligations cannot be deleted');
  });
  it('risk control advances epochs without enabling a policy seed and retains liabilities', () => {
    const text = source('packages/db/sql/072_durable_risk_reservations.sql');
    expect(text).toContain('enabled boolean NOT NULL DEFAULT false');
    expect(text).toContain('accounting_ready boolean NOT NULL DEFAULT false');
    expect(text).toContain('NEW.epoch <= OLD.epoch');
    expect(text).toContain('NEW.liability_usd < OLD.liability_usd');
    expect(text).toContain('only separately authenticated risk writer');
    expect(text).not.toMatch(/INSERT INTO public.risk_policy_control/);
  });
  it('discovery lease fields match caller owner-fenced queue acknowledgement, not indexing', () => {
    const text = source('packages/db/sql/073_durable_notification_discovery.sql');
    for (const field of ['owner_token text','lease_expires_at timestamptz','updated_at timestamptz']) expect(text).toContain(field);
    expect(text).toContain('discovery_backfill_lease_repair');
    expect(text).toContain('notification identity/uncertain send cannot be reset');
    expect(text).toContain('enqueued is queue acceptance');
    expect(text).not.toContain("'indexed'");
  });
});
