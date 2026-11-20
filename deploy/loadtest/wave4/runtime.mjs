import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { loadConfig, requireValue, sampleIndices, base58, digest, writeNewJson, plan } from './core.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const dbRequire = createRequire(`${root}/packages/db/package.json`);
const apiRequire = createRequire(`${root}/apps/api/package.json`);
export async function db(endpoint, name) {
  const { Client } = dbRequire('pg');
  const client = new Client({ ...endpoint, application_name: `wave4-${name}`, connectionTimeoutMillis: 5000, query_timeout: 10000 });
  client.on('error', () => {});
  await client.connect();
  return client;
}
export function redis(endpoint) {
  const Redis = apiRequire('ioredis');
  const client = new Redis({ ...endpoint, lazyConnect: true, connectTimeout: 5000, commandTimeout: 10000, maxRetriesPerRequest: 1, retryStrategy: () => null, enableOfflineQueue: false });
  client.on('error', () => {});
  return client;
}

export async function reviewedLoadMigrationSource(selection) {
  requireValue(selection, 'Explicit reviewed migration selection required before load');
  const { tsImport } = await import('tsx/esm/api');
  const { canonicalMigrationSource } = await tsImport(`${root}/packages/db/src/canonical-migration-source.ts`, import.meta.url);
  const { assertInstallationHistory } = await tsImport(`${root}/packages/db/src/installation-plan.ts`, import.meta.url);
  const source = await canonicalMigrationSource(selection);
  requireValue(source.plan, 'Require exact reviewed installation plan before connections');
  return { source, assertInstallationHistory };
}

export async function qualify(c, out) {
  const { source, assertInstallationHistory } = await reviewedLoadMigrationSource(c.migrationSelection);
  const clients = [];
  let r;
  try {
    const observer = await db(c.monitorDb, 'observer'); clients.push(observer);
    const runtime = await db(c.runtimeDb, 'runtime'); clients.push(runtime);
    const pool = await db(c.poolAdmin, 'pool-admin'); clients.push(pool);
    const seed = await db(c.seedDb, 'seeder'); clients.push(seed);
    const info = async client => (await client.query(`SELECT current_database() AS database, current_user AS role,
      inet_server_addr()::text AS address, inet_server_port() AS port, pg_postmaster_start_time() AS started,
      current_setting('server_version_num')::int AS version,
      r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE rolname=current_user`)).rows[0];
    const [o, a, s] = await Promise.all([info(observer), info(runtime), info(seed)]);
    requireValue([o, a, s].every(i => i.database === c.expectedDatabase && i.version >= 160000 && i.version < 170000), 'Require same PostgreSQL 16 database');
    requireValue([a, s].every(i => i.address === o.address && i.port === o.port && String(i.started) === String(o.started)), 'Pool/direct connections reach different PostgreSQL instances');
    requireValue(a.role === 'swat_app' && !a.rolsuper && !a.rolbypassrls, 'Runtime role must not bypass RLS');
    requireValue(s.role === 'swat_migrator' && !s.rolsuper && !s.rolbypassrls && o.role === c.monitorDb.user && !o.rolsuper && !o.rolbypassrls, 'Seeder must be separately approved swat_migrator; observer must be a non-superuser read-only identity');
    const observerPrivileges = (await observer.query("SELECT pg_has_role(current_user,'pg_read_all_stats','MEMBER') AS stats, has_table_privilege(current_user,'users','INSERT') AS writer")).rows[0];
    requireValue(observerPrivileges.stats && !observerPrivileges.writer, 'Observer requires pg_read_all_stats but must not write user rows');
    const catalog = (await observer.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, owner.rolname AS owner
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles owner ON owner.oid=c.relowner
      WHERE n.nspname='public' AND c.relname IN ('users','user_sessions','user_wallet_subscriptions','user_execution_settings')`)).rows;
    requireValue(catalog.length === 4 && catalog.every(t => t.relrowsecurity && t.relforcerowsecurity && t.owner !== 'swat_app'), 'Missing forced tenant RLS or unsafe ownership');
    await runtime.query('BEGIN');
    await runtime.query("SELECT set_config('app.current_user_id','',true), set_config('app.bypass_rls','off',true)");
    const empty = await runtime.query('SELECT count(*)::int AS count FROM users');
    requireValue(empty.rows[0].count === 0, 'Unscoped runtime can see user rows');
    await runtime.query('ROLLBACK');
    const history = (await observer.query('SELECT file, checksum, installed_checksum, audit_reference FROM swat_schema_migrations ORDER BY file')).rows;
    requireValue(history.length === source.plan.migrations.length, 'Require exact reviewed installation plan journal');
    assertInstallationHistory(history, source.plan);
    const requiredReads = ['wallets','transactions','wallet_clusters','cluster_memberships','signals','source_trades'];
    const reads = (await observer.query("SELECT name, has_table_privilege('swat_app',name,'SELECT') AS permitted FROM unnest($1::text[]) name", [requiredReads])).rows;
    requireValue(reads.length === requiredReads.length && reads.every(row => row.permitted), 'Reviewed runtime global-read capability is missing; refuse before seeding');
    const sourceColumns = (await observer.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='source_trades'")).rows.map(row => row.column_name);
    requireValue(['source_event_type','source_event_id','confirmation_state','event_at'].every(name => sourceColumns.includes(name)), 'Source fixture schema is incomplete');
    const settings = (await observer.query(`SELECT name, setting FROM pg_settings WHERE name IN
      ('log_lock_waits','deadlock_timeout','log_min_duration_statement','shared_preload_libraries','track_io_timing','logging_collector','log_destination')`)).rows;
    const get = name => settings.find(row => row.name === name)?.setting;
    requireValue(get('log_lock_waits') === 'on' && get('track_io_timing') === 'on' && Number(get('log_min_duration_statement')) >= 0 && Number(get('log_min_duration_statement')) <= 1000 && Number(get('deadlock_timeout')) <= 1000 && get('shared_preload_libraries')?.includes('pg_stat_statements'), 'Configure lock/slow-query/I/O monitoring before run');
    await observer.query('SELECT queryid, calls FROM pg_stat_statements LIMIT 1');
    const poolConfig = (await pool.query('SHOW CONFIG')).rows;
    requireValue(poolConfig.find(row => row.key === 'pool_mode')?.value === 'transaction', 'PgBouncer must use transaction pooling');
    const poolVersion = (await pool.query('SHOW VERSION')).rows;
    for (const command of ['SHOW POOLS', 'SHOW STATS', 'SHOW CLIENTS', 'SHOW SERVERS']) await pool.query(command);
    r = redis(c.redis); await r.connect();
    requireValue((await r.info('server')).includes('redis_version:7.'), 'Require Redis 7');
    for (const queue of c.queues) requireValue(await r.exists(`${c.queuePrefix}:${queue}:meta`) === 1, `Missing initialized queue ${queue}`);
    const evidence = { qualifiedAt: new Date().toISOString(), observer: o, runtime: a, seeder: s, catalog, settings, history, poolConfig, poolVersion, attestations: c.attestations, evidence: c.evidence, runtimeAccepted: false };
    await writeNewJson(`${out}/preflight.json`, evidence);
    return evidence;
  } finally { r?.disconnect(); await Promise.all(clients.map(client => client.end())); }
}

async function insertRows(client, table, columns, rows) {
  const params = rows.flat();
  const placeholders = rows.map((row, i) => `(${row.map((_, j) => `$${i * columns.length + j + 1}`).join(',')})`).join(',');
  await client.query(`INSERT INTO ${table} (${columns.join(',')}) VALUES ${placeholders}`, params);
}

export async function seed(c, out) {
  const client = await db(c.seedDb, 'seeder');
  try {
    const before = (await client.query(`SELECT (SELECT count(*) FROM users)::int AS users,
      (SELECT count(*) FROM wallets)::int AS wallets, (SELECT count(*) FROM signals)::int AS signals,
      (SELECT count(*) FROM source_trades)::int AS source_trades`)).rows[0];
    requireValue(Object.values(before).every(count => count === 0), 'Seeder requires an empty disposable cohort/observation database; no reuse or cleanup');
    const { hash } = dbRequire('@node-rs/argon2');
    const passwordHash = await hash(randomBytes(32).toString('base64url'), { memoryCost: 47104, timeCost: 1, parallelism: 1 });
    const selected = new Set(sampleIndices(c.seedCount, c.sampleCount));
    const identities = [];
    for (let offset = 0; offset < c.seedCount;) {
      const batchSize = offset === 0 ? 10 : 500;
      const users = [], sessions = [], pilot = [];
      for (let i = offset; i < Math.min(offset + batchSize, c.seedCount); i++) {
        const id = randomUUID(), token = randomBytes(32).toString('base64url');
        users.push([id, `w4-${c.runId}-${i}@load.invalid`, passwordHash, `wave4-${i}`, 'user', 'free', 'active']);
        sessions.push([randomUUID(), id, Buffer.from(digest(token), 'hex'), new Date(Date.now() + 86400000), 'wave4-synthetic-session']);
        if (offset === 0) pilot.push({ id, token });
        if (selected.has(i)) identities.push({ id, token, csrf: randomBytes(24).toString('base64url'), historyWallet: `solana:${base58(randomBytes(32))}`, queueWallet: base58(randomBytes(32)), queueToken: base58(randomBytes(32)) });
      }
      await client.query('BEGIN');
      try {
        await insertRows(client, 'users', ['id', 'email', 'password_hash', 'display_name', 'role', 'tier', 'status'], users);
        await insertRows(client, 'user_sessions', ['id', 'user_id', 'token_hash', 'expires_at', 'user_agent'], sessions);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      if (offset === 0) {
        for (const identity of pilot) {
          const response = await fetch(`${new URL(c.baseUrl).origin}/v1/auth/me`, { headers: { Cookie: `swat_session=${identity.token}` }, redirect: 'manual', signal: AbortSignal.timeout(10000) });
          requireValue(response.status === 200 && (await response.json()).user?.id === identity.id, 'Pilot authentication failed; only ten users retained, bulk seeding refused');
        }
        await writeNewJson(`${out}/auth-pilot.json`, { users: 10, authenticated: true, bulkSeedAllowed: true });
      }
      offset += batchSize;
    }
    // Source observations are synthetic, unverified and never produce financial authority.
    for (let offset = 0; offset < identities.length; offset += 100) {
      await client.query('BEGIN');
      try {
        for (const identity of identities.slice(offset, offset + 100)) {
          const cluster = randomUUID();
          await client.query("INSERT INTO wallets(address,chain,nickname,status) VALUES($1,'solana','wave4 synthetic observation','active')", [identity.historyWallet]);
          await client.query("INSERT INTO user_wallet_subscriptions(user_id,wallet_address,label,membership_slot) VALUES($1,$2,'wave4 observation',1)", [identity.id, identity.historyWallet]);
          await client.query("INSERT INTO wallet_clusters(id,name,confidence,wallet_count,chain,status) VALUES($1,'wave4 synthetic',0,1,'solana','inactive')", [cluster]);
          await client.query('INSERT INTO cluster_memberships(cluster_id,wallet_address,confidence) VALUES($1,$2,0)', [cluster, identity.historyWallet]);
          await client.query(`INSERT INTO signals(cluster_id,pattern_type,confidence,signal_score,trigger_data,status,detected_at)
            VALUES($1,'accumulation',0,0,'{"synthetic":true,"verified":false}','expired',NOW()-interval '1 day')`, [cluster]);
          await client.query(`INSERT INTO transactions(signature,wallet_address,amount_in,amount_out,direction,timestamp)
            SELECT $1||'-'||n,$2,1,1,'buy',NOW()-n*interval '1 minute' FROM generate_series(1,5) n`, [randomUUID(), identity.historyWallet]);
          await client.query(`INSERT INTO source_trades(chain,transaction_hash,wallet_address,token_mint,direction,token_amount,status,event_at,source_event_type,source_event_id,confirmation_state)
            VALUES('solana',$1,$2,$3,'buy',1,'observed',NOW()-interval '1 day','transaction',$1,'observed')`, [randomUUID(), identity.historyWallet, `solana:${identity.queueToken}`]);
          await client.query('INSERT INTO user_execution_settings(user_id,auto_execute) VALUES($1,false)', [identity.id]);
        }
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
    }
    // Shuffle again so VU order is independent of the insertion order.
    const shuffled = sampleIndices(identities.length, identities.length).map(i => identities[i]);
    const after = (await client.query(`SELECT count(*)::int AS users FROM users WHERE email LIKE $1`, [`w4-${c.runId}-%@load.invalid`])).rows[0];
    requireValue(after.users === c.seedCount, 'Seed cohort count mismatch');
    await writeNewJson(`${out}/identities.json`, shuffled);
    await writeNewJson(`${out}/seed.json`, { runId: c.runId, users: after.users, sessions: c.seedCount, sampledIdentities: shuffled.length, walletFixtures: shuffled.length, transactionFixtures: shuffled.length * 5, feedFixtures: shuffled.length, signalFixtures: shuffled.length, passwordDiscarded: true, manifestSha256: digest(JSON.stringify(shuffled) + '\n'), verifiedFinancialEvidence: false });
    return shuffled;
  } finally { await client.end(); }
}

export async function authProbe(c, identities, out) {
  async function request(path, identity, method = 'GET', body) {
    const headers = identity ? { Cookie: `swat_session=${identity.token}; swat_csrf=${identity.csrf}`, 'x-csrf-token': identity.csrf, 'Content-Type': 'application/json' } : {};
    const response = await fetch(`${new URL(c.baseUrl).origin}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual', signal: AbortSignal.timeout(10000) });
    requireValue(response.status === (identity ? 200 : 401), `Auth/route preflight failed: ${method} ${path} status ${response.status}`);
    return response.json();
  }
  await request('/v1/auth/me');
  for (const identity of identities.slice(0, 10)) {
    const me = await request('/v1/auth/me', identity);
    requireValue(me.user?.id === identity.id && me.user?.role === 'user', 'Session identity mismatch');
    const wallets = await request('/v1/me/wallets', identity);
    requireValue(wallets.wallets?.some(w => w.address === identity.historyWallet) && wallets.wallets.every(w => w.address === identity.historyWallet), 'Owned-wallet isolation/fixture preflight failed');
    for (const [path, field] of [['/v1/me/feed','events'], ['/v1/me/signals','signals'], [`/v1/me/wallets/${encodeURIComponent(identity.historyWallet)}/history`,'transactions']]) {
      const result = await request(path, identity);
      requireValue(Array.isArray(result[field]) && result[field].length > 0, 'Nonempty observation fixture preflight failed');
    }
    await request('/v1/me/masters', identity);
    await request('/v1/me/execution-settings', identity);
    await request('/v1/me/execution-settings', identity, 'PATCH', { autoExecute: false });
  }
  const denied = await fetch(`${new URL(c.baseUrl).origin}/v1/me/wallets/${encodeURIComponent(identities[1].historyWallet)}/history`, { headers: { Cookie: `swat_session=${identities[0].token}` }, redirect: 'manual', signal: AbortSignal.timeout(10000) });
  requireValue([403,404].includes(denied.status), 'Cross-tenant history probe was not refused');
  await writeNewJson(`${out}/auth-probe.json`, { sampledUsersChecked: 10, unauthenticatedRefused: true, ownedNonemptyFixtures: true, crossTenantRefused: true, writeRouteChecked: true, runtimeAccepted: false });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'plan') console.log(JSON.stringify(plan(), null, 2));
  else {
    try {
      const c = await loadConfig(process.argv[3]);
      const out = process.argv[4];
      if (process.argv[2] === 'prepare') { await qualify(c, out); const identities = await seed(c, out); await authProbe(c, identities, out); }
      else throw new Error('Unknown command');
    } catch { console.error('Wave4 preparation failed. No automatic retry/cleanup; inspect qualified configuration and server logs privately.'); process.exitCode = 1; }
  }
}
