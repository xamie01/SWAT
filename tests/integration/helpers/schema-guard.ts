import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { discoverMigrations } from '../../../packages/db/src/migration-discovery.js';
import { assertPackage28IsolationPreflight, validatePackage28IsolationDeclarations,
  type Package28IsolationEnvironment } from './package28-isolation.js';

const execute = promisify(execFile);
const sqlRoot = fileURLToPath(new URL('../../../packages/db/sql/', import.meta.url));
const lpRoot = fileURLToPath(new URL('../../../packages/db/sql-lp/', import.meta.url));
const sha = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
const hex = /^[0-9a-f]{64}$/;

/** Not a certificate format. These values are inputs to actual Docker inspection. */
export interface OwnedInfrastructure {
  readonly env: Package28IsolationEnvironment;
  readonly postgresId: string;
  readonly redisId: string;
  readonly postgresImageId: string;
  readonly redisImageId: string;
  readonly purpose: 'reference' | 'candidate';
}
type DockerContainer = {
  Id: string; Image: string; State: { Running: boolean };
  Config: { Labels: Record<string,string> };
  HostConfig: { Privileged: boolean; ReadonlyRootfs: boolean; Binds: unknown[] | null;
    CapDrop: string[]; SecurityOpt: string[]; PidMode: string; IpcMode: string };
  Mounts: { Type: string; Destination: string }[];
  NetworkSettings: { Networks: Record<string,{ NetworkID: string }>;
    Ports: Record<string, { HostIp: string; HostPort: string }[] | null> };
};
async function inspect(kind: 'container' | 'network', id: string): Promise<any> {
  if (!hex.test(id)) throw new Error('Owned infrastructure requires full Docker identity');
  const { stdout } = await execute('docker', [kind, 'inspect', id], { maxBuffer: 1024 * 1024, timeout: 10_000 });
  const rows: unknown = JSON.parse(stdout);
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error('Ambiguous Docker identity');
  return rows[0];
}

/** Read-only metadata guard. No create/start/stop/delete, network mutation or cleanup. */
export async function assertDisposableOwnedInfrastructure(input: OwnedInfrastructure): Promise<void> {
  const declaration = validatePackage28IsolationDeclarations(input.env);
  if (!['reference','candidate'].includes(input.purpose)
    || input.postgresId === input.redisId || !hex.test(input.postgresImageId) || !hex.test(input.redisImageId)) {
    throw new Error('Distinct owned infrastructure and approved immutable image identities required');
  }
  let networkId: string | undefined;
  for (const [id, image, endpoint, port, data] of [
    [input.postgresId,input.postgresImageId,declaration.databaseUrl,'5432/tcp','/var/lib/postgresql/data'],
    [input.redisId,input.redisImageId,declaration.redisUrl,'6379/tcp','/data']
  ]) {
    const c: DockerContainer = await inspect('container', id!);
    const labels = c.Config.Labels;
    const bindings = c.NetworkSettings.Ports[port!];
    const networks = Object.values(c.NetworkSettings.Networks);
    if (c.Id !== id || c.Image !== `sha256:${image}` || !c.State.Running
      || labels?.['swat.integration.run-id'] !== declaration.runId
      || labels?.['swat.integration.purpose'] !== input.purpose || labels?.['swat.integration.owned'] !== 'true'
      || labels?.['com.docker.compose.project'] === 'swat'
      || c.HostConfig.Privileged || !c.HostConfig.ReadonlyRootfs || (c.HostConfig.Binds?.length ?? 0) !== 0
      || !c.HostConfig.CapDrop?.includes('ALL') || !c.HostConfig.SecurityOpt?.includes('no-new-privileges')
      || c.HostConfig.PidMode === 'host' || c.HostConfig.IpcMode === 'host'
      || c.Mounts.some(m => m.Type !== 'tmpfs') || !c.Mounts.some(m => m.Destination === data)
      || !bindings || bindings.length !== 1 || bindings[0]?.HostIp !== '127.0.0.1'
      || bindings[0]?.HostPort !== new URL(endpoint!).port
      || Object.entries(c.NetworkSettings.Ports).some(([key,value]) => key !== port && value !== null)
      || networks.length !== 1 || (networkId !== undefined && networks[0]?.NetworkID !== networkId)) {
      throw new Error('Infrastructure is not exact disposable-owned loopback/tmpfs isolated Docker inventory');
    }
    networkId = networks[0]!.NetworkID;
  }
  const network = await inspect('network', networkId!);
  if (network.Id !== networkId || network.Internal !== true
    || network.Labels?.['swat.integration.run-id'] !== declaration.runId
    || network.Labels?.['swat.integration.purpose'] !== input.purpose
    || Object.keys(network.Containers ?? {}).sort().join(',') !== [input.postgresId,input.redisId].sort().join(',')) {
    throw new Error('Disposable network is shared or has unowned peers');
  }
}

/** Actual canonical source selection, never a highest-filename/existence guess. */
export async function canonicalMigrationSource() {
  // Current production discovery ignores sql-lp. Refuse rather than pretend it ships.
  const lp = await readdir(lpRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []; throw error;
  });
  if (lp.some(file => file.endsWith('.sql'))) throw new Error('sql-lp is nonempty but ignored by actual canonical migration discovery');
  const files = await discoverMigrations(sqlRoot);
  return { files, digest: sha(JSON.stringify({ profile: 'core',
    migrations: files.map(({ file,checksum }) => ({ file,checksum })) })) };
}

// Structural catalog with symbolic identities (no unstable OIDs). pg_dump below
// additionally covers all schema DDL, owners, ACLs, constraints, indexes, routines,
// triggers, RLS, extensions, types, sequences and views; role/default ACL fields
// are retained separately, rather than excluding privilege drift.
const roleCatalogSql = `SELECT jsonb_build_object(
  'roles', (SELECT jsonb_agg(jsonb_build_object('name',rolname,'super',rolsuper,'inherit',rolinherit,
    'createRole',rolcreaterole,'createDb',rolcreatedb,'login',rolcanlogin,'replication',rolreplication,
    'bypassRls',rolbypassrls,'config',rolconfig) ORDER BY rolname) FROM pg_roles WHERE rolname LIKE 'swat\\_%' ESCAPE '\\'),
  'memberships', (SELECT jsonb_agg(jsonb_build_object('role',r.rolname,'member',m.rolname,'admin',a.admin_option)
    ORDER BY r.rolname,m.rolname) FROM pg_auth_members a JOIN pg_roles r ON r.oid=a.roleid JOIN pg_roles m ON m.oid=a.member
    WHERE r.rolname LIKE 'swat\\_%' ESCAPE '\\' OR m.rolname LIKE 'swat\\_%' ESCAPE '\\'),
  'database', (SELECT jsonb_build_object('owner',pg_get_userbyid(datdba),'acl',datacl::text,'encoding',encoding,
    'collate',datcollate,'ctype',datctype) FROM pg_database WHERE datname=current_database())
) AS catalog`;

async function captureCatalog(databaseUrl: string, client: { query: (sql: string) => Promise<{rows: any[]}> }) {
  // pg_dump is a real read-only independent schema serialization, not existence.
  // Credentials are passed via PGPASSWORD, not argv or report output.
  const url = new URL(databaseUrl);
  const { stdout: version } = await execute('pg_dump', ['--version'], { timeout: 10_000 });
  const server = await client.query('SHOW server_version_num');
  if (!/\b16\./.test(version) || !String(server.rows[0]?.server_version_num).startsWith('16')) {
    throw new Error('Canonical reference requires reviewed PostgreSQL16 server/pg_dump parity');
  }
  const { stdout } = await execute('pg_dump', ['--schema-only','--host','127.0.0.1','--port',url.port,
    '--username',decodeURIComponent(url.username),'--dbname',url.pathname.slice(1),'--no-password'], {
    env: { PATH: process.env.PATH, LANG: 'C', PGPASSWORD: decodeURIComponent(url.password),
      PGOPTIONS: '-c search_path=pg_catalog', PGCONNECT_TIMEOUT: '5' },
    timeout: 30_000, maxBuffer: 16 * 1024 * 1024
  });
  // pg_dump16 may emit random restrict tokens in patched versions. They are dump
  // reader guards, not schema. Strip only comments and those exact control lines.
  const ddl = stdout.split('\n').filter(line => !line.startsWith('--')
    && !/^\\(?:un)?restrict \S+$/.test(line)).join('\n').trim();
  const roles = (await client.query(roleCatalogSql)).rows[0]?.catalog;
  if (!roles || !ddl.includes('CREATE TABLE public.swat_schema_migrations')) throw new Error('Incomplete real canonical catalog');
  // Database names differ by run. ACL representation contains only principals.
  return { ddl, roles, digest: sha(JSON.stringify({ ddl,roles })) };
}

export interface CanonicalReference {
  readonly profile: 'core';
  readonly sourceDigest: string;
  readonly catalogDigest: string;
  readonly postgresId: string;
  readonly runId: string;
  readonly migrations: readonly { file: string; checksum: string }[];
}

/** REAL generator, explicitly mutates ONLY an independently owned pristine
 * reference. No caller in config/CLI invokes it. NOT EXECUTED/QUALIFIED here.
 * It is not safe to authorize it by a flag: coordinator must review source and
 * separately authorize isolated provisioning/execution first.
 */
export async function generateCanonicalReference(input: OwnedInfrastructure): Promise<CanonicalReference> {
  if (input.purpose !== 'reference') throw new Error('Canonical generator requires independent reference infrastructure');
  await assertDisposableOwnedInfrastructure(input);
  const declaration = validatePackage28IsolationDeclarations(input.env);
  const source = await canonicalMigrationSource();
  const { Client } = await import('pg');
  const client = new Client({ connectionString: declaration.databaseUrl, connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    await client.query('BEGIN');
    const role = await client.query(`SELECT current_user AS role, session_user AS session,
      current_setting('row_security') AS rls`);
    if (role.rows[0]?.role !== 'swat_migrator' || role.rows[0]?.session !== 'swat_migrator' || role.rows[0]?.rls !== 'on') {
      throw new Error('Reference generator requires separately provisioned migrator session');
    }
    const clean = await client.query(`SELECT
      EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp_%')
      OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname NOT IN ('pg_catalog','information_schema')) AS dirty`);
    if (clean.rows[0]?.dirty !== false) throw new Error('Reference must be genuinely pristine, never candidate/current-schema self-certification');
    await client.query('SET LOCAL search_path = public, pg_catalog');
    await client.query(`CREATE TABLE public.swat_schema_migrations (
      file text PRIMARY KEY, checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
      installed_checksum text NOT NULL CHECK (installed_checksum ~ '^[a-f0-9]{64}$'), audit_reference text,
      recorded_at timestamptz NOT NULL DEFAULT now(), recorded_by text NOT NULL DEFAULT session_user)`);
    for (const migration of source.files) {
      await client.query(migration.sql);
      await client.query('INSERT INTO public.swat_schema_migrations(file,checksum,installed_checksum) VALUES($1,$2,$2)', [migration.file,migration.checksum]);
    }
    await client.query('REVOKE ALL ON public.swat_schema_migrations FROM PUBLIC, swat_app');
    const commit = await client.query('COMMIT');
    if (commit.command !== 'COMMIT') throw new Error('Independent reference transaction did not commit');
    const catalog = await captureCatalog(declaration.databaseUrl,client);
    await assertDisposableOwnedInfrastructure(input);
    return { profile: 'core', sourceDigest: source.digest, catalogDigest: catalog.digest,
      postgresId: input.postgresId, runId: declaration.runId,
      migrations: source.files.map(({file,checksum}) => ({file,checksum})) };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { await client.end(); }
}

/** Read-only comparison to a newly regenerated independent reference. An input
 * JSON/path/digest alone is intentionally insufficient. No cleanup or fault API.
 */
export async function compareCanonicalCandidate(reference: OwnedInfrastructure, candidate: OwnedInfrastructure): Promise<void> {
  if (candidate.purpose !== 'candidate' || candidate.postgresId === reference.postgresId
    || candidate.redisId === reference.redisId || candidate.env.INTEGRATION_RUN_ID === reference.env.INTEGRATION_RUN_ID) {
    throw new Error('Candidate and generated reference must be physically independent');
  }
  await assertDisposableOwnedInfrastructure(candidate);
  const baseline = await generateCanonicalReference(reference);
  const declaration = validatePackage28IsolationDeclarations(candidate.env);
  const { Client } = await import('pg');
  const client = new Client({ connectionString: declaration.databaseUrl, connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const history = await client.query('SELECT file,checksum,installed_checksum,audit_reference FROM public.swat_schema_migrations ORDER BY file');
    if (history.rows.length !== baseline.migrations.length || history.rows.some((row,index) =>
      row.file !== baseline.migrations[index]?.file || row.checksum !== baseline.migrations[index]?.checksum
      || row.installed_checksum !== row.checksum || row.audit_reference !== null)) {
      throw new Error('Candidate migration journal is not exact unapplied-source replay');
    }
    const catalog = await captureCatalog(declaration.databaseUrl,client);
    if (catalog.digest !== baseline.catalogDigest) throw new Error('Candidate canonical catalog/roles/ACL/RLS differs from independently generated reference');
    await client.query('COMMIT');
    await assertDisposableOwnedInfrastructure(candidate);
  } finally { await client.end(); }
}

/** Import-safe mandatory runtime refusal until the above real generator and
 * disposable guard have independent actual-infrastructure review evidence. */
export async function assertIntegrationSchemaCurrent(): Promise<void> {
  return assertPackage28IsolationPreflight(process.env);
}
