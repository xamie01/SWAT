#!/usr/bin/env python3
"""Sequential, single-core, offline post-fix verification runner."""
import datetime
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

os.sched_setaffinity(0, {0})
ROOT = Path('/home/xahmie/Documents/SWAT')
OUT = ROOT / 'threats/sequential-fixes'
label = sys.argv[1]
args = sys.argv[2:]
if not label.replace('-', '').replace('_', '').isalnum():
    raise SystemExit('Unsafe evidence label')
env = {
    'PATH': os.environ['PATH'],
    'HOME': str(OUT),
    'XDG_CACHE_HOME': str(OUT/'cache'),
    'TMPDIR': str(OUT/'tmp'),
    'NODE_ENV': 'test',
    'NODE_OPTIONS': ('--max-old-space-size=640' if label.endswith('-640') else '--max-old-space-size=512') + ' --require=' + str(OUT/'offline-guard.cjs'),
    'DOTENV_CONFIG_PATH': '/dev/null',
    'TRADING_MODE': 'paper',
    'AUTO_EXECUTE': 'false',
    'DATABASE_URL': 'postgresql://review:fixture@127.0.0.1:59998/review_test',
    'REDIS_URL': 'redis://127.0.0.1:59997',
    'UV_THREADPOOL_SIZE': '1',
    'OMP_NUM_THREADS': '1',
    'OPENBLAS_NUM_THREADS': '1',
    'RAYON_NUM_THREADS': '1',
    'GOMAXPROCS': '1',
    'NEXT_TELEMETRY_DISABLED': '1',
    'REVIEW_RESULTS': str(OUT/(label+'.json')),
    'REVIEW_EXISTING': '2' if label.startswith('existing-changed-') else '1' if label.startswith('existing-') else '0',
    'CI': '1'
}
(OUT/'tmp').mkdir(exist_ok=True)
start = time.monotonic()
with (OUT/(label+'.log')).open('w') as log:
    process = subprocess.Popen(args, cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    try:
        code = process.wait(timeout=240)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
        code = 124
record = {
    'label': label, 'command': args, 'finishedUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'exitCode': code, 'elapsedSeconds': round(time.monotonic()-start, 3), 'cpuAffinity': sorted(os.sched_getaffinity(0)),
    'syntheticEnvironment': True, 'outboundNetworkAndCredentialReadsGuarded': True,
    'log': str((OUT/(label+'.log')).relative_to(ROOT))
}
with (OUT/'commands.jsonl').open('a') as handle:
    handle.write(json.dumps(record)+'\n')
print(json.dumps(record, indent=2))
print((OUT/(label+'.log')).read_text()[-20000:])
raise SystemExit(code)
