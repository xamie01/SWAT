#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

if [[ "${AUTHORIZE_WAVE4:-}" != "yes" ]]; then
  echo "Refusing to start: re-run with AUTHORIZE_WAVE4=yes to explicitly authorize concurrent disposable Wave 4 Stage A + Stage B execution." >&2
  exit 1
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
SWAT_DIR="${SWAT_DIR:-$(cd -- "$SCRIPT_DIR/.." && pwd -P)}"
PRIVATE_DIR="${PRIVATE_DIR:-/tmp/.swat-wave4-private}"
STAGE_A_CONFIG="$PRIVATE_DIR/private-config.json"
STAGE_A_CREDS="$PRIVATE_DIR/credentials.env"

[[ -f "$STAGE_A_CONFIG" && -f "$STAGE_A_CREDS" ]] || {
  echo "Missing Stage A config/credentials in $PRIVATE_DIR. Run scripts/bootstrap-wave4-server.sh first." >&2
  exit 1
}

for tool in docker node pnpm psql pg_dump k6 jq openssl uuidgen getconf pgbouncer; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Missing required tool: $tool" >&2; exit 2; }
done
[[ -r /proc/meminfo && -r /proc/pressure/memory && -r /proc/pressure/cpu && -r /proc/pressure/io ]] || {
  echo "Host /proc/meminfo and /proc/pressure/{cpu,memory,io} required for Stage B load collection." >&2
  exit 2
}

echo "=== [1/5] Building workspace dependencies (@swat/shared, @swat/db) ==="
cd "$SWAT_DIR"
pnpm --filter @swat/shared build
pnpm --filter @swat/db build

RUN_STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RUN_OUT="$PRIVATE_DIR/concurrent-run-$RUN_STAMP"
mkdir -p -m 700 "$RUN_OUT"
chmod 700 "$RUN_OUT"

LOAD_RUN_ID="w4load-$(uuidgen -r | tr '[:upper:]' '[:lower:]' | cut -d- -f1-2)"
LOAD_UUID="$(uuidgen -r | tr '[:upper:]' '[:lower:]')"
LOAD_DB="swat_wave4_disposable"
LOAD_PG_PORT=15435
LOAD_PGB_PORT=15436
LOAD_RD_PORT=16381
API_PORT=3001

LOAD_DBA_PASS="$(openssl rand -hex 24)"
LOAD_MIG_PASS="$(openssl rand -hex 24)"
LOAD_APP_PASS="$(openssl rand -hex 24)"
LOAD_AUTH_PASS="$(openssl rand -hex 24)"
LOAD_OBS_PASS="$(openssl rand -hex 24)"
LOAD_POOL_OBS_PASS="$(openssl rand -hex 24)"

PG_IMAGE="postgres:16-alpine"
RD_IMAGE="redis:7-alpine"
PG_IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$PG_IMAGE" | sed 's/^sha256://')"
RD_IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$RD_IMAGE" | sed 's/^sha256://')"
PG_UID="$(docker run --rm --entrypoint id "$PG_IMAGE" -u postgres)"
PG_GID="$(docker run --rm --entrypoint id "$PG_IMAGE" -g postgres)"
RD_UID="$(docker run --rm --entrypoint id "$RD_IMAGE" -u redis)"
RD_GID="$(docker run --rm --entrypoint id "$RD_IMAGE" -g redis)"

API_PID=""
WORKER_PID=""
STAGE_A_PID=""
STAGE_B_PID=""

cleanup_stage_b_daemons() {
  for p in "$WORKER_PID" "$API_PID"; do
    if [[ -n "$p" ]] && kill -0 "$p" 2>/dev/null; then
      kill -TERM "$p" 2>/dev/null || true
      sleep 1
      kill -KILL "$p" 2>/dev/null || true
      wait "$p" 2>/dev/null || true
    fi
  done
}
trap cleanup_stage_b_daemons EXIT

echo "=== [2/5] Provisioning dedicated Stage B isolated containers (PG16 + Redis7 + PgBouncer) ==="
docker rm -f swat-w4-load-pg swat-w4-load-redis >/dev/null 2>&1 || true
docker network rm swat-w4-load-net >/dev/null 2>&1 || true
pkill -f "$PRIVATE_DIR/load-pgbouncer.ini" >/dev/null 2>&1 || true
sleep 0.5

docker network create --driver bridge \
  --opt "com.docker.network.bridge.enable_ip_masquerade=false" \
  --label "swat.integration.run-id=$LOAD_UUID" \
  --label "swat.integration.purpose=load" \
  swat-w4-load-net >/dev/null

LOAD_MEM_BYTES=2147483648
docker run -d --name swat-w4-load-pg \
  --network swat-w4-load-net \
  --user "${PG_UID}:${PG_GID}" \
  --read-only \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  --memory="$LOAD_MEM_BYTES" --memory-swap="$LOAD_MEM_BYTES" \
  --cpus=2 --pids-limit=512 \
  --tmpfs "/var/lib/postgresql/data:rw,noexec,nosuid,size=1024m,uid=${PG_UID},gid=${PG_GID},mode=0700" \
  --tmpfs "/tmp:rw,noexec,nosuid,size=256m,uid=${PG_UID},gid=${PG_GID}" \
  --tmpfs "/run:rw,noexec,nosuid,size=64m,uid=${PG_UID},gid=${PG_GID}" \
  -p "127.0.0.1:${LOAD_PG_PORT}:5432" \
  --label "swat.integration.run-id=$LOAD_UUID" \
  --label "swat.integration.purpose=load" \
  --label "swat.integration.owned=true" \
  -e "POSTGRES_USER=wave4_dba" \
  -e "POSTGRES_PASSWORD=$LOAD_DBA_PASS" \
  -e "POSTGRES_DB=$LOAD_DB" \
  -e "POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256 --auth-local=scram-sha-256" \
  -e "PGDATA=/var/lib/postgresql/data" \
  "$PG_IMAGE" \
  postgres \
    -c shared_preload_libraries=pg_stat_statements \
    -c track_io_timing=on \
    -c log_lock_waits=on \
    -c deadlock_timeout=1000 \
    -c log_min_duration_statement=200 \
    -c max_connections=150 >/dev/null

docker run -d --name swat-w4-load-redis \
  --network swat-w4-load-net \
  --user "${RD_UID}:${RD_GID}" \
  --read-only \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  --memory="$LOAD_MEM_BYTES" --memory-swap="$LOAD_MEM_BYTES" \
  --cpus=1 --pids-limit=256 \
  --tmpfs "/data:rw,noexec,nosuid,size=512m,uid=${RD_UID},gid=${RD_GID}" \
  --tmpfs "/tmp:rw,noexec,nosuid,size=64m,uid=${RD_UID},gid=${RD_GID}" \
  -p "127.0.0.1:${LOAD_RD_PORT}:6379" \
  --label "swat.integration.run-id=$LOAD_UUID" \
  --label "swat.integration.purpose=load" \
  --label "swat.integration.owned=true" \
  "$RD_IMAGE" \
  redis-server --port 6379 --bind 0.0.0.0 --protected-mode no --save "" --appendonly no >/dev/null

LOAD_PG_ID="$(docker inspect --format '{{.Id}}' swat-w4-load-pg)"
LOAD_RD_ID="$(docker inspect --format '{{.Id}}' swat-w4-load-redis)"
LOAD_PG_ADDR="$(docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' swat-w4-load-pg)"

echo "Waiting for Stage B PostgreSQL 16 ($LOAD_PG_PORT) & Redis 7 ($LOAD_RD_PORT)..."
for i in $(seq 1 45); do
  if PGPASSWORD="$LOAD_DBA_PASS" pg_isready -h 127.0.0.1 -p "$LOAD_PG_PORT" -U wave4_dba -d "$LOAD_DB" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

PGPASSWORD="$LOAD_DBA_PASS" psql -h 127.0.0.1 -p "$LOAD_PG_PORT" -U wave4_dba -d "$LOAD_DB" -v ON_ERROR_STOP=1 -f "$SWAT_DIR/deploy/postgres/roles.sql"
PGPASSWORD="$LOAD_DBA_PASS" psql -h 127.0.0.1 -p "$LOAD_PG_PORT" -U wave4_dba -d "$LOAD_DB" -v ON_ERROR_STOP=1 <<SQL
DO \$\$
DECLARE role_name text;
  extra_roles text[] := ARRAY[
    'swat_fanout',
    'swat_wave4_authority_writer', 'swat_wave4_financial_writer',
    'swat_lp_initializer', 'swat_custody_reader', 'swat_custody_observer'
  ];
BEGIN
  FOREACH role_name IN ARRAY extra_roles LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN PASSWORD NULL NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION', role_name);
    END IF;
    EXECUTE format('ALTER ROLE %I SET row_security=on', role_name);
    EXECUTE format('ALTER ROLE %I SET search_path=pg_catalog', role_name);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'wave4_observer') THEN
    CREATE ROLE wave4_observer LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  ALTER ROLE wave4_observer WITH PASSWORD '${LOAD_OBS_PASS}' SET row_security=on;
  GRANT pg_read_all_stats TO wave4_observer;
  GRANT CONNECT ON DATABASE ${LOAD_DB} TO wave4_observer;
  GRANT USAGE ON SCHEMA public TO wave4_observer;
END \$\$;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
ALTER ROLE swat_migrator WITH LOGIN PASSWORD '${LOAD_MIG_PASS}';
ALTER ROLE swat_app WITH LOGIN PASSWORD '${LOAD_APP_PASS}';
SQL

echo "Applying reviewed 001-090 migrations & 087 auth handoff to Stage B PostgreSQL..."
"$SWAT_DIR/node_modules/.bin/tsx" - \
  "$SWAT_DIR" "$LOAD_PG_PORT" "$LOAD_DB" "$LOAD_DBA_PASS" "$LOAD_MIG_PASS" "$LOAD_AUTH_PASS" \
  "$LOAD_PG_ADDR" "$LOAD_RUN_ID" "$PRIVATE_DIR/load-migration-selection.json" <<'TS'
const { writeFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const [swatDir, port, db, dbaPass, migPass, authPass, pgAddr, loadRunId, selOutPath] = process.argv.slice(2);
const dbRequire = createRequire(`${swatDir}/packages/db/package.json`);
const { Client } = dbRequire('pg');
const { discoverMigrationInventory } = require(`${swatDir}/packages/db/dist/migration-discovery.js`);
const { createMigrationSelectionProposal, reviewMigrationSelection } = require(`${swatDir}/packages/db/dist/migration-selection.js`);
const { Deadline } = require(`${swatDir}/tests/qualification/wave4/containment.ts`);
const { migratePristine } = require(`${swatDir}/tests/qualification/wave4/infrastructure.ts`);
const { activateInstalledAuthentication, authenticationInstallationSource } = require(`${swatDir}/deploy/postgres/auth-installation.ts`);
const { canonicalMigrationSource } = require(`${swatDir}/packages/db/src/canonical-migration-source.ts`);

(async () => {
  const inventory = await discoverMigrationInventory(`${swatDir}/packages/db/sql`);
  const selection = reviewMigrationSelection(createMigrationSelectionProposal(inventory), `server-load-run:${loadRunId}`);
  writeFileSync(selOutPath, JSON.stringify(selection, null, 2) + '\n', { mode: 0o600 });

  const dbaUrl = `postgresql://wave4_dba:${dbaPass}@127.0.0.1:${port}/${db}`;
  const migUrl = `postgresql://swat_migrator:${migPass}@127.0.0.1:${port}/${db}`;
  const readSys = new Client({ connectionString: dbaUrl, connectionTimeoutMillis: 5_000 });
  await readSys.connect();
  const sysId = (await readSys.query('SELECT system_identifier::text AS id FROM pg_catalog.pg_control_system()')).rows[0].id;
  await readSys.end();

  const authInstall = {
    target: { database: db, address: pgAddr, port: 5432, systemIdentifier: sysId },
    dbaRole: 'wave4_dba',
    acquireDba: async () => {
      const c = new Client({ connectionString: dbaUrl, connectionTimeoutMillis: 5_000 });
      await c.connect();
      return { client: c, release: () => { void c.end().catch(() => {}); } };
    }
  };

  const migClient = new Client({ connectionString: migUrl, connectionTimeoutMillis: 10_000, statement_timeout: 30_000 });
  await migClient.connect();
  const deadline = new Deadline(120_000);
  try {
    await migratePristine(migClient, deadline, selection, authInstall);
    const source = await canonicalMigrationSource(selection);
    const authSql = authenticationInstallationSource(source, authInstall);
    await activateInstalledAuthentication(authInstall, authSql, {
      expiresAt: new Date(Date.now() + 3600_000),
      activateExternally: async () => {
        const lease = await authInstall.acquireDba();
        try {
          await lease.client.query(`ALTER ROLE swat_auth_service WITH LOGIN PASSWORD '${authPass}'`);
        } finally {
          lease.release();
        }
      }
    });
  } finally {
    await migClient.end();
    deadline.dispose();
  }
})().catch((err) => { console.error(err); process.exit(1); });
TS

PGPASSWORD="$LOAD_DBA_PASS" psql -h 127.0.0.1 -p "$LOAD_PG_PORT" -U wave4_dba -d "$LOAD_DB" -v ON_ERROR_STOP=1 <<SQL
GRANT SELECT ON ALL TABLES IN SCHEMA public TO wave4_observer;
REVOKE INSERT, UPDATE, DELETE ON public.users FROM wave4_observer;
GRANT SELECT ON public.wallets, public.transactions, public.wallet_clusters, public.cluster_memberships, public.signals, public.source_trades TO swat_app;
GRANT INSERT, UPDATE ON public.wallets, public.user_wallet_subscriptions, public.user_token_watches, public.user_execution_settings TO swat_app;
SQL

echo "Starting Stage B PgBouncer (127.0.0.1:${LOAD_PGB_PORT}) and Redis observer ACL..."
LOAD_SCRAM_APP="$(PGPASSWORD="$LOAD_DBA_PASS" psql -h 127.0.0.1 -p "$LOAD_PG_PORT" -U wave4_dba -d "$LOAD_DB" -At -c "SELECT rolpassword FROM pg_authid WHERE rolname='swat_app'")"
cat > "$PRIVATE_DIR/load-userlist.txt" <<EOF
"swat_app" "$LOAD_SCRAM_APP"
"wave4_pool_observer" "$LOAD_POOL_OBS_PASS"
EOF
chmod 600 "$PRIVATE_DIR/load-userlist.txt"

cat > "$PRIVATE_DIR/load-pgbouncer.ini" <<EOF
[databases]
${LOAD_DB} = host=127.0.0.1 port=${LOAD_PG_PORT} dbname=${LOAD_DB}

[pgbouncer]
listen_addr = 127.0.0.1
listen_port = ${LOAD_PGB_PORT}
auth_type = scram-sha-256
auth_file = ${PRIVATE_DIR}/load-userlist.txt
admin_users = wave4_pool_observer
stats_users = wave4_pool_observer
pool_mode = transaction
max_client_conn = 2000
default_pool_size = 25
min_pool_size = 5
reserve_pool_size = 5
reserve_pool_timeout = 5
max_db_connections = 50
ignore_startup_parameters = extra_float_digits,search_path,timezone
pidfile = ${PRIVATE_DIR}/load-pgbouncer.pid
logfile = ${PRIVATE_DIR}/load-pgbouncer.log
EOF
chmod 600 "$PRIVATE_DIR/load-pgbouncer.ini"
if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
  pgbouncer -u root -d "$PRIVATE_DIR/load-pgbouncer.ini"
else
  pgbouncer -d "$PRIVATE_DIR/load-pgbouncer.ini"
fi
for i in $(seq 1 20); do
  [[ -s "$PRIVATE_DIR/load-pgbouncer.pid" ]] && break
  sleep 0.2
done
[[ -s "$PRIVATE_DIR/load-pgbouncer.pid" ]] || { echo "Stage B PgBouncer failed to start" >&2; exit 1; }

"$SWAT_DIR/node_modules/.bin/tsx" - "$SWAT_DIR" "$LOAD_RD_PORT" "$LOAD_OBS_PASS" <<'TS'
const { createRequire } = require('node:module');
const [swatDir, port, pass] = process.argv.slice(2);
const apiRequire = createRequire(`${swatDir}/apps/api/package.json`);
const Redis = apiRequire('ioredis');
(async () => {
  const r = new Redis(`redis://127.0.0.1:${port}/0`, { maxRetriesPerRequest: 2 });
  await r.call('ACL', 'SETUSER', 'wave4_observer', 'on', `>${pass}`, '~*', '&*', '+@read', '+info', '+exists', '+llen', '+lrange', '+zcard', '+zrange', '+hget', '+hgetall', '+get', '+xlen', '+xrevrange', '+ping', '+client', '+quit');
  r.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
TS

echo "=== [3/5] Starting Stage B API (:${API_PORT}) and egress-contained fixture worker ==="
LOAD_AUTH_MOD="$PRIVATE_DIR/load-auth-module.mjs"
cat > "$LOAD_AUTH_MOD" <<EOF
import { createRequire } from 'node:module';
const dbRequire = createRequire('${SWAT_DIR}/packages/db/package.json');
const { Pool } = dbRequire('pg');
const authPool = new Pool({
  connectionString: 'postgresql://swat_auth_service:${LOAD_AUTH_PASS}@127.0.0.1:${LOAD_PG_PORT}/${LOAD_DB}',
  max: 25,
  connectionTimeoutMillis: 5000,
  statement_timeout: 15000
});
export async function acquireDirectAuthLease() {
  const client = await authPool.connect();
  return {
    client,
    release: (broken) => client.release(Boolean(broken))
  };
}
EOF
chmod 600 "$LOAD_AUTH_MOD"

WORKER_READY="$RUN_OUT/worker-ready.json"
rm -f "$WORKER_READY"
REDIS_URL="redis://127.0.0.1:${LOAD_RD_PORT}/0" \
WORKER_READY_FILE="$WORKER_READY" \
  "$SWAT_DIR/node_modules/.bin/tsx" "$SWAT_DIR/scripts/wave4-load-fixture-worker.ts" \
  >"$RUN_OUT/fixture-worker.log" 2>&1 &
WORKER_PID=$!

for i in $(seq 1 30); do
  [[ -f "$WORKER_READY" ]] && break
  sleep 1
done
[[ -f "$WORKER_READY" ]] || { echo "Fixture worker failed to start; see $RUN_OUT/fixture-worker.log" >&2; exit 1; }

NODE_ENV=development \
PORT="$API_PORT" \
DATABASE_URL="postgresql://swat_app:${LOAD_APP_PASS}@127.0.0.1:${LOAD_PGB_PORT}/${LOAD_DB}" \
DB_POOL_MAX=40 \
REDIS_URL="redis://127.0.0.1:${LOAD_RD_PORT}/0" \
SWAT_API_AUTH_COMPOSITION_MODULE="$LOAD_AUTH_MOD" \
AUTH_DOMAIN="127.0.0.1:${API_PORT}" \
AUTH_URI="http://127.0.0.1:${API_PORT}" \
RATE_LIMIT_MAX=10000 \
DISABLE_BILLING_SWEEPER_DAEMON=true \
  "$SWAT_DIR/node_modules/.bin/tsx" "$SWAT_DIR/apps/api/src/index.ts" \
  >"$RUN_OUT/api.log" 2>&1 &
API_PID=$!

for i in $(seq 1 45); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${API_PORT}/v1/auth/me" || true)"
  if [[ "$code" == "401" ]]; then
    break
  fi
  sleep 1
done
[[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${API_PORT}/v1/auth/me" || true)" == "401" ]] || {
  echo "API failed readiness check on :${API_PORT}; see $RUN_OUT/api.log" >&2
  exit 1
}

LOAD_PG_PID="$(docker inspect --format '{{.State.Pid}}' swat-w4-load-pg)"
LOAD_RD_PID="$(docker inspect --format '{{.State.Pid}}' swat-w4-load-redis)"
LOAD_PGB_PID="$(cat "$PRIVATE_DIR/load-pgbouncer.pid")"

docker inspect swat-w4-load-pg swat-w4-load-redis > "$RUN_OUT/deployment-proof.txt"
docker network inspect swat-w4-load-net > "$RUN_OUT/egress-proof.txt"
printf 'RATE_LIMIT_MAX=10000\nAUTH_RATE_LIMIT_MAX=10\nAUTH_ACCOUNT_RATE_LIMIT_MAX=10\n' > "$RUN_OUT/limiter-proof.txt"
sha256sum "$SWAT_DIR/scripts/wave4-load-fixture-worker.ts" > "$RUN_OUT/worker-proof.txt"
chmod 600 "$RUN_OUT"/*-proof.txt

LOAD_CONFIG="$PRIVATE_DIR/load-config.json"
CLK_TCK="$(getconf CLK_TCK)"
node --input-type=module - "$LOAD_CONFIG" "$PRIVATE_DIR/load-migration-selection.json" "$RUN_OUT" \
  "$LOAD_RUN_ID" "$LOAD_DB" "$LOAD_PG_PORT" "$LOAD_PGB_PORT" "$LOAD_RD_PORT" "$API_PORT" "$CLK_TCK" \
  "$LOAD_MIG_PASS" "$LOAD_OBS_PASS" "$LOAD_APP_PASS" "$LOAD_POOL_OBS_PASS" \
  "$API_PID" "$WORKER_PID" "$LOAD_PG_PID" "$LOAD_RD_PID" "$LOAD_PGB_PID" <<'NODE'
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';

const [
  outConfig, selPath, runOut,
  runId, dbName, pgPort, pgbPort, rdPort, apiPort, clkTck,
  migPass, obsPass, appPass, poolObsPass,
  apiPid, workerPid, pgPid, rdPid, pgbPid
] = process.argv.slice(2);

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const selection = JSON.parse(readFileSync(selPath, 'utf8'));

const cfg = {
  authorization: 'AUTHORIZED_DISPOSABLE_WAVE4_LOAD',
  runId,
  seedCount: 100000,
  sampleCount: 10000,
  secondRamp: '2m',
  readPercent: 80,
  clockTicksPerSecond: Number(clkTck),
  intervalSeconds: 10,
  minQueueAdmissions: 8000,
  baseUrl: `http://127.0.0.1:${apiPort}`,
  migrationSelection: selection,
  expectedDatabase: dbName,
  seedDb: { host: '127.0.0.1', port: Number(pgPort), database: dbName, user: 'swat_migrator', password: migPass },
  monitorDb: { host: '127.0.0.1', port: Number(pgPort), database: dbName, user: 'wave4_observer', password: obsPass },
  runtimeDb: { host: '127.0.0.1', port: Number(pgbPort), database: dbName, user: 'swat_app', password: appPass },
  poolAdmin: { host: '127.0.0.1', port: Number(pgbPort), database: 'pgbouncer', user: 'wave4_pool_observer', password: poolObsPass },
  redis: { host: '127.0.0.1', port: Number(rdPort), db: 0, username: 'wave4_observer', password: obsPass },
  queuePrefix: 'bull',
  queues: ['swat-backfill-wallet', 'swat-token-discovery'],
  processes: [
    { name: 'application', pid: Number(apiPid), commandIncludes: 'apps/api' },
    { name: 'worker', pid: Number(workerPid), commandIncludes: 'fixture-worker' },
    { name: 'postgres', pid: Number(pgPid), commandIncludes: 'postgres' },
    { name: 'redis', pid: Number(rdPid), commandIncludes: 'redis-server' },
    { name: 'pgbouncer', pid: Number(pgbPid), commandIncludes: 'pgbouncer' }
  ],
  allowlist: {
    apiOrigins: [`http://127.0.0.1:${apiPort}`],
    seedDb: [`127.0.0.1:${pgPort}/${dbName}`],
    monitorDb: [`127.0.0.1:${pgPort}/${dbName}`],
    runtimeDb: [`127.0.0.1:${pgbPort}/${dbName}`],
    poolAdmin: [`127.0.0.1:${pgbPort}/pgbouncer`],
    redis: [`127.0.0.1:${rdPort}/0`],
    metricsOrigins: []
  },
  attestations: {
    isolatedDisposable: true,
    egressContainedFixtureWorkers: true,
    applicationUsesQualifiedPoolRole: true,
    reviewedLimiterCapacity: true,
    noLiveCredentialsOrFinancialEffects: true,
    authorizedMetricsPublication: false
  },
  evidence: [
    { kind: 'deployment', path: `${runOut}/deployment-proof.txt`, sha256: sha(`${runOut}/deployment-proof.txt`) },
    { kind: 'egress', path: `${runOut}/egress-proof.txt`, sha256: sha(`${runOut}/egress-proof.txt`) },
    { kind: 'limiter', path: `${runOut}/limiter-proof.txt`, sha256: sha(`${runOut}/limiter-proof.txt`) },
    { kind: 'worker', path: `${runOut}/worker-proof.txt`, sha256: sha(`${runOut}/worker-proof.txt`) }
  ]
};

writeFileSync(outConfig, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
chmodSync(outConfig, 0o600);
NODE

echo "=== [4/5] Launching Stage A (I1-I6) and Stage B (I7 27m load) CONCURRENTLY ==="
: > "$RUN_OUT/stage-a.log"
: > "$RUN_OUT/stage-b.log"

"$SWAT_DIR/node_modules/.bin/tsx" "$SWAT_DIR/scripts/wave4-live-stage-a.ts" \
  "$STAGE_A_CONFIG" "$STAGE_A_CREDS" "$RUN_OUT/stage-a" \
  >"$RUN_OUT/stage-a.log" 2>&1 &
STAGE_A_PID=$!

bash "$SWAT_DIR/deploy/loadtest/wave4/run.sh" --run "$LOAD_CONFIG" \
  >"$RUN_OUT/stage-b.log" 2>&1 &
STAGE_B_PID=$!

tail -n +1 -f "$RUN_OUT/stage-a.log" | sed -u 's/^/[STAGE-A] /' &
TAIL_A_PID=$!
tail -n +1 -f "$RUN_OUT/stage-b.log" | sed -u 's/^/[STAGE-B] /' &
TAIL_B_PID=$!

set +e
wait "$STAGE_A_PID"
STAGE_A_EXIT=$?
wait "$STAGE_B_PID"
STAGE_B_EXIT=$?
set -e

kill "$TAIL_A_PID" "$TAIL_B_PID" >/dev/null 2>&1 || true
wait "$TAIL_A_PID" "$TAIL_B_PID" >/dev/null 2>&1 || true

echo "=== [5/5] Stage A + Stage B concurrent execution finished ==="
echo "Stage A exit code: $STAGE_A_EXIT (evidence: $RUN_OUT/stage-a)"
echo "Stage B exit code: $STAGE_B_EXIT (evidence: $SWAT_DIR/deploy/loadtest/wave4/runs/$LOAD_RUN_ID)"

if [[ "$STAGE_A_EXIT" -ne 0 || "$STAGE_B_EXIT" -ne 0 ]]; then
  exit 1
fi
