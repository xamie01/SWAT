#!/bin/bash
set -euo pipefail

# This entrypoint is intentionally preflight-only until an independently
# generated canonical schema and actual disposable infrastructure are qualified.
# Never acquire infrastructure, migrate, clean up, or launch an acceptance suite.
if [[ $# -ne 1 || "$1" != "--preflight-only" ]]; then
  printf '%s\n' 'Integration execution unavailable; use --preflight-only (no services or tests launched).' >&2
  exit 1
fi

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
exec node --import "$ROOT/node_modules/tsx/dist/loader.mjs" "$ROOT/tests/package28-isolation-preflight.ts" --preflight-only
