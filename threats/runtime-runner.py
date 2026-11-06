import json
import os
import resource
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path('/home/xahmie/Documents/SWAT')
OUT = ROOT / 'threats/runtime'
OUT.mkdir(exist_ok=True)
CPU = min(os.sched_getaffinity(0))
os.sched_setaffinity(0, {CPU})
ENV = {'PATH': os.environ['PATH'], 'HOME': os.environ['HOME'], 'LANG': 'C.UTF-8',
       'NODE_ENV': 'test', 'NODE_OPTIONS': '--max-old-space-size=384',
       'UV_THREADPOOL_SIZE': '1', 'OMP_NUM_THREADS': '1', 'OPENBLAS_NUM_THREADS': '1',
       'RAYON_NUM_THREADS': '1', 'DOTENV_CONFIG_PATH': '/dev/null',
       'TRADING_MODE': 'paper', 'AUTO_EXECUTE': 'false', 'CI': 'true',
       'DATABASE_URL': 'postgresql://swat:runtime-local-only@127.0.0.1:55432/swat_runtime_integration',
       'INTEGRATION_DATABASE_URL': 'postgresql://swat:runtime-local-only@127.0.0.1:55432/swat_runtime_integration',
       'REDIS_URL': 'redis://127.0.0.1:56379', 'DATABASE_POOL_MAX': '4'}

def run(name, command, timeout=240, cwd=ROOT, extra=None):
    environment = ENV | (extra or {})
    start = time.monotonic()
    log = OUT / (name + '.log')
    print('START', name, flush=True)
    with log.open('w') as stream:
        process = subprocess.Popen(command, cwd=cwd, env=environment,
                                   stdout=stream, stderr=subprocess.STDOUT,
                                   start_new_session=True)
        try:
            code = process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            import signal
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            code = 124
    record = {'name': name, 'command': command, 'cwd': str(cwd.relative_to(ROOT)),
              'cpu': CPU, 'seconds': round(time.monotonic()-start, 3),
              'exit_code': code, 'log': str(log.relative_to(ROOT)),
              'timestamp_utc': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
    with (OUT / 'commands.jsonl').open('a') as stream:
        stream.write(json.dumps(record) + '\n')
    print('DONE', name, 'exit', code, 'seconds', record['seconds'], flush=True)
    text = log.read_text(errors='replace')
    print(text[-5000:], flush=True)
    return code

if __name__ == '__main__':
    sys.exit(run(sys.argv[1], sys.argv[2:]))
