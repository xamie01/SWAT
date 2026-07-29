#!/usr/bin/env bash
#
# start.sh — bring up the whole SWAT stack with one command.
#
#   1. starts the Postgres + Redis containers (docker compose)
#   2. waits until both are actually accepting connections
#   3. applies database migrations (idempotent)
#   4. builds the workspace packages (skip with --no-build)
#   5. runs every app (api, indexer, signals, alerts, trade, scorer,
#      discovery, web) in parallel — Ctrl-C stops them all
#
# The Docker containers are left running after Ctrl-C so the next start is
# fast; run  ./start.sh --stop  to tear them down.
#
# Usage:
#   ./start.sh              # full start (build + migrate + run)
#   ./start.sh --no-build   # skip the turbo build (faster restarts)
#   ./start.sh --stop       # stop the app processes AND the containers
#   ./start.sh --help       # show usage
#
set -euo pipefail

cd "$(dirname "$0")"

ACTION="${1:-}"
PID_FILE="${SWAT_PID_FILE:-.swat-dev.pid}"

case "$ACTION" in
  ""|--no-build|--stop) ;;
  --help)
    sed -n '15,20p' "$0"
    exit 0
    ;;
  *)
    echo "Unknown option: $ACTION" >&2
    echo "Usage: ./start.sh [--no-build|--stop|--help]" >&2
    exit 2
    ;;
esac

# ─── .env Check ────────────────────────────────────────────────────────────────
if [[ "$ACTION" != "--stop" && ! -f .env ]]; then
  echo "✖ .env file not found. Please copy .env.example to .env and configure it." >&2
  exit 1
fi

if [[ -f .env ]]; then
  set -a; source .env; set +a
fi

is_swat_dev_pid() {
  local candidate="$1"
  [[ "$candidate" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$candidate" 2>/dev/null || return 1
  [[ "$(readlink -f "/proc/$candidate/cwd" 2>/dev/null || true)" == "$PWD" ]] || return 1
  [[ "$(ps -p "$candidate" -o args= 2>/dev/null || true)" == *"pnpm"*" dev"* ]]
}

# ─── Resolve the docker compose command (v2 plugin vs v1 binary) ───────────────
if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  echo "✖ docker compose not found. Install Docker first." >&2
  exit 1
fi

# ─── --stop: tear everything down ──────────────────────────────────────────────
if [[ "$ACTION" == "--stop" ]]; then
  echo "▸ Stopping app processes..."
  if [[ -f "$PID_FILE" ]]; then
    read -r dev_pid < "$PID_FILE"
    if is_swat_dev_pid "$dev_pid"; then
      kill -TERM "$dev_pid"
      for _ in $(seq 1 10); do
        kill -0 "$dev_pid" 2>/dev/null || break
        sleep 1
      done
      if kill -0 "$dev_pid" 2>/dev/null; then
        kill -KILL "$dev_pid"
      fi
    fi
    rm -f "$PID_FILE"
  fi
  echo "▸ Stopping containers..."
  "${COMPOSE[@]}" down
  echo "✔ Stopped."
  exit 0
fi

DO_BUILD=1
[[ "$ACTION" == "--no-build" ]] && DO_BUILD=0

if [[ -f "$PID_FILE" ]]; then
  read -r existing_pid < "$PID_FILE"
  if is_swat_dev_pid "$existing_pid"; then
    echo "SWAT development services are already running with PID $existing_pid." >&2
    exit 1
  fi
  rm -f "$PID_FILE"
fi

# ─── 1. Start the infrastructure containers ────────────────────────────────────
echo "▸ Starting Postgres + Redis..."
"${COMPOSE[@]}" up -d postgres redis

# ─── 2. Wait for Postgres and Redis to be ready ────────────────────────────────
echo -n "▸ Waiting for Postgres"
for i in $(seq 1 60); do
  if "${COMPOSE[@]}" exec -T postgres pg_isready -U "${POSTGRES_USER:-swat}" -d "${POSTGRES_DB:-swat}" >/dev/null 2>&1; then
    echo " ✔"
    break
  fi
  if [[ $i -eq 60 ]]; then echo " ✖ timed out" >&2; exit 1; fi
  echo -n "."
  sleep 1
done

echo -n "▸ Waiting for Redis"
for i in $(seq 1 30); do
  if "${COMPOSE[@]}" exec -T redis redis-cli ping 2>/dev/null | grep -q PONG; then
    echo " ✔"
    break
  fi
  if [[ $i -eq 30 ]]; then echo " ✖ timed out" >&2; exit 1; fi
  echo -n "."
  sleep 1
done

# ─── 3. Apply migrations (idempotent — safe to run every start) ─────────────────
echo "▸ Applying database migrations..."
pnpm db:migrate

# ─── 4. Build the workspace (optional) ─────────────────────────────────────────
if [[ $DO_BUILD -eq 1 ]]; then
  echo "▸ Building packages... (skip with --no-build)"
  pnpm build
fi

# ─── 5. Run every app in parallel ──────────────────────────────────────────────
echo ""
echo "▸ Starting all services (Ctrl-C to stop). Web UI: http://${WEB_HOST:-localhost}:${WEB_PORT:-3000}"
echo "  Containers stay up after Ctrl-C; run './start.sh --stop' to tear down."
echo ""
pnpm dev &
DEV_PID=$!
printf '%s\n' "$DEV_PID" > "$PID_FILE"

cleanup() {
  trap - INT TERM EXIT
  kill -TERM "$DEV_PID" 2>/dev/null || true
  wait "$DEV_PID" 2>/dev/null || true
  rm -f "$PID_FILE"
}
trap cleanup INT TERM EXIT

set +e
wait "$DEV_PID"
status=$?
set -e
cleanup
exit "$status"
