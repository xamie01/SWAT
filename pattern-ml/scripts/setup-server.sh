#!/usr/bin/env bash
# Inert inspection only. Never bootstrap/install/acquire or source credentials.
set -euo pipefail
if [[ "${1:-}" != --verify-only || "$#" != 1 ]]; then
  printf '%s\n' 'Automatic bootstrap is disabled. Only --verify-only is supported; approved ABI/wheels/native runtime remain external gates.' >&2
  exit 1
fi
readonly root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
exec /usr/bin/python3 -I -S "$root/deploy/tools/ops-readiness.py" --verify-only --root "$root"
