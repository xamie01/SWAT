#!/usr/bin/env bash
# Bootstrap pattern-ml on a server.
#
# Intentionally does NOT pull data — sourcing 1-2M trades is a long,
# rate-limited job that belongs behind an explicit command, not a setup script
# someone might run twice.
#
#   ./scripts/setup-server.sh
#   source .venv/bin/activate
#   pattern-ml pull

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

echo "==> pattern-ml setup in ${ROOT}"

# --- Python version -----------------------------------------------------------
PYTHON="${PYTHON:-python3}"
if ! command -v "$PYTHON" >/dev/null 2>&1; then
  echo "ERROR: $PYTHON not found. Install Python 3.11+ first." >&2
  exit 1
fi

version="$("$PYTHON" -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
major="${version%%.*}"
minor="${version##*.}"
if (( major < 3 || (major == 3 && minor < 11) )); then
  echo "ERROR: Python 3.11+ required, found ${version}." >&2
  exit 1
fi
echo "    Python ${version}"

# --- Virtualenv ---------------------------------------------------------------
if [[ ! -d .venv ]]; then
  echo "==> Creating virtualenv"
  "$PYTHON" -m venv .venv
fi

# shellcheck disable=SC1091
source .venv/bin/activate
python -m pip install --quiet --upgrade pip

echo "==> Installing dependencies (pulls numpy/scipy/lightgbm wheels; slow first time)"
# `service` is included so the same box can serve the API; drop it for a
# batch-only worker.
pip install -e ".[dev,service]"

# --- Config -------------------------------------------------------------------
if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "==> Created .env — add your HELIUS_API_KEY before pulling Solana data"
fi

if [[ ! -f config/kols.yaml ]]; then
  cp config/kols.example.yaml config/kols.yaml
  echo "==> Created config/kols.yaml — add the KOL addresses you want to track"
fi

mkdir -p data/raw artifacts reports

# --- Verify -------------------------------------------------------------------
echo "==> Verifying install"
python -c "import pattern_ml, duckdb, polars, sklearn, lightgbm; print('    imports OK')"
pytest -q

cat <<'EOF'

==> Setup complete.

Next steps:
  1. Edit .env             — add HELIUS_API_KEY (required for Solana)
  2. Edit config/kols.yaml — add the KOL wallet addresses to track
  3. Run the pipeline:

       source .venv/bin/activate
       pattern-ml pull        # long-running; safe to resume
       pattern-ml index
       pattern-ml positions
       pattern-ml validate    # roster-level backtest, no model needed

     or all at once:  pattern-ml run-all

Note: `pattern-ml mine` is not available yet — the feature-engineering and
model-training approach is still being decided.
EOF
