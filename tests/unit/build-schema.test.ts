import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { canonicalMigrationSource, assertDisposableOwnedInfrastructure,
  generateCanonicalReference, compareCanonicalCandidate } from '../integration/helpers/schema-guard.js';
import { discoverMigrationInventory } from '../../packages/db/src/migration-discovery.js';
import { createMigrationSelectionProposal, reviewMigrationSelection } from '../../packages/db/src/migration-selection.js';
import { validatePackage28IsolationDeclarations, assertPackage28IsolationPreflight } from '../integration/helpers/package28-isolation.js';

const runId = '12345678-1234-4234-8234-123456789abc';
const env = { INTEGRATION_DISPOSABLE: 'true', INTEGRATION_RUN_ID: runId, SWAT_DB_PROFILE: 'core',
  INTEGRATION_DATABASE_URL: 'postgresql://127.0.0.1:55432/swat_integration_12345678123442348234123456789abc',
  INTEGRATION_REDIS_URL: 'redis://127.0.0.1:56379/0', INTEGRATION_REDIS_NAMESPACE: `swat:integration:${runId}` };
const owned = { env, postgresId: 'a'.repeat(64), redisId: 'b'.repeat(64),
  postgresImageId: 'c'.repeat(64), redisImageId: 'd'.repeat(64), purpose: 'reference' as const };
const effects = vi.hoisted(() => ({ calls: [] as string[][], container: {} as Record<string,unknown>,
  containers:{} as Record<string,unknown>,query:vi.fn(),connect:vi.fn(),end:vi.fn(),install:vi.fn(),validate:vi.fn() }));
vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util');
  const execFile = (command: string, args: string[], _options: unknown, callback: Function) => {
    effects.calls.push([command,...args]);
    callback(null, JSON.stringify([effects.containers[args[2]!]??effects.container]), '');
  };
  Object.assign(execFile, { [promisify.custom]: (command: string, args: string[], options: unknown) =>
    new Promise((resolve, reject) => execFile(command, args, options, (error: Error | null, stdout: string, stderr: string) =>
      error ? reject(error) : resolve({ stdout, stderr }))) });
  return { execFile };
});
vi.mock('../../packages/db/src/reference-driver.js',()=>({Client:class {
  readonly url:string;
  constructor(options:{connectionString:string}){this.url=options.connectionString;}
  connect(){return effects.connect();}
  query(sql:string,values?:unknown[]){return effects.query(sql,values,this.url);}
  end(){return effects.end();}
}}));
vi.mock('../../deploy/postgres/auth-installation.js',async()=>{
  const actual=await vi.importActual<typeof import('../../deploy/postgres/auth-installation.js')>('../../deploy/postgres/auth-installation.js');
  return {...actual,installCommittedAuthentication:effects.install,validateInstalledAuthentication:effects.validate};
});
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
    await expect(canonicalMigrationSource()).rejects.toThrow('explicit reviewed selection');
    const inventory = await discoverMigrationInventory(new URL('packages/db/sql/', root).pathname);
    const selection = reviewMigrationSelection(createMigrationSelectionProposal(inventory), 'offline-source-review-not-runtime-authorization');
    const canonical = await canonicalMigrationSource(selection);
    for (const file of canonical.files) {
      expect(file.checksum).toBe(createHash('sha256').update(readFileSync(file.path)).digest('hex'));
    }
    expect(canonical.files.some(f => f.file === '071_durable_source_fanout.sql')).toBe(true);
    expect(canonical.files.some(f => f.file === '072_durable_risk_reservations.sql')).toBe(true);
    expect(canonical.files.some(f => f.file === '073_durable_notification_discovery.sql')).toBe(true);
    const independent = createHash('sha256').update(JSON.stringify({ profile: 'core',
      migrations: canonical.files.map(({file,checksum}) => ({file,checksum})),
      selectionChecksum: selection.manifestChecksum, planChecksum: canonical.plan!.planChecksum })).digest('hex');
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
    const inspect = vi.fn(async (kind: string, id: string) => {
      effects.calls.push(['docker',kind,'inspect',id]);
      return effects.container;
    });
    await expect(assertDisposableOwnedInfrastructure(owned, inspect)).rejects.toThrow(/exact disposable-owned/);
    expect(effects.calls).toEqual([['docker','container','inspect',owned.postgresId]]);
  });
  it('rejects abbreviated/injected Docker identities without spawning', async () => {
    effects.calls.length = 0;
    await expect(assertDisposableOwnedInfrastructure({...owned,postgresId:'shared;docker stop all'})).rejects.toThrow(/full Docker identity/);
    expect(effects.calls).toEqual([]);
  });
  it('accepts isolated bridge without IP masquerade (Docker 29+) and rejects unisolated bridge', async () => {
    const netId = '5'.repeat(64);
    const labels = { 'swat.integration.run-id': runId, 'swat.integration.purpose': 'reference', 'swat.integration.owned': 'true' };
    const makeInspect = (masquerade: string, includeTmpfs = true) => vi.fn(async (kind: string, id: string) => {
      if (kind === 'network') {
        return {
          Id: netId,
          Internal: false,
          Driver: 'bridge',
          Options: { 'com.docker.network.bridge.enable_ip_masquerade': masquerade },
          Labels: labels,
          Containers: { [owned.postgresId]: {}, [owned.redisId]: {} }
        };
      }
      const isPg = id === owned.postgresId;
      const dest = isPg ? '/var/lib/postgresql/data' : '/data';
      return {
        Id: id,
        Image: `sha256:${isPg ? owned.postgresImageId : owned.redisImageId}`,
        State: { Running: true },
        Config: { Labels: labels },
        HostConfig: {
          Privileged: false, ReadonlyRootfs: true, Binds: [], CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'], PidMode: '', IpcMode: '',
          Tmpfs: includeTmpfs ? { [dest]: 'rw,noexec,nosuid,size=512m' } : {}
        },
        Mounts: [],
        NetworkSettings: {
          Ports: { [isPg ? '5432/tcp' : '6379/tcp']: [{ HostIp: '127.0.0.1', HostPort: isPg ? '55432' : '56379' }] },
          Networks: { only: { NetworkID: netId, IPAddress: isPg ? '172.18.0.2' : '172.18.0.3' } }
        }
      };
    });
    await expect(assertDisposableOwnedInfrastructure(owned, makeInspect('false', true))).resolves.toEqual({ postgresAddress: '172.18.0.2' });
    await expect(assertDisposableOwnedInfrastructure(owned, makeInspect('false', false))).rejects.toThrow(/exact disposable-owned/);
    await expect(assertDisposableOwnedInfrastructure(owned, makeInspect('true', true))).rejects.toThrow(/Disposable network is shared/);
  });
  it('087 requires separately supplied installation capabilities before reference/candidate inspection',async()=>{
    const inventory=await discoverMigrationInventory(new URL('packages/db/sql/',root).pathname);
    const selection=reviewMigrationSelection(createMigrationSelectionProposal(inventory),'offline-auth-source-review');
    const candidate={...owned,purpose:'candidate' as const,postgresId:'e'.repeat(64),redisId:'f'.repeat(64),env:{...env,INTEGRATION_RUN_ID:'22345678-1234-4234-8234-123456789abc'}};
    effects.calls.length=0;
    await expect(generateCanonicalReference(owned,selection)).rejects.toThrow('capability');
    await expect(compareCanonicalCandidate(owned,candidate,selection)).rejects.toThrow('capability');
    expect(effects.calls).toEqual([]);
  });
  it.each(['reference','candidate'] as const)('%s shared helper binds inspected and connected auth target before privileged acquisition',async stage=>{
    const inventory=await discoverMigrationInventory(new URL('packages/db/sql/',root).pathname);
    const selection=reviewMigrationSelection(createMigrationSelectionProposal(inventory),'offline-auth-binding-review');
    const candidateRun='22345678-1234-4234-8234-123456789abc';
    const candidate={...owned,purpose:'candidate' as const,postgresId:'1'.repeat(64),redisId:'2'.repeat(64),env:{...env,
      INTEGRATION_RUN_ID:candidateRun,INTEGRATION_DATABASE_URL:'postgresql://127.0.0.1:55433/swat_integration_22345678123442348234123456789abc',
      INTEGRATION_REDIS_URL:'redis://127.0.0.1:56380/0',INTEGRATION_REDIS_NAMESPACE:`swat:integration:${candidateRun}`}};
    const populate=(input:typeof owned|typeof candidate,address:string,networkId:string)=>{
      const labels={'swat.integration.run-id':input.env.INTEGRATION_RUN_ID,'swat.integration.purpose':input.purpose,'swat.integration.owned':'true'};
      for(const [id,image,url,port,data] of [[input.postgresId,input.postgresImageId,input.env.INTEGRATION_DATABASE_URL,'5432/tcp','/var/lib/postgresql/data'],
        [input.redisId,input.redisImageId,input.env.INTEGRATION_REDIS_URL,'6379/tcp','/data']]){
        effects.containers[id!]={Id:id,Image:`sha256:${image}`,State:{Running:true},Config:{Labels:labels},
          HostConfig:{Privileged:false,ReadonlyRootfs:true,Binds:[],CapDrop:['ALL'],SecurityOpt:['no-new-privileges'],PidMode:'',IpcMode:''},
          Mounts:[{Type:'tmpfs',Destination:data}],NetworkSettings:{Ports:{[port!]:[{HostIp:'127.0.0.1',HostPort:new URL(url!).port}]},
            Networks:{only:{NetworkID:networkId,IPAddress:address}}}};
      }
      effects.containers[networkId]={Id:networkId,Internal:true,Labels:labels,Containers:{[input.postgresId]:{},[input.redisId]:{}}};
    };
    const acquireDba=vi.fn(async()=>{throw new Error('No DBA lease in binding-refusal contract');});
    const referenceAuth={target:{database:new URL(env.INTEGRATION_DATABASE_URL).pathname.slice(1),address:'172.18.0.2',port:5432,systemIdentifier:'1234'},dbaRole:'fixture_dba',acquireDba};
    const candidateAuth={...referenceAuth,target:{...referenceAuth.target,database:new URL(candidate.env.INTEGRATION_DATABASE_URL).pathname.slice(1),address:'172.19.0.2',systemIdentifier:'5678'}};
    try{
      for(const hostile of ['inspected-database','inspected-address','connected-database','connected-address','connected-port','connected-system','shared-cluster']){
        effects.calls.length=0;effects.install.mockClear();effects.validate.mockClear();effects.connect.mockClear();effects.query.mockReset();
        populate(owned,'172.18.0.2','3'.repeat(64));populate(candidate,'172.19.0.2','4'.repeat(64));
        const auth={reference:{...referenceAuth,target:{...referenceAuth.target}},candidate:{...candidateAuth,target:{...candidateAuth.target}}};
        const selected=stage==='reference'?auth.reference:auth.candidate;
        if(hostile==='inspected-database')selected.target.database='uninspected';
        if(hostile==='inspected-address')selected.target.address='172.20.0.2';
        if(hostile==='shared-cluster')auth.candidate.target.systemIdentifier=auth.reference.target.systemIdentifier;
        effects.query.mockImplementation(async(s:string,_values:unknown,url:string)=>{
          if(!s.includes('current_database() AS database'))throw new Error('Binding must precede migration/catalog SQL');
          const target=url===env.INTEGRATION_DATABASE_URL?auth.reference.target:auth.candidate.target;
          const row={database:target.database,address:target.address,port:target.port,system_identifier:target.systemIdentifier};
          if(hostile==='connected-database')row.database='elsewhere';if(hostile==='connected-address')row.address='172.20.0.2';
          if(hostile==='connected-port')row.port=5433;if(hostile==='connected-system')row.system_identifier='9999';
          return {rows:[row]};
        });
        if(hostile==='shared-cluster'&&stage==='reference')continue;
        await expect(stage==='reference'?generateCanonicalReference(owned,selection,auth.reference):compareCanonicalCandidate(owned,candidate,selection,auth)).rejects.toThrow(/target differs|Independent authentication/);
        expect(effects.install).not.toHaveBeenCalled();expect(effects.validate).not.toHaveBeenCalled();expect(acquireDba).not.toHaveBeenCalled();
        expect(effects.query.mock.calls.some(([s])=>s.startsWith('BEGIN'))).toBe(false);
        if(hostile.startsWith('inspected-')||hostile==='shared-cluster')expect(effects.connect).not.toHaveBeenCalled();
      }
    }finally{effects.containers={};effects.query.mockReset();}
  });
  it('committed reference handoff is after broker retirement and checked COMMIT; candidate never provisions',()=>{
    const text=source('tests/integration/helpers/schema-guard.ts');
    const generator=text.slice(text.indexOf('export async function generateCanonicalReference'),text.indexOf('export async function compareCanonicalCandidate'));
    expect(generator.indexOf('source.plan.handoff.cleanupSql')).toBeLessThan(generator.indexOf("client.query('COMMIT')"));
    expect(generator.indexOf("commit.command !== 'COMMIT'")).toBeLessThan(generator.indexOf('installCommittedAuthentication'));
    expect(generator.indexOf('bindInspectedAuthentication')).toBeLessThan(generator.indexOf('client.connect()'));
    expect(generator.indexOf('assertAuthenticationTarget')).toBeLessThan(generator.indexOf("client.query('BEGIN')"));
    const committed=generator.slice(generator.indexOf('committing=false;open=false;'));
    expect(committed.indexOf('assertDisposableOwnedInfrastructure')).toBeLessThan(committed.indexOf('installCommittedAuthentication'));
    expect(committed.indexOf('assertAuthenticationTarget')).toBeLessThan(committed.indexOf('installCommittedAuthentication'));
    const candidate=text.slice(text.indexOf('export async function compareCanonicalCandidate'));
    expect(candidate.indexOf('bindInspectedAuthentication')).toBeLessThan(candidate.indexOf('client.connect()'));
    expect(candidate.indexOf('assertAuthenticationTarget')).toBeLessThan(candidate.indexOf('validateInstalledAuthentication'));
    expect(candidate).toContain("validateInstalledAuthentication(authentication!.candidate,authSql,'disabled')");
    expect(candidate).toContain("client.query('BEGIN READ ONLY')");
    expect(candidate).not.toContain('installCommittedAuthentication');expect(candidate).not.toContain('activateInstalledAuthentication');
    expect(candidate).toContain('generateCanonicalReference(reference, selection,authentication?.reference)');
  });
  it('real generator applies SQL on pristine reference and independent real pg_dump, never fake catalog', () => {
    const text = source('tests/integration/helpers/schema-guard.ts');
    expect(text).toContain('await client.query(installed?.installedSql ?? migration.sql)');
    expect(text).toContain("execute('pg_dump', ['--schema-only'");
    expect(text).toContain("if (clean.rows[0]?.dirty !== false)");
    expect(text).toContain('row.installed_checksum !== baseline.migrations[index]?.installed_checksum');
    expect(text).toContain('await assertInstallationBootstrap(client, source.plan)');
    expect(text).toContain('p.oid=ANY($2::oid[])');
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
    expect(text.replace(/--[^\n]*/g, '')).not.toMatch(/CREATE ROLE|CREATE TABLE IF NOT EXISTS|SECURITY DEFINER|GRANT .*ALL TABLES|app\.bypass_rls|PASSWORD/);
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
