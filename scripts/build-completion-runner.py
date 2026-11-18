#!/usr/bin/env python3
"""Bounded, offline checks with immutable per-command evidence."""
import argparse
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'threats/build-completion-20261116-sequential'
GUARD = ROOT / 'threats/sequential-fixes/offline-guard.cjs'
LOCK = Path('/tmp/swat-package11-checks.lock')
PACKAGES = ('shared', 'db', 'api', 'indexer', 'signal-engine', 'trade-executor',
            'scorer', 'discovery', 'alert-service', 'lp', 'web', 'tools', 'integration', 'api-tests', 'qualification')


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def confined(path):
    resolved = path.resolve(strict=True)
    resolved.relative_to(ROOT)
    if not resolved.is_file():
        raise ValueError('Expected a regular file inside the workspace')
    return resolved


def command_for(kind, target):
    node = '/usr/bin/node'
    if kind in ('emit', 'typecheck'):
        if target not in PACKAGES or (kind == 'emit' and target in ('web', 'tools', 'integration', 'api-tests', 'qualification')):
            raise ValueError('Unsupported compiler target')
        if target == 'api-tests':
            config = ROOT / 'apps/api/tsconfig.test.json'
        elif target in ('tools', 'integration', 'qualification'):
            config = ROOT / f'tsconfig.{target}.json'
        else:
            directory = 'packages' if target in ('shared', 'db') else 'apps'
            config = ROOT / directory / target / 'tsconfig.json'
        compiler = confined(ROOT / 'node_modules/typescript/bin/tsc')
        args = [node, str(compiler), '-p', str(confined(config))]
        args += ['--incremental', 'false'] if target not in ('shared', 'web') else []
        if kind == 'typecheck':
            args += ['--noEmit']
        if target in ('shared', 'web'):
            # Build info is compiler state, not a certificate of fresh output.
            args += ['--tsBuildInfoFile', str(OUT / 'tmp' / f'{target}.tsbuildinfo')]
        return args, [config, compiler], 640
    if kind == 'test':
        config = confined(ROOT / target)
        if not config.name.endswith('.config.ts') or 'threats' not in config.relative_to(ROOT).parts:
            raise ValueError('Tests require a reviewed literal-file threats config')
        inventory = json.loads((OUT / 'reviewed-configs.json').read_text())
        reviewed_hash = inventory.get('configs', {}).get(str(config.relative_to(ROOT)))
        if reviewed_hash != digest(config):
            raise ValueError('Test config is not in the reviewed hash-bound inventory')
        vitest = confined(ROOT / 'node_modules/vitest/vitest.mjs')
        return [node, str(vitest), 'run', '--config', str(config)], [config, vitest], 512
    if kind == 'static':
        allowed = {
            'secrets': ('node', 'scripts/check-public-secrets.mjs'),
            'env': ('node', 'scripts/check-env-coverage.mjs'),
            'ml-boundary': ('python', 'pattern-ml/tests/package25_ml_boundary_unittest.py'),
            'ml-source': ('python', 'pattern-ml/tests/package25_ml_source_checks.py'),
            'ops': ('python', 'deploy/tests/ops_static_test.py'),
            'inventory': ('python', 'deploy/tools/ops-readiness.py'),
            'runner': ('python', 'scripts/build-completion-runner.test.py'),
        }
        if target not in allowed:
            raise ValueError('Unsupported static check')
        runtime, name = allowed[target]
        script = confined(ROOT / name)
        args = [node, str(script)] if runtime == 'node' else ['/usr/bin/python3', '-I', '-S', str(script)]
        if target == 'inventory':
            args += ['--verify-only', '--root', str(ROOT)]
        if target == 'ml-source':
            args += ['focused']
        if target == 'env':
            names = confined(OUT / 'env-assignment-names.json')
            inventory = json.loads(names.read_text())
            template = ROOT / '.env.example'
            raw = template.read_bytes()
            actual_names = sorted(set(name.decode('ascii') for name in re.findall(rb'^([A-Z][A-Z0-9_]*)\s*=', raw, re.M)))
            if (inventory.get('source') != '.env.example'
                or inventory.get('sourceSha256') != hashlib.sha256(raw).hexdigest()
                or inventory.get('assignmentNames') != actual_names):
                raise ValueError('Assignment-name inventory does not match the current template')
            args += ['--names-file', str(names)]
            # Only hashes/names are retained; Node credential-read guard is unchanged.
            return args, [script, names, template], 512
        return args, [script], 512
    raise ValueError('Unsupported check kind')


def workspace_inputs(kind='typecheck', target=''):
    paths = []
    roots = ('apps', 'packages', 'programs', 'pattern-ml', 'pda-test-ui', 'tests', 'scripts', 'deploy')
    ignored = {'node_modules', '.next', '.turbo', '__pycache__', '.git', 'target', '.venv'}
    extensions = {'.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rs', '.sql', '.toml', '.json'}
    for name in roots:
        for directory, dirs, files in os.walk(ROOT / name, followlinks=False):
            dirs[:] = [item for item in dirs if item not in ignored]
            for filename in files:
                path = Path(directory) / filename
                if path.is_symlink() or re.search(r'(^|/)(?:\.env(?:\.[^/]*)?|id_rsa|id_ed25519|wallet\.json|keypair\.json|credentials\.json)$', str(path)):
                    continue
                if path.suffix in extensions or filename in ('package.json', 'tsconfig.json'):
                    paths.append(path)
    paths.extend(path for path in ROOT.glob('tsconfig*.json') if path.is_file())
    paths += [ROOT / 'package.json', ROOT / 'pnpm-lock.yaml', ROOT / 'pnpm-workspace.yaml', GUARD,
              ROOT / 'threats/sequential-fixes/package12-29-harness.ts',
              ROOT / 'threats/sequential-fixes/test-safety.ts', OUT / 'reviewed-configs.json']
    for path in (ROOT / 'threats').rglob('*'):
        if path.is_file() and not path.is_symlink() and path.suffix in ('.ts', '.cjs', '.mjs'):
            if 'cache' not in path.parts and 'tmp' not in path.parts:
                paths.append(path)
    for package, pattern in [('typescript', 'lib/*.js'), ('vitest', 'dist/**/*.js')]:
        paths += list((ROOT / 'node_modules' / package).resolve().glob(pattern))
    if kind == 'emit':
        directory = 'packages' if target in ('shared', 'db') else 'apps'
        output = ROOT / directory / target / 'dist'
        paths = [path for path in paths if not path.is_relative_to(output)]
    return {str(path.relative_to(ROOT)): digest(path) for path in sorted(set(paths))}


def synthetic_environment(label, heap):
    return {
        'PATH': '/usr/local/bin:/usr/bin:/bin',
        'HOME': str(OUT / 'tmp'), 'XDG_CACHE_HOME': str(OUT / 'tmp'),
        'TMPDIR': str(OUT / 'tmp'), 'NODE_ENV': 'test', 'CI': '1',
        'PYTHONDONTWRITEBYTECODE': '1',
        'REVIEW_CACHE': str(OUT / 'tmp' / 'vitest'),
        'NODE_OPTIONS': f'--max-old-space-size={heap} --require={GUARD}',
        'DOTENV_CONFIG_PATH': '/dev/null', 'TRADING_MODE': 'paper',
        'AUTO_EXECUTE': 'false', 'LIVE_ENABLED_CHAINS': '',
        'DATABASE_URL': 'postgresql://review:fixture@127.0.0.1:59998/review_test',
        'REDIS_URL': 'redis://127.0.0.1:59997', 'NEXT_TELEMETRY_DISABLED': '1',
        'UV_THREADPOOL_SIZE': '1', 'OMP_NUM_THREADS': '1', 'OPENBLAS_NUM_THREADS': '1',
        'RAYON_NUM_THREADS': '1', 'GOMAXPROCS': '1',
        'REVIEW_RESULTS': str(OUT / f'{label}.json'),
    }


def verification_lock():
    # Reuse flock's inherited open-file description; reopening it would deadlock.
    expected = LOCK.stat() if LOCK.exists() else None
    if expected is not None:
        for entry in Path('/proc/self/fd').iterdir():
            try:
                fd = int(entry.name)
                actual = os.fstat(fd)
                if fd > 2 and (actual.st_dev, actual.st_ino) == (expected.st_dev, expected.st_ino):
                    return os.fdopen(os.dup(fd), 'a')
            except (OSError, ValueError):
                continue
    return LOCK.open('a')


def wait_for_check(child, timeout_seconds):
    try:
        return child.wait(timeout=timeout_seconds or None), False
    except subprocess.TimeoutExpired:
        os.killpg(child.pid, signal.SIGTERM)
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()
        return 124, True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('label')
    parser.add_argument('kind', choices=('emit', 'typecheck', 'test', 'static'))
    parser.add_argument('target')
    parser.add_argument('--evidence-dir', choices=('threats/build-completion-20261116-sequential',
                                                  'threats/project-completion-20261117'),
                        default='threats/build-completion-20261116-sequential')
    parser.add_argument('--timeout-seconds', type=int, default=240,
                        help='Check wall-clock limit; zero waits without a time cap')
    options = parser.parse_args()
    if options.timeout_seconds < 0:
        parser.error('Check timeout must be nonnegative')
    global OUT
    OUT = ROOT / options.evidence_dir
    if not re.fullmatch(r'build-[A-Za-z0-9_-]{1,100}', options.label):
        parser.error('Evidence label must start build- and contain only letters, digits, hyphens or underscores')
    command, inputs, heap = command_for(options.kind, options.target)
    OUT.mkdir(exist_ok=True)
    (OUT / 'tmp').mkdir(exist_ok=True)
    if options.kind in ('emit', 'typecheck') and options.target in ('shared', 'web'):
        command[command.index('--tsBuildInfoFile') + 1] = str(OUT / 'tmp' / f'{options.label}.tsbuildinfo')
    log_path = OUT / f'{options.label}.log'
    record_path = OUT / f'{options.label}.command.json'
    result_path = OUT / f'{options.label}.json'
    os.sched_setaffinity(0, {0})
    with verification_lock() as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if any(path.exists() for path in (log_path, record_path, result_path)):
            raise FileExistsError('Evidence label already exists; use a new label')
        inputs += [Path(__file__), GUARD, ROOT / 'pnpm-lock.yaml',
                   ROOT / 'threats/sequential-fixes/package12-29-harness.ts']
        hashes = {str(path.relative_to(ROOT)): digest(path) for path in inputs}
        source_hashes = workspace_inputs(options.kind, options.target)
        fingerprint_path = OUT / f'{options.label}.inputs.json'
        if fingerprint_path.exists():
            raise FileExistsError('Source fingerprint evidence already exists')
        with fingerprint_path.open('x') as handle:
            json.dump(source_hashes, handle, indent=2)
            handle.write('\n')
        start = time.monotonic()
        timed_out = False
        with log_path.open('x') as log:
            child = subprocess.Popen(command, cwd=ROOT, env=synthetic_environment(options.label, heap),
                                     stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            code, timed_out = wait_for_check(child, options.timeout_seconds)
        unchanged = (source_hashes == workspace_inputs(options.kind, options.target)
                     and all(digest(ROOT / name) == value for name, value in hashes.items()))
        child_code = code
        if code == 0 and (not unchanged or options.kind == 'test' and not result_path.is_file()):
            code = 125
        artifact_hashes = {}
        if options.kind == 'emit':
            directory = 'packages' if options.target in ('shared', 'db') else 'apps'
            artifact_hashes = {str(path.relative_to(ROOT)): digest(path)
                              for path in sorted((ROOT / directory / options.target / 'dist').rglob('*'))
                              if path.is_file() and not path.is_symlink()}
        record = {
            'label': options.label, 'kind': options.kind, 'target': options.target,
            'command': command, 'exitCode': code, 'timedOut': timed_out,
            'timeoutSeconds': options.timeout_seconds or None,
            'finishedUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'elapsedSeconds': round(time.monotonic() - start, 3),
            'cpuAffinity': sorted(os.sched_getaffinity(0)), 'nodeHeapMb': heap,
            'inputSha256': hashes, 'logSha256': digest(log_path),
            'workspaceInputManifest': str(fingerprint_path.relative_to(ROOT)),
            'workspaceInputManifestSha256': digest(fingerprint_path),
            'workspaceInputsUnchanged': unchanged, 'childExitCode': child_code,
            'resultSha256': digest(result_path) if result_path.is_file() else None,
            'emittedArtifactsSha256': artifact_hashes,
            'syntheticEnvironment': True, 'nodeNetworkAndCredentialGuard': str(GUARD.relative_to(ROOT)),
            'scope': 'Reviewed offline check; not native, SQL, provider or deployment acceptance',
        }
        with record_path.open('x') as handle:
            json.dump(record, handle, indent=2)
            handle.write('\n')
        print(json.dumps(record, indent=2))
        print(log_path.read_text()[-20000:])
        return code


if __name__ == '__main__':
    sys.exit(main())
