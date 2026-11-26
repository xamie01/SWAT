import { createRequire } from 'node:module';
import { canonicalMigrationSource, assertDisposableOwnedInfrastructure } from '../../integration/helpers/schema-guard.js';
import { assertDatabaseRole } from '../../../packages/db/src/database-role.js';
import { assertInstallationBootstrap, assertInstallationHistory } from '../../../packages/db/src/installation-plan.js';
import type { ReviewedMigrationSelection } from '../../../packages/db/src/migration-selection.js';
import { authenticationInstallationSource,installCommittedAuthentication,validateInstalledAuthentication,type AuthenticationInstallation } from '../../../deploy/postgres/auth-installation.js';
import { declarations, hash, normalizeServerAddress, requireCheck, transaction, type Environment, type QualificationConfig, type SqlClient } from './core.js';

import { Deadline, tmpfsBytes } from './containment.js';
import { OwnedClients as BoundedOwnedClients } from './owned-clients.js';
import { command } from './owned-command.js';
export { command } from './owned-command.js';
const pgRequire = createRequire(new URL('../../../packages/db/package.json', import.meta.url));
const redisRequire = createRequire(new URL('../../../apps/api/package.json', import.meta.url));
function owned(e: Environment, purpose: 'reference' | 'candidate') {
  const d = declarations(e);
  return { env: { INTEGRATION_DISPOSABLE: 'true', INTEGRATION_RUN_ID: d.runId, SWAT_DB_PROFILE: 'core',
    INTEGRATION_DATABASE_URL: d.databaseUrl, INTEGRATION_REDIS_URL: d.redisUrl, INTEGRATION_REDIS_NAMESPACE: d.redisNamespace },
    postgresId: e.postgres.containerId, redisId: e.redis.containerId, postgresImageId: e.postgres.imageId,
    redisImageId: e.redis.imageId, purpose };
}
export async function inspectEnvironment(e: Environment, purpose: 'reference' | 'candidate', deadline: Deadline) {
  await assertDisposableOwnedInfrastructure(owned(e, purpose), async (kind, id) => {
    requireCheck(/^[a-f0-9]{64}$/.test(id), 'Full owned Docker identity required');
    const { stdout } = await command(deadline, 'docker', [kind, 'inspect', id]);
    const rows = JSON.parse(stdout);
    requireCheck(Array.isArray(rows) && rows.length === 1, 'Ambiguous Docker identity');
    return rows[0];
  });
  const addresses: string[] = [];
  for (const endpoint of [e.postgres, e.redis]) {
    const { stdout } = await command(deadline, 'docker', ['container', 'inspect', endpoint.containerId]);
    const c = JSON.parse(stdout)[0];
    requireCheck(c.Id === endpoint.containerId && c.HostConfig.Memory === endpoint.memoryBytes
      && c.HostConfig.NanoCpus === endpoint.nanoCpus && c.HostConfig.MemorySwap === endpoint.memoryBytes
      && c.HostConfig.PidsLimit > 0 && c.HostConfig.PidsLimit <= 256
      && Object.keys(c.HostConfig.Tmpfs ?? {}).length > 0, 'Inspected resource bounds differ from owned inventory');
    let totalTmpfs = 0;
    for (const [mount, options] of Object.entries(c.HostConfig.Tmpfs) as [string, string][]) {
      requireCheck(/^\/(?:tmp|run|data|var\/lib\/postgresql\/data)$/.test(mount), 'Every tmpfs requires approved mount');
      totalTmpfs += tmpfsBytes(options);
    }
    requireCheck(totalTmpfs <= endpoint.memoryBytes, 'Aggregate tmpfs exceeds owned container memory bound');
    const networks = Object.values(c.NetworkSettings.Networks) as { IPAddress: string }[];
    requireCheck(networks.length === 1 && /^\d+\.\d+\.\d+\.\d+$/.test(networks[0]!.IPAddress), 'Exact inspected container address required');
    addresses.push(networks[0]!.IPAddress);
  }
  return { postgres: addresses[0]!, redis: addresses[1]! };
}
export class OwnedClients extends BoundedOwnedClients {
  constructor(deadline: Deadline) {
    super(deadline, {
      postgres: (url, name, timeout) => {
        const { Client } = pgRequire('pg');
        return new Client({ connectionString: url, application_name: name, connectionTimeoutMillis: timeout,
          query_timeout: 12_000 });
      },
      redis: (url, name, timeout) => {
        const Redis = redisRequire('ioredis');
        return new Redis(url, { lazyConnect: true, connectionName: name, connectTimeout: timeout, commandTimeout: 10_000,
          enableOfflineQueue: false, maxRetriesPerRequest: 0, retryStrategy: () => null });
      }
    });
  }
}
export async function bindPostgres(client: SqlClient, e: Environment, address: string, deadline: Deadline) {
  const privilege = await client.query("SELECT has_function_privilege(current_user,'pg_catalog.pg_control_system()','EXECUTE') AS allowed");
  requireCheck(privilege.rows[0]?.allowed === true, 'Narrow independently provisioned PostgreSQL identity observation capability unavailable');
  const identity = await client.query(`SELECT current_database() AS database, inet_server_addr()::text AS address,
    inet_server_port() AS port, current_setting('server_version_num') AS version,
    system_identifier::text AS system_id FROM pg_catalog.pg_control_system()`);
  const row = identity.rows[0];
  const { stdout } = await command(deadline, 'docker', ['exec', e.postgres.containerId, 'pg_controldata', '/var/lib/postgresql/data']);
  const systemId = /^Database system identifier:\s+(\d+)$/m.exec(stdout)?.[1];
  requireCheck(identity.rows.length === 1 && row.database === new URL(e.postgres.url).pathname.slice(1)
    && normalizeServerAddress(row.address) === address && row.port === 5432 && /^16\d{4}$/.test(row.version)
    && systemId && row.system_id === systemId, 'Connected PostgreSQL cluster differs from inspected owned identity');
  await assertDatabaseRole(client as any, 'migration');
  return row.system_id as string;
}
async function observeRedisIdentity(client: any, address: string) {
  const info = await client.info('server');
  const connection = await client.call('CLIENT', 'INFO');
  const local = /(?:^| )laddr=([^ ]+)/.exec(connection)?.[1];
  const database = /(?:^| )db=(\d+)(?: |\r?\n|$)/.exec(connection)?.[1];
  const runId = /^run_id:([a-f0-9]{40})\r?$/m.exec(info)?.[1];
  requireCheck(/^redis_version:7\./m.test(info) && local === `${address}:6379` && database === '0' && runId,
    'Connected Redis differs from inspected Redis7 database');
  return runId as string;
}
export async function bindRedisIdentity(client: any, address: string, expectedRunId: string) {
  requireCheck(typeof expectedRunId === 'string' && /^[a-f0-9]{40}$/.test(expectedRunId), 'Previously observed Redis run identity required');
  const runId = await observeRedisIdentity(client,address);
  requireCheck(runId === expectedRunId,'Populated Redis run identity changed');
  return runId;
}
export async function bindRedis(client: any, address: string) {
  const runId = await observeRedisIdentity(client, address);
  requireCheck(Number(await client.dbsize()) === 0, 'Connected Redis must be exact inspected pristine Redis7');
  return runId;
}
export async function migratePristine(client: SqlClient, deadline: Deadline, selection?: ReviewedMigrationSelection,authentication?:AuthenticationInstallation) {
  deadline.check();
  const source = await canonicalMigrationSource(selection);
  const authSql=authenticationInstallationSource(source,authentication);
  deadline.check();
  await transaction(client, null, async c => {
    await assertDatabaseRole(c as any, 'migration');
    const bootstrap = source.plan ? await assertInstallationBootstrap(c, source.plan) : null;
    const clean = await c.query(`SELECT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp_%')
      OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname NOT IN ('pg_catalog','information_schema')
        AND NOT (p.pronamespace=$1::oid AND p.oid=ANY($2::oid[]))) AS dirty`,
      [bootstrap?.namespaceOid ?? 0, bootstrap?.functionOids ?? []]);
    requireCheck(clean.rows[0]?.dirty === false, 'Canonical migration target is not pristine');
    await c.query('SET LOCAL search_path = public, pg_catalog');
    await c.query(`CREATE TABLE public.swat_schema_migrations(file text PRIMARY KEY,
      checksum text NOT NULL CHECK(checksum ~ '^[a-f0-9]{64}$'),
      installed_checksum text NOT NULL CHECK(installed_checksum ~ '^[a-f0-9]{64}$'), audit_reference text,
      recorded_at timestamptz NOT NULL DEFAULT now(), recorded_by text NOT NULL DEFAULT session_user)`);
    for (const migration of source.files) {
      deadline.check();
      const installed = source.plan?.migrations.find(row => row.file === migration.file);
      await c.query(installed?.installedSql ?? migration.sql);
      await c.query('INSERT INTO public.swat_schema_migrations(file,checksum,installed_checksum,audit_reference) VALUES($1,$2,$3,$4)',
        [migration.file, migration.checksum, installed?.installedChecksum ?? migration.checksum, installed?.auditReference ?? null]);
    }
    if (source.plan) await c.query(source.plan.handoff.cleanupSql);
    await c.query('REVOKE ALL ON public.swat_schema_migrations FROM PUBLIC, swat_app');
  });
  // transaction() must have returned a checked COMMIT before external DBA acquisition.
  if(authSql){deadline.check();await installCommittedAuthentication(authentication!,authSql);deadline.check();}
  return source;
}
export async function catalog(client: SqlClient, url: string, deadline: Deadline, selection?: ReviewedMigrationSelection,authentication?:AuthenticationInstallation) {
  const source = await canonicalMigrationSource(selection);
  const authSql=authenticationInstallationSource(source,authentication);
  if(authSql){deadline.check();await validateInstalledAuthentication(authentication!,authSql,'disabled');deadline.check();}
  const u = new URL(url);
  const username = decodeURIComponent(u.username), password = decodeURIComponent(u.password);
  requireCheck(/\b16\./.test((await command(deadline, 'pg_dump', ['--version'])).stdout), 'PostgreSQL16 pg_dump required');
  const { stdout } = await command(deadline, 'pg_dump', ['--schema-only', '--host', '127.0.0.1', '--port', u.port,
    '--username', username, '--dbname', u.pathname.slice(1), '--no-password'],
    { PGPASSWORD: password, PGOPTIONS: '-c search_path=pg_catalog', PGCONNECT_TIMEOUT: '5' }, 16 * 1024 * 1024);
  const ddl = stdout.split('\n').filter(line => !line.startsWith('--') && !/^\\(?:un)?restrict \S+$/.test(line)).join('\n').trim();
  const roles = (await client.query(`SELECT jsonb_build_object(
    'roles',(SELECT jsonb_agg(jsonb_build_object('name',rolname,'super',rolsuper,'inherit',rolinherit,
      'createRole',rolcreaterole,'createDb',rolcreatedb,'login',rolcanlogin,'replication',rolreplication,
      'bypassRls',rolbypassrls,'config',rolconfig) ORDER BY rolname) FROM pg_roles WHERE rolname LIKE 'swat\\_%' ESCAPE '\\'),
    'memberships',(SELECT jsonb_agg(jsonb_build_object('role',r.rolname,'member',m.rolname,'admin',a.admin_option)
      ORDER BY r.rolname,m.rolname) FROM pg_auth_members a JOIN pg_roles r ON r.oid=a.roleid JOIN pg_roles m ON m.oid=a.member
      WHERE r.rolname LIKE 'swat\\_%' ESCAPE '\\' OR m.rolname LIKE 'swat\\_%' ESCAPE '\\'),
    'database',(SELECT jsonb_build_object('owner',pg_get_userbyid(datdba),'acl',datacl::text,'encoding',encoding,
      'collate',datcollate,'ctype',datctype) FROM pg_database WHERE datname=current_database())) AS catalog`)).rows[0]?.catalog;
  const journal = (await client.query('SELECT file,checksum,installed_checksum,audit_reference FROM public.swat_schema_migrations ORDER BY file')).rows;
  requireCheck(journal.length === source.files.length, 'Migration journal mismatch');
  if (source.plan) {
    try { assertInstallationHistory(journal, source.plan); } catch { throw new Error('Migration journal mismatch'); }
  } else requireCheck(journal.every((r, i) => r.file === source.files[i]?.file
    && r.checksum === source.files[i]?.checksum && r.installed_checksum === r.checksum && r.audit_reference === null), 'Migration journal mismatch');
  requireCheck(ddl.includes('CREATE TABLE public.swat_schema_migrations') && roles, 'Incomplete catalog capture');
  return { digest: hash({ ddl, roles }), sourceDigest: source.digest, journalDigest: hash(journal), journal, ddl, roles };
}
export async function inspectBoth(c: QualificationConfig, deadline: Deadline) {
  return { reference: await inspectEnvironment(c.reference, 'reference', deadline), candidate: await inspectEnvironment(c.candidate, 'candidate', deadline) };
}
