#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

if [[ "${AUTHORIZE_WAVE4:-}" != "yes" ]]; then
  echo "Refusing to start: re-run with AUTHORIZE_WAVE4=yes to explicitly authorize disposable Wave 4 containers." >&2
  exit 1
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
SWAT_DIR="${SWAT_DIR:-$(cd -- "$SCRIPT_DIR/.." && pwd -P)}"
[[ -d "$SWAT_DIR" && -f "$SWAT_DIR/package.json" ]] || {
  echo "SWAT repository not found at SWAT_DIR=$SWAT_DIR" >&2
  exit 1
}

PRIVATE_DIR="${PRIVATE_DIR:-$HOME/.swat-wave4-private}"
mkdir -p -m 700 "$PRIVATE_DIR"
chmod 700 "$PRIVATE_DIR"

SUDO=""
if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  SUDO="sudo"
fi

echo "=== [1/7] Installing OS prerequisites (Docker, Node 22, pnpm, pg_dump 16, PgBouncer, k6) ==="
export DEBIAN_FRONTEND=noninteractive
$SUDO rm -f /etc/apt/sources.list.d/k6.list /usr/share/keyrings/k6-archive-keyring.gpg
$SUDO apt-get update -y
$SUDO apt-get install -y ca-certificates curl gnupg lsb-release jq openssl uuid-runtime util-linux pgbouncer

if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | $SUDO sh
fi
if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
  $SUDO systemctl enable --now docker
elif command -v service >/dev/null 2>&1; then
  $SUDO service docker start >/dev/null 2>&1 || true
fi
docker info >/dev/null 2>&1 || {
  echo "Docker daemon is not reachable for current user. Add your user to the docker group or run with sudo." >&2
  exit 1
}

if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt 22 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO bash -
  $SUDO apt-get install -y nodejs
fi
if ! command -v pnpm >/dev/null 2>&1; then
  if command -v npm >/dev/null 2>&1; then
    npm install -g pnpm || $SUDO npm install -g pnpm
  else
    $SUDO apt-get install -y npm
    $SUDO npm install -g pnpm
  fi
fi

if ! command -v pg_dump >/dev/null 2>&1 || ! pg_dump --version | grep -qE '\b16\.'; then
  $SUDO install -d /usr/share/postgresql-common/pgdg
  curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | $SUDO gpg --dearmor --yes -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.gpg
  echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.gpg] https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" | $SUDO tee /etc/apt/sources.list.d/pgdg.list >/dev/null
  $SUDO apt-get update -y
  $SUDO apt-get install -y postgresql-client-16
fi

if ! command -v k6 >/dev/null 2>&1; then
  K6_ARCH="$(dpkg --print-architecture)"
  K6_VER="$(curl -fsSL https://api.github.com/repos/grafana/k6/releases/latest | jq -r '.tag_name')"
  K6_TMP="$(mktemp -d)"
  curl -fsSL "https://github.com/grafana/k6/releases/download/${K6_VER}/k6-${K6_VER}-linux-${K6_ARCH}.tar.gz" -o "${K6_TMP}/k6.tar.gz"
  tar -xzf "${K6_TMP}/k6.tar.gz" -C "${K6_TMP}"
  $SUDO install -m 0755 "${K6_TMP}/k6-${K6_VER}-linux-${K6_ARCH}/k6" /usr/local/bin/k6
  rm -rf "${K6_TMP}"
fi

echo "Tool versions:"
docker --version
node --version
pnpm --version
pg_dump --version
k6 version

echo "=== [2/7] Installing Node dependencies & building @swat/shared and @swat/db ==="
cd "$SWAT_DIR"
pnpm install --frozen-lockfile
pnpm --filter @swat/shared build
pnpm --filter @swat/db build

echo "=== [3/7] Pulling pinned container images ==="
PG_IMAGE="postgres:16-alpine"
RD_IMAGE="redis:7-alpine"
docker pull "$PG_IMAGE"
docker pull "$RD_IMAGE"

PG_IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$PG_IMAGE" | sed 's/^sha256://')"
RD_IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$RD_IMAGE" | sed 's/^sha256://')"
PG_UID="$(docker run --rm --entrypoint id "$PG_IMAGE" -u postgres)"
PG_GID="$(docker run --rm --entrypoint id "$PG_IMAGE" -g postgres)"
RD_UID="$(docker run --rm --entrypoint id "$RD_IMAGE" -u redis)"
RD_GID="$(docker run --rm --entrypoint id "$RD_IMAGE" -g redis)"

echo "=== [4/7] Cleaning old Wave 4 disposable containers/networks (if any) ==="
for name in swat-w4-ref-pg swat-w4-ref-redis swat-w4-cand-pg swat-w4-cand-redis; do
  docker rm -f "$name" >/dev/null 2>&1 || true
done
for net in swat-w4-ref-net swat-w4-cand-net; do
  docker network rm "$net" >/dev/null 2>&1 || true
done
$SUDO pkill -f "$PRIVATE_DIR/pgbouncer.ini" >/dev/null 2>&1 || true
sleep 0.5

REF_RUN_ID="$(uuidgen -r | tr '[:upper:]' '[:lower:]')"
CAND_RUN_ID="$(uuidgen -r | tr '[:upper:]' '[:lower:]')"
REF_DB="swat_integration_${REF_RUN_ID//-/}"
CAND_DB="swat_integration_${CAND_RUN_ID//-/}"

REF_PG_PORT=15432
CAND_PG_PORT=15433
PGBOUNCER_PORT=15434
REF_RD_PORT=16379
CAND_RD_PORT=16380

DBA_PASS="$(openssl rand -hex 24)"
MIG_PASS="$(openssl rand -hex 24)"
APP_PASS="$(openssl rand -hex 24)"

# 1 GB container RAM limit (swap == RAM), 1 CPU core, max 256 PIDs
MEM_BYTES=1073741824
NANO_CPUS=1000000000

echo "=== [5/7] Creating isolated Docker bridge networks (no outbound NAT) & hardened containers ==="
docker network create --driver bridge \
  --opt "com.docker.network.bridge.enable_ip_masquerade=false" \
  --label "swat.integration.run-id=$REF_RUN_ID" \
  --label "swat.integration.purpose=reference" \
  swat-w4-ref-net >/dev/null

docker network create --driver bridge \
  --opt "com.docker.network.bridge.enable_ip_masquerade=false" \
  --label "swat.integration.run-id=$CAND_RUN_ID" \
  --label "swat.integration.purpose=candidate" \
  swat-w4-cand-net >/dev/null

start_pg() {
  local name="$1" net="$2" run_id="$3" purpose="$4" port="$5" db="$6"
  docker run -d --name "$name" \
    --network "$net" \
    --user "${PG_UID}:${PG_GID}" \
    --read-only \
    --cap-drop=ALL \
    --security-opt=no-new-privileges \
    --memory="$MEM_BYTES" --memory-swap="$MEM_BYTES" \
    --cpus=1 --pids-limit=256 \
    --tmpfs "/var/lib/postgresql/data:rw,noexec,nosuid,size=512m,uid=${PG_UID},gid=${PG_GID},mode=0700" \
    --tmpfs "/tmp:rw,noexec,nosuid,size=128m,uid=${PG_UID},gid=${PG_GID}" \
    --tmpfs "/run:rw,noexec,nosuid,size=64m,uid=${PG_UID},gid=${PG_GID}" \
    -p "127.0.0.1:${port}:5432" \
    --label "swat.integration.run-id=$run_id" \
    --label "swat.integration.purpose=$purpose" \
    --label "swat.integration.owned=true" \
    -e "POSTGRES_USER=wave4_dba" \
    -e "POSTGRES_PASSWORD=$DBA_PASS" \
    -e "POSTGRES_DB=$db" \
    -e "POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256 --auth-local=scram-sha-256" \
    -e "PGDATA=/var/lib/postgresql/data" \
    "$PG_IMAGE" >/dev/null
}

start_redis() {
  local name="$1" net="$2" run_id="$3" purpose="$4" port="$5"
  docker run -d --name "$name" \
    --network "$net" \
    --user "${RD_UID}:${RD_GID}" \
    --read-only \
    --cap-drop=ALL \
    --security-opt=no-new-privileges \
    --memory="$MEM_BYTES" --memory-swap="$MEM_BYTES" \
    --cpus=1 --pids-limit=256 \
    --tmpfs "/data:rw,noexec,nosuid,size=256m,uid=${RD_UID},gid=${RD_GID}" \
    --tmpfs "/tmp:rw,noexec,nosuid,size=64m,uid=${RD_UID},gid=${RD_GID}" \
    -p "127.0.0.1:${port}:6379" \
    --label "swat.integration.run-id=$run_id" \
    --label "swat.integration.purpose=$purpose" \
    --label "swat.integration.owned=true" \
    "$RD_IMAGE" \
    redis-server --port 6379 --bind 0.0.0.0 --protected-mode no --save "" --appendonly no >/dev/null
}

start_pg swat-w4-ref-pg swat-w4-ref-net "$REF_RUN_ID" reference "$REF_PG_PORT" "$REF_DB"
start_redis swat-w4-ref-redis swat-w4-ref-net "$REF_RUN_ID" reference "$REF_RD_PORT"
start_pg swat-w4-cand-pg swat-w4-cand-net "$CAND_RUN_ID" candidate "$CAND_PG_PORT" "$CAND_DB"
start_redis swat-w4-cand-redis swat-w4-cand-net "$CAND_RUN_ID" candidate "$CAND_RD_PORT"

REF_PG_ID="$(docker inspect --format '{{.Id}}' swat-w4-ref-pg)"
REF_RD_ID="$(docker inspect --format '{{.Id}}' swat-w4-ref-redis)"
CAND_PG_ID="$(docker inspect --format '{{.Id}}' swat-w4-cand-pg)"
CAND_RD_ID="$(docker inspect --format '{{.Id}}' swat-w4-cand-redis)"

echo "Waiting for PostgreSQL 16 clusters to accept connections..."
for port_db in "${REF_PG_PORT}:${REF_DB}" "${CAND_PG_PORT}:${CAND_DB}"; do
  port="${port_db%%:*}"; db="${port_db##*:}"
  for i in $(seq 1 45); do
    if PGPASSWORD="$DBA_PASS" pg_isready -h 127.0.0.1 -p "$port" -U wave4_dba -d "$db" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  PGPASSWORD="$DBA_PASS" psql -h 127.0.0.1 -p "$port" -U wave4_dba -d "$db" -v ON_ERROR_STOP=1 -f "$SWAT_DIR/deploy/postgres/roles.sql"
  PGPASSWORD="$DBA_PASS" psql -h 127.0.0.1 -p "$port" -U wave4_dba -d "$db" -v ON_ERROR_STOP=1 <<SQL
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
END \$\$;
ALTER ROLE swat_migrator WITH LOGIN PASSWORD '${MIG_PASS}';
-- 070_runtime_role_boundary and 086 require swat_app to remain NOLOGIN until migrations commit.
ALTER ROLE swat_app NOLOGIN PASSWORD '${APP_PASS}';
SQL
done

echo "=== [6/7] Configuring & starting PgBouncer (transaction mode on 127.0.0.1:${PGBOUNCER_PORT}) ==="
SCRAM_HASH="$(PGPASSWORD="$DBA_PASS" psql -h 127.0.0.1 -p "$CAND_PG_PORT" -U wave4_dba -d "$CAND_DB" -At -c "SELECT rolpassword FROM pg_authid WHERE rolname='swat_app'")"
cat > "$PRIVATE_DIR/userlist.txt" <<EOF
"swat_app" "$SCRAM_HASH"
EOF
chmod 600 "$PRIVATE_DIR/userlist.txt"

cat > "$PRIVATE_DIR/pgbouncer.ini" <<EOF
[databases]
${CAND_DB} = host=127.0.0.1 port=${CAND_PG_PORT} dbname=${CAND_DB}

[pgbouncer]
listen_addr = 127.0.0.1
listen_port = ${PGBOUNCER_PORT}
auth_type = scram-sha-256
auth_file = ${PRIVATE_DIR}/userlist.txt
admin_users =
pool_mode = transaction
max_client_conn = 2000
default_pool_size = 25
min_pool_size = 5
reserve_pool_size = 5
reserve_pool_timeout = 5
max_db_connections = 50
ignore_startup_parameters = extra_float_digits,search_path,timezone
pidfile = ${PRIVATE_DIR}/pgbouncer.pid
logfile = ${PRIVATE_DIR}/pgbouncer.log
EOF
chmod 600 "$PRIVATE_DIR/pgbouncer.ini"
if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
  pgbouncer -u root -d "$PRIVATE_DIR/pgbouncer.ini"
else
  pgbouncer -d "$PRIVATE_DIR/pgbouncer.ini"
fi
for i in $(seq 1 20); do
  [[ -s "$PRIVATE_DIR/pgbouncer.pid" ]] && break
  sleep 0.2
done
[[ -s "$PRIVATE_DIR/pgbouncer.pid" ]] || { echo "Stage A PgBouncer failed to start" >&2; exit 1; }

echo "=== [7/7] Writing private 0600 Wave 4 configuration & running verification checks ==="
CONFIG_PATH="$PRIVATE_DIR/private-config.json"
CREDS_PATH="$PRIVATE_DIR/credentials.env"

cat > "$CREDS_PATH" <<EOF
SWAT_DIR="$SWAT_DIR"
PRIVATE_DIR="$PRIVATE_DIR"
CONFIG_PATH="$CONFIG_PATH"
DBA_USER="wave4_dba"
DBA_PASS="$DBA_PASS"
MIG_PASS="$MIG_PASS"
APP_PASS="$APP_PASS"
REF_RUN_ID="$REF_RUN_ID"
CAND_RUN_ID="$CAND_RUN_ID"
REF_DB="$REF_DB"
CAND_DB="$CAND_DB"
REF_PG_PORT="$REF_PG_PORT"
CAND_PG_PORT="$CAND_PG_PORT"
PGBOUNCER_PORT="$PGBOUNCER_PORT"
REF_RD_PORT="$REF_RD_PORT"
CAND_RD_PORT="$CAND_RD_PORT"
EOF
chmod 600 "$CREDS_PATH"

node --input-type=module - "$SWAT_DIR" "$CONFIG_PATH" \
  "$REF_RUN_ID" "$CAND_RUN_ID" "$REF_DB" "$CAND_DB" \
  "$REF_PG_ID" "$REF_RD_ID" "$CAND_PG_ID" "$CAND_RD_ID" \
  "$PG_IMAGE_ID" "$RD_IMAGE_ID" "$MEM_BYTES" "$NANO_CPUS" \
  "$REF_PG_PORT" "$REF_RD_PORT" "$CAND_PG_PORT" "$CAND_RD_PORT" "$PGBOUNCER_PORT" \
  "$MIG_PASS" "$APP_PASS" <<'NODE'
import { writeFileSync, chmodSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [
  swatDir, configPath,
  refRunId, candRunId, refDb, candDb,
  refPgId, refRdId, candPgId, candRdId,
  pgImgId, rdImgId, memBytes, nanoCpus,
  refPgPort, refRdPort, candPgPort, candRdPort, pgbPort,
  migPass, appPass
] = process.argv.slice(2);

const { discoverMigrationInventory } = await import(pathToFileURL(`${swatDir}/packages/db/dist/migration-discovery.js`));
const { createMigrationSelectionProposal, reviewMigrationSelection } = await import(pathToFileURL(`${swatDir}/packages/db/dist/migration-selection.js`));

const inventory = await discoverMigrationInventory(`${swatDir}/packages/db/sql`);
const proposal = createMigrationSelectionProposal(inventory);
const migrationSelection = reviewMigrationSelection(proposal, `server-disposable-run:${candRunId}`);

const config = {
  authorization: 'SEPARATELY_AUTHORIZED_DISPOSABLE_WAVE4',
  maxDurationMs: 600000,
  reference: {
    runId: refRunId,
    postgres: {
      url: `postgresql://swat_migrator:${migPass}@127.0.0.1:${refPgPort}/${refDb}`,
      containerId: refPgId,
      imageId: pgImgId,
      memoryBytes: Number(memBytes),
      nanoCpus: Number(nanoCpus)
    },
    redis: {
      url: `redis://127.0.0.1:${refRdPort}/0`,
      containerId: refRdId,
      imageId: rdImgId,
      memoryBytes: Number(memBytes),
      nanoCpus: Number(nanoCpus)
    }
  },
  candidate: {
    runId: candRunId,
    postgres: {
      url: `postgresql://swat_migrator:${migPass}@127.0.0.1:${candPgPort}/${candDb}`,
      containerId: candPgId,
      imageId: pgImgId,
      memoryBytes: Number(memBytes),
      nanoCpus: Number(nanoCpus)
    },
    redis: {
      url: `redis://127.0.0.1:${candRdPort}/0`,
      containerId: candRdId,
      imageId: rdImgId,
      memoryBytes: Number(memBytes),
      nanoCpus: Number(nanoCpus)
    }
  },
  runtimeUrl: `postgresql://swat_app:${appPass}@127.0.0.1:${candPgPort}/${candDb}`,
  pooledRuntimeUrl: `postgresql://swat_app:${appPass}@127.0.0.1:${pgbPort}/${candDb}`,
  migrationSelection
};

writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
chmodSync(configPath, 0o600);
NODE

"$SWAT_DIR/node_modules/.bin/tsx" - "$SWAT_DIR" "$CONFIG_PATH" <<'TS'
const [swatDir, configPath] = process.argv.slice(2);
const { privateConfig } = require(`${swatDir}/tests/qualification/wave4/config.ts`);
const { Deadline } = require(`${swatDir}/tests/qualification/wave4/containment.ts`);
const { inspectBoth, OwnedClients, bindPostgres, bindRedis } = require(`${swatDir}/tests/qualification/wave4/infrastructure.ts`);

(async () => {
  const cfg = await privateConfig(configPath);
  const deadline = new Deadline(60_000);
  const clients = new OwnedClients(deadline);
  try {
    const addrs = await inspectBoth(cfg, deadline);
    const refPg = await clients.postgres(cfg.reference.postgres.url, `check-ref-${cfg.reference.runId}`);
    const candPg = await clients.postgres(cfg.candidate.postgres.url, `check-cand-${cfg.candidate.runId}`);
    const refClusterId = await bindPostgres(refPg, cfg.reference, addrs.reference.postgres, deadline);
    const candClusterId = await bindPostgres(candPg, cfg.candidate, addrs.candidate.postgres, deadline);
    const refRd = await clients.redis(cfg.reference.redis.url, `check-ref-rd-${cfg.reference.runId}`);
    const candRd = await clients.redis(cfg.candidate.redis.url, `check-cand-rd-${cfg.candidate.runId}`);
    const refRdId = await bindRedis(refRd, addrs.reference.redis);
    const candRdId = await bindRedis(candRd, addrs.candidate.redis);
    console.log(JSON.stringify({
      status: 'INFRA_READY',
      referenceClusterId: refClusterId,
      candidateClusterId: candClusterId,
      referenceRedisRunId: refRdId,
      candidateRedisRunId: candRdId,
      addresses: addrs
    }, null, 2));
  } finally {
    await clients.close(deadline);
    deadline.dispose();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
TS

bash "$SWAT_DIR/deploy/loadtest/wave4/run.sh" --plan
NODE_OPTIONS="--max-old-space-size=512 --require=$SWAT_DIR/threats/sequential-fixes/offline-guard.cjs" \
  REVIEW_RESULTS=/tmp/w4-tier2-3.json \
  "$SWAT_DIR/node_modules/.bin/vitest" run --config "$SWAT_DIR/threats/project-completion-20261117/w4-tier2-3-20261125.config.ts"

echo ""
echo "=================================================================="
echo "READY ON 16 GB SERVER!"
echo "Private config : $CONFIG_PATH (mode 0600)"
echo "Credentials    : $CREDS_PATH (mode 0600)"
echo "=================================================================="
