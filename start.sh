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
#
set -euo pipefail

cd "$(dirname "$0")"

# ─── Resolve the docker compose command (v2 plugin vs v1 binary) ───────────────
if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
else
  echo "✖ docker compose not found. Install Docker first." >&2
  exit 1
fi

# ─── --stop: tear everything down ──────────────────────────────────────────────
if [[ "${1:-}" == "--stop" ]]; then
  echo "▸ Stopping containers..."
  $COMPOSE down
  echo "✔ Stopped."
  exit 0
fi

DO_BUILD=1
[[ "${1:-}" == "--no-build" ]] && DO_BUILD=0

# ─── 1. Start the infrastructure containers ────────────────────────────────────
echo "▸ Starting Postgres + Redis..."
$COMPOSE up -d postgres redis

# ─── 2. Wait for Postgres and Redis to be ready ────────────────────────────────
echo -n "▸ Waiting for Postgres"
for i in $(seq 1 60); do
  if $COMPOSE exec -T postgres pg_isready -U swat -d swat >/dev/null 2>&1; then
    echo " ✔"
    break
  fi
  if [[ $i -eq 60 ]]; then echo " ✖ timed out" >&2; exit 1; fi
  echo -n "."
  sleep 1
done

echo -n "▸ Waiting for Redis"
for i in $(seq 1 30); do
  if $COMPOSE exec -T redis redis-cli ping 2>/dev/null | grep -q PONG; then
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
echo "▸ Starting all services (Ctrl-C to stop). Web UI: http://localhost:3000"
echo "  Containers stay up after Ctrl-C; run './start.sh --stop' to tear down."
echo ""
exec pnpm dev
