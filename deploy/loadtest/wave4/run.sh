#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
NODE_BIN="$(command -v node)"
node() { env -i PATH="$PATH" HOME="${HOME:-/tmp}" WAVE4_CLOCK_TICKS="${WAVE4_CLOCK_TICKS:-}" "$NODE_BIN" "$@"; }
MODE="${1:---plan}"
if [[ "$MODE" == --plan ]]; then
  node "$HERE/runtime.mjs" plan
  exit 0
fi
if [[ "$MODE" != --run || $# != 2 ]]; then
  printf '%s\n' 'Usage: bash run.sh --plan | bash run.sh --run /absolute/private-config.json' >&2
  exit 2
fi
CONFIG="$2"
[[ "$CONFIG" == /* && -f "$CONFIG" && ! -L "$CONFIG" ]] || { printf '%s\n' 'Require absolute private configuration file.' >&2; exit 2; }
for tool in node k6 flock getconf; do
  command -v "$tool" >/dev/null || { printf 'Missing preinstalled dependency: %s\n' "$tool" >&2; exit 2; }
done
[[ -r /proc/meminfo && -r /proc/pressure/memory ]] || { printf '%s\n' 'Linux host/process/pressure observation required.' >&2; exit 2; }
[[ -z "${K6_OUT:-}" && -z "${K6_CLOUD_TOKEN:-}" && -z "${HTTP_PROXY:-}${HTTPS_PROXY:-}${ALL_PROXY:-}${http_proxy:-}${https_proxy:-}${all_proxy:-}" ]] || {
  printf '%s\n' 'Unset remote outputs, cloud tokens and HTTP proxies; this harness publishes nothing.' >&2; exit 2;
}
# k6 inherits a deliberately small environment, excluding cloud/debug/TLS overrides.
export WAVE4_CLOCK_TICKS="$(getconf CLK_TCK)"
RUN_ID="$(node --input-type=module - "$CONFIG" "$HERE" <<'JS'
import { pathToFileURL } from 'node:url';
const {loadConfig} = await import(pathToFileURL(`${process.argv[3]}/core.mjs`));
try {
  const c = await loadConfig(process.argv[2]);
  if (c.clockTicksPerSecond !== Number(process.env.WAVE4_CLOCK_TICKS)) throw new Error('Clock tick configuration mismatch');
  console.log(c.runId);
}
catch { console.error('Configuration/evidence validation failed.'); process.exit(2); }
JS
)"
mkdir -p -- "$HERE/runs"
[[ ! -L "$HERE/runs" && "$(stat -c %u "$HERE/runs")" == "$(id -u)" ]] || exit 2
chmod 700 "$HERE/runs"
# One remote-server load run at a time; this is separate from the local offline test lock.
exec 9>"$HERE/runs/.run.lock"
flock -n 9 || { printf '%s\n' 'Another load run owns this harness lock.' >&2; exit 2; }
OUT="$HERE/runs/$RUN_ID"
mkdir -m 700 -- "$OUT"
COLLECTOR=''; GENERATOR=''
telemetry_fresh() {
  [[ -f "$OUT/heartbeat" ]] || return 1
  local stamp now
  read -r stamp <"$OUT/heartbeat" || [[ -n "$stamp" ]] || return 1
  [[ "$stamp" =~ ^[0-9]+$ ]] || return 1
  now="$(date +%s%3N)"
  ((now - stamp < 180000))
}
stop_child() {
  local child="${1:-}"
  if [[ -n "$child" ]] && kill -0 "$child" 2>/dev/null; then
    kill -TERM "$child" 2>/dev/null || true
    for ((i=0; i<30; i++)); do kill -0 "$child" 2>/dev/null || break; sleep 1; done
    if kill -0 "$child" 2>/dev/null; then kill -KILL "$child" 2>/dev/null || true; fi
  fi
  if [[ -n "$child" ]]; then wait "$child" 2>/dev/null || true; fi
}
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  stop_child "$GENERATOR"
  stop_child "$COLLECTOR"
  printf 'Run exit=%s. Private evidence retained at %s; no service/data cleanup performed.\n' "$status" "$OUT" >&2
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
printf '%s\n' 'Preparing authorized empty disposable database. Partial seeds are retained on failure; this script never deletes/reuses them.'
node "$HERE/runtime.mjs" prepare "$CONFIG" "$OUT" >"$OUT/prepare.log" 2>&1
node "$HERE/report.mjs" workload "$CONFIG" "$OUT"
k6 version >"$OUT/k6-version.txt"
node --version >"$OUT/node-version.txt"
getconf CLK_TCK >"$OUT/clock-ticks.txt"
env -i PATH="$PATH" HOME="$OUT" "$NODE_BIN" "$HERE/collect.mjs" "$CONFIG" "$OUT" >"$OUT/collector.log" 2>&1 &
COLLECTOR=$!
for ((i=0; i<60; i++)); do
  [[ -f "$OUT/collector-ready.json" ]] && break
  kill -0 "$COLLECTOR" 2>/dev/null || { printf '%s\n' 'Collector failed before traffic.' >&2; exit 1; }
  sleep 1
done
[[ -f "$OUT/collector-ready.json" ]] || { printf '%s\n' 'Collector readiness timed out.' >&2; exit 1; }
sleep 10
telemetry_fresh && kill -0 "$COLLECTOR" 2>/dev/null || { printf '%s\n' 'Telemetry stale before load.' >&2; exit 1; }
LOAD_START="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"
printf '%s\n' 'Starting k6: 3m ramp to 2000, 5m hold, configured gradual ramp to 9000, 15m hold, 2m cooldown.'
REMOTE_WRITE="$(node --input-type=module - "$OUT/workload.json" <<'JS'
import {readFileSync} from 'node:fs';
const c = JSON.parse(readFileSync(process.argv[2], 'utf8'));
console.log(c.remoteWrite?.url ?? '');
JS
)"
K6_OUTPUT=()
if [[ -n "$REMOTE_WRITE" ]]; then K6_OUTPUT=(--out experimental-prometheus-rw); fi
env -i PATH="$PATH" HOME="$OUT" K6_NO_USAGE_REPORT=true \
  K6_PROMETHEUS_RW_SERVER_URL="$REMOTE_WRITE" K6_PROMETHEUS_RW_TREND_STATS=p95,p99,avg \
  WAVE4_WORKLOAD="$OUT/workload.json" WAVE4_IDENTITIES="$OUT/identities.json" WAVE4_SUMMARY="$OUT/k6-summary.json" \
  k6 run --address 127.0.0.1:0 --quiet "${K6_OUTPUT[@]}" "$HERE/workload.js" >"$OUT/k6.log" 2>&1 &
GENERATOR=$!
printf '%s\n' "$GENERATOR" >"$OUT/k6.pid"
while kill -0 "$GENERATOR" 2>/dev/null; do
  if ! kill -0 "$COLLECTOR" 2>/dev/null || ! telemetry_fresh; then
    printf '%s\n' 'Required collector stopped; aborting owned load process.' >&2
    exit 1
  fi
  sleep 1
done
set +e
wait "$GENERATOR"
K6_EXIT=$?
set -e
GENERATOR=''
node --input-type=module - "$OUT/lifecycle.json" "$LOAD_START" <<'JS'
import {writeFileSync} from 'node:fs';
writeFileSync(process.argv[2], JSON.stringify({start:process.argv[3],end:new Date().toISOString()}), {flag:'wx',mode:0o600});
JS
# Rename, never delete, the PID marker so the collector stops expecting the exited generator.
mv -- "$OUT/k6.pid" "$OUT/k6-exited.pid"
printf '%s\n' 'Bounded 60-second queue drain and final memory observations; workers/services remain running.'
for ((i=0; i<60; i++)); do
  kill -0 "$COLLECTOR" 2>/dev/null && telemetry_fresh || { printf '%s\n' 'Collector failed or stale during drain.' >&2; exit 1; }
  sleep 1
done
stop_child "$COLLECTOR"
COLLECTOR=''
node "$HERE/report.mjs" assess "$CONFIG" "$OUT" "$K6_EXIT"
