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
import stat
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'threats/build-completion-20261116-sequential'
GUARD = ROOT / 'threats/sequential-fixes/offline-guard.cjs'
POLICY = ROOT / 'scripts/build-completion-inputs.json'
LOCK = Path('/tmp/swat-package11-checks.lock')
PACKAGES = ('shared', 'db', 'api', 'indexer', 'signal-engine', 'trade-executor',
            'scorer', 'discovery', 'alert-service', 'lp', 'web', 'tools', 'integration', 'api-tests', 'qualification')


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def entry_exists(path):
    """exists() incorrectly treats dangling symlinks as an unused label."""
    try:
        path.lstat()
        return True
    except FileNotFoundError:
        return False


def confined(path):
    resolved = path.resolve(strict=True)
    resolved.relative_to(ROOT)
    if not resolved.is_file():
        raise ValueError('Expected a regular file inside the workspace')
    return resolved


def exclusive_open(path):
    return os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), 'w')


def write_json(handle, value):
    json.dump(value, handle, indent=2)
    handle.write('\n')
    handle.flush()
    os.fsync(handle.fileno())


def read_regular(path):
    """Read a collection artifact without following a substituted final symlink."""
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
            raise ValueError('Collection artifact must be a private regular file')
        raw = stream.read()
        after = os.fstat(stream.fileno())
        if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise ValueError('Collection artifact changed while reading')
        return raw


def publish_bytes(path, raw):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as handle:
        handle.write(raw)
        handle.flush()
        os.fsync(handle.fileno())
    return hashlib.sha256(raw).hexdigest()


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
            args += ['--tsBuildInfoFile', str(OUT / 'tmp' / f'{target}.tsbuildinfo')]
        return args, [config, compiler], 640
    if kind == 'test':
        config = confined(ROOT / target)
        if not config.name.endswith('.config.ts') or 'threats' not in config.relative_to(ROOT).parts:
            raise ValueError('Tests require a reviewed literal-file threats config')
        inventory_path = confined(OUT / 'reviewed-configs.json')
        inventory = json.loads(inventory_path.read_text())
        if inventory.get('configs', {}).get(str(config.relative_to(ROOT))) != digest(config):
            raise ValueError('Test config is not in the reviewed hash-bound inventory')
        vitest = confined(ROOT / 'node_modules/vitest/vitest.mjs')
        return [node, str(vitest), 'run', '--config', str(config)], [config, vitest, inventory_path], 512
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
            return args, [script, names, template], 512
        return args, [script], 512
    raise ValueError('Unsupported check kind')


def credential_path(path):
    return any(part.startswith('.env') or part in ('.npmrc', '.netrc', 'pgpass', 'userlist.txt',
               'id_rsa', 'id_ed25519', 'wallet.json', 'keypair.json', 'credentials.json') for part in path.parts) or path.suffix in ('.pem', '.key')


def workspace_inputs(kind='typecheck', target=''):
    """Auditable conservative source + installed package-resolution closure."""
    policy = json.loads(POLICY.read_text())
    if policy.get('schema') != 1:
        raise ValueError('Unsupported workspace input policy')
    result = {}
    importers = set()
    seen_packages = set()
    excluded = [ROOT / name for name in policy['generatedWorkspacePrefixes']]
    evidence_directories = {ROOT / name for name in policy['generatedEvidenceDirectories']}
    if kind == 'emit':
        excluded.append(ROOT / ('packages' if target in ('shared', 'db') else 'apps') / target / 'dist')

    def skipped(path):
        relative = path.relative_to(ROOT)
        return (credential_path(relative) or any(part in policy['generatedDirectoryNames'] for part in relative.parts)
                or any(path == item or path.is_relative_to(item) for item in excluded)
                or ('threats' in relative.parts and path.name.startswith('build-') and path.suffix in ('.json', '.log')))

    def capture(path):
        info = path.lstat()
        # Confine ordinary paths too: a parent directory may itself be a symlink.
        resolved = path.resolve(strict=True)
        resolved.relative_to(ROOT)
        if credential_path(resolved.relative_to(ROOT)):
            raise ValueError('Input path resolves to credential-bearing path')
        name = str(path.relative_to(ROOT))
        if stat.S_ISLNK(info.st_mode):
            resolved = path.resolve(strict=True)
            resolved.relative_to(ROOT)
            if credential_path(resolved.relative_to(ROOT)):
                raise ValueError('Input symlink targets credential-bearing path')
            result[name] = {'symlink': os.readlink(path), 'target': str(resolved.relative_to(ROOT)),
                            'device': info.st_dev, 'inode': info.st_ino}
            return resolved
        if resolved != path:
            # Hash canonical bytes as well as every parent symlink identity.
            for parent in reversed(path.parents):
                if parent.is_relative_to(ROOT) and parent.is_symlink():
                    capture(parent)
            result[name + '#canonical'] = str(resolved.relative_to(ROOT))
            return resolved
        if stat.S_ISREG(info.st_mode):
            result[name] = digest(path)
            result[name + '#mode'] = stat.S_IMODE(info.st_mode)
        elif stat.S_ISDIR(info.st_mode):
            result[name + '/'] = {'directory': True}
        else:
            raise ValueError('Unsupported input filesystem entry: ' + name)
        return path

    def tree(path, ancestors=frozenset(), installed=False):
        if (credential_path(path.relative_to(ROOT))
            or any(path == item or path.is_relative_to(item) for item in excluded)
            or (not installed and skipped(path))):
            return
        canonical = capture(path)
        if canonical != path:
            tree(canonical, ancestors, installed)
            return
        if not canonical.is_dir():
            return
        if canonical in ancestors:
            raise ValueError('Input symlink directory cycle')
        ancestors = ancestors | {canonical}
        for item in sorted(canonical.iterdir()):
            if item.name == 'node_modules':
                if not installed:
                    importers.add(item)
                continue
            tree(item, ancestors, installed)

    def probe(path):
        if entry_exists(path):
            canonical = capture(path)
            if canonical != path:
                capture(canonical)
            return canonical
        result[str(path.relative_to(ROOT)) + '#absent'] = True
        return None

    def resolve_dependency(base, name):
        if not re.fullmatch(r'(?:@[A-Za-z0-9_.-]+/)?[A-Za-z0-9_.-]+', name) or name in ('.', '..'):
            raise ValueError('Invalid installed dependency name')
        current = base
        while current.is_relative_to(ROOT):
            if current.name != 'node_modules':
                found = probe(current / 'node_modules' / name)
                if found is not None:
                    return found
            if current == ROOT:
                break
            current = current.parent
        return None

    def package(path):
        canonical = path.resolve(strict=True)
        canonical.relative_to(ROOT)
        capture(path)
        # The walker normally returns for symlinks; package recursion also needs
        # canonical roots or workspace linked packages can recurse indefinitely.
        if canonical in seen_packages:
            return
        seen_packages.add(canonical)
        metadata = canonical / 'package.json'
        if not metadata.is_file():
            raise ValueError('Installed package lacks package.json: ' + str(canonical.relative_to(ROOT)))
        tree(canonical, installed=True)
        data = json.loads(metadata.read_text())
        for group in ('dependencies', 'optionalDependencies', 'peerDependencies'):
            for name in sorted(data.get(group, {})):
                dependency = resolve_dependency(canonical, name)
                if dependency is None:
                    if group == 'dependencies' and name not in data.get('optionalDependencies', {}):
                        raise ValueError('Missing installed runtime dependency: ' + name)
                    continue
                package(dependency)

    for item in sorted(ROOT.iterdir()):
        if item.name == 'node_modules':
            importers.add(item)
            continue
        # Client/credential configuration is not consumed by these commands.
        if item.name.startswith('.') and item.name != '.woodpecker.yaml':
            continue
        if item.is_file() or item.is_symlink():
            if not skipped(item):
                tree(item)
    for name in policy['sourceRoots']:
        path = ROOT / name
        if entry_exists(path):
            tree(path)
        else:
            result[name + '#absent'] = True
    importers.add(ROOT / 'node_modules')
    for importer in sorted(importers):
        canonical = probe(importer)
        if canonical is None:
            continue
        # Include launcher links used by package child execution, without running them.
        binary_directory = canonical / '.bin'
        if entry_exists(binary_directory):
            tree(binary_directory, installed=True)
        for item in sorted(canonical.iterdir()):
            if item.name == 'node_modules':
                continue
            if item.name.startswith('.'):
                continue
            if item.name.startswith('@'):
                capture(item)
                for scoped in sorted(item.iterdir()):
                    package(scoped)
            elif item.name != '.bin':
                package(item)
    for name in policy['installedMetadata']:
        path = ROOT / name
        if probe(path) is None:
            raise ValueError('Missing installed resolution metadata: ' + name)
    # Runtime identity is evidence, not permission to execute/read credentials.
    for name in policy['runtimePaths']:
        path = Path(name)
        result['runtime:' + name] = {'sha256': digest(path), 'target': str(path.resolve(strict=True))}
    return dict(sorted(result.items()))


def literal_test_files(config):
    text = config.read_text()
    matches = re.findall(r'createPackageConfig\s*\(\s*\[([\s\S]*?)\]\s*\)', text)
    if len(matches) != 1:
        raise ValueError('Expected one literal createPackageConfig inventory')
    body = re.sub(r'//[^\n]*|/\*[\s\S]*?\*/', '', matches[0])
    names = re.findall(r"['\"]([^'\"\n]+)['\"]", body)
    if not names or re.sub(r"['\"][^'\"\n]+['\"]|[\s,]", '', body):
        raise ValueError('Unsupported dynamic literal-file inventory')
    canonical = []
    for name in names:
        if re.search(r'[*?\[\]{}!()\\]', name):
            raise ValueError('Literal-file inventory contains dynamic syntax')
        path = confined(ROOT / name)
        if not re.search(r'\.(?:test|spec)\.[cm]?[jt]sx?$', path.name):
            raise ValueError('Literal-file inventory contains non-test file')
        canonical.append(str(path.relative_to(ROOT)))
    if len(set(canonical)) != len(canonical):
        raise ValueError('Duplicate literal test inventory')
    return canonical


def approval_binding(target):
    """Read-only generation API. Write the returned binding only after global freeze."""
    config = confined(ROOT / target)
    snapshot = workspace_inputs('test', target)
    root_name = str((OUT / 'reviewed-configs.json').relative_to(ROOT))
    return {'literalFiles': literal_test_files(config),
            'inputSha256': {name: value for name, value in snapshot.items()
                            if name not in (root_name, root_name + '#mode')}}


def validate_approval(kind, target, snapshot):
    if kind != 'test':
        return None
    config = confined(ROOT / target)
    name = str(config.relative_to(ROOT))
    inventory_path = OUT / 'reviewed-configs.json'
    inventory = json.loads(inventory_path.read_text())
    if inventory.get('configs', {}).get(name) != snapshot.get(name) or digest(config) != snapshot.get(name):
        raise ValueError('Selected reviewed config drifted')
    binding = inventory.get('commandBindings', {}).get(name)
    if not isinstance(binding, dict):
        raise ValueError('New execution requires additive reviewed commandBindings; historical evidence is unchanged')
    literal = literal_test_files(config)
    if binding.get('literalFiles') != literal:
        raise ValueError('Approved literal inventory differs from selected config')
    hashes = binding.get('inputSha256')
    # Despite its historical field name, this is the COMPLETE canonical manifest:
    # digest values plus symlink/directory/mode/runtime and absent-resolution identities.
    # The selected approval root is independently bound, never recursively self-hashed.
    root_name = str(inventory_path.relative_to(ROOT))
    closure = {path: value for path, value in snapshot.items()
               if path not in (root_name, root_name + '#mode')}
    if not isinstance(hashes, dict) or hashes != closure:
        raise ValueError('Reviewed command binding differs from complete input closure')
    required = set(literal) | {name, str(GUARD.relative_to(ROOT)),
        'threats/sequential-fixes/package12-29-harness.ts', 'threats/sequential-fixes/test-safety.ts',
        'scripts/build-completion-runner.py', 'scripts/build-completion-inputs.json'}
    if not required.issubset(hashes):
        raise ValueError('Reviewed command binding lacks literal/harness/guard/runner inputs')
    for path in required:
        if digest(confined(ROOT / path)) != snapshot.get(path):
            raise ValueError('Reviewed command input drift: ' + path)
    if digest(inventory_path) != snapshot.get(root_name):
        raise ValueError('Approval inventory drifted during validation')
    return {'literalFiles': literal, 'inputManifestSha256': hashlib.sha256(
                json.dumps(closure, sort_keys=True, separators=(',', ':')).encode()).hexdigest(),
            'inventorySha256': digest(inventory_path)}


def synthetic_environment(label, heap, attempt=None):
    temporary = attempt if attempt is not None else OUT / 'tmp'
    return {
        'PATH': '/usr/local/bin:/usr/bin:/bin',
        'HOME': str(temporary), 'XDG_CACHE_HOME': str(temporary),
        'TMPDIR': str(temporary), 'NODE_ENV': 'test', 'CI': '1',
        'PYTHONDONTWRITEBYTECODE': '1',
        'REVIEW_CACHE': str(temporary / 'vitest'),
        'NODE_OPTIONS': f'--max-old-space-size={heap} --require={GUARD}',
        'DOTENV_CONFIG_PATH': '/dev/null', 'TRADING_MODE': 'paper',
        'AUTO_EXECUTE': 'false', 'LIVE_ENABLED_CHAINS': '',
        'DATABASE_URL': 'postgresql://review:fixture@127.0.0.1:59998/review_test',
        'REDIS_URL': 'redis://127.0.0.1:59997', 'NEXT_TELEMETRY_DISABLED': '1',
        'UV_THREADPOOL_SIZE': '1', 'OMP_NUM_THREADS': '1', 'OPENBLAS_NUM_THREADS': '1',
        'RAYON_NUM_THREADS': '1', 'GOMAXPROCS': '1',
        'REVIEW_RESULTS': str(temporary / 'results.json') if attempt is not None else str(OUT / f'{label}.json'),
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


def stop_owned_child(child):
    """Only signal the session/group created by our Popen; tolerate exit races."""
    try:
        os.killpg(child.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        child.wait(timeout=5)
    except subprocess.TimeoutExpired:
        pass
    # A reaped leader does not imply its fork workers exited. Finish the owned
    # group even when wait() returned immediately, then reap the actual child.
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    child.wait()


def wait_for_check(child, timeout_seconds):
    try:
        return child.wait(timeout=timeout_seconds or None), False
    except subprocess.TimeoutExpired:
        stop_owned_child(child)
        return 124, True


def emit_plan(target, command, attempt):
    """Fail closed on unreviewed config shapes instead of guessing compiler output."""
    directory = ROOT / ('packages' if target in ('shared', 'db') else 'apps') / target
    config = json.loads((directory / 'tsconfig.json').read_text())
    base = json.loads((ROOT / 'tsconfig.base.json').read_text())
    options = {**base.get('compilerOptions', {}), **config.get('compilerOptions', {})}
    allowed = {'target', 'module', 'moduleResolution', 'strict', 'esModuleInterop',
               'forceConsistentCasingInFileNames', 'skipLibCheck', 'resolveJsonModule',
               'declaration', 'declarationMap', 'sourceMap', 'outDir', 'rootDir', 'composite'}
    if (config.get('references') not in (None, [], [{'path': '../shared'}])):
        raise ValueError('Unsupported emit project reference')
    if (config.get('extends') != '../../tsconfig.base.json' or base.get('extends')
        or set(options) - allowed or options.get('rootDir') != 'src' or options.get('outDir') != 'dist'
        or config.get('include') != ['src'] or any(config.get('files', []))
        or config.get('exclude', []) not in ([], ['src/**/*.test.ts'], ['src/**/*.test.ts', 'src/**/*.spec.ts'])
        or any(options.get(key) is not True for key in ('declaration', 'declarationMap', 'sourceMap'))):
        raise ValueError('Emit requires the narrowly reviewed src/dist declaration+map configuration')
    expected = set()
    sources = directory / 'src'
    for path in sorted(sources.rglob('*')):
        if path.is_symlink():
            raise ValueError('Emit source symlink requires a reviewed output mapping')
        if path.is_dir():
            continue
        confined(path)
        relative = path.relative_to(sources)
        if any(relative.match(pattern.removeprefix('src/')) or
               (pattern.endswith('**/*.test.ts') and path.name.endswith('.test.ts')) or
               (pattern.endswith('**/*.spec.ts') and path.name.endswith('.spec.ts'))
               for pattern in config.get('exclude', [])):
            continue
        if path.name.endswith('.d.ts'):
            continue
        if path.suffix != '.ts':
            # JSON imports / other emission modes need a reviewed extension, never silent omission.
            raise ValueError('Unsupported emit source extension: ' + str(relative))
        stem = relative.with_suffix('').as_posix()
        expected.update(stem + suffix for suffix in ('.js', '.js.map', '.d.ts', '.d.ts.map'))
    if not expected:
        raise ValueError('Empty expected compiler output')
    stage = attempt / 'emit'
    stage.mkdir(mode=0o700)
    build_info = attempt / 'compiler.tsbuildinfo'
    if entry_exists(build_info) or entry_exists(OUT / 'tmp' / f'{attempt.name}.tsbuildinfo'):
        raise FileExistsError('Build-info collision')
    args = list(command)
    if '--tsBuildInfoFile' in args:
        args[args.index('--tsBuildInfoFile') + 1] = str(build_info)
    elif options.get('composite'):
        args += ['--tsBuildInfoFile', str(build_info)]
    # Staging has a different depth from dist; explicit sourceRoot keeps emitted
    # source/declaration maps valid after proven files are moved to their destination.
    args += ['--outDir', str(stage), '--sourceRoot', str(sources) + '/',
             '--listEmittedFiles', '--noEmitOnError', 'true']
    return args, {'stage': stage, 'destination': directory / 'dist', 'expected': expected, 'buildInfo': build_info}


def artifact_inventory(directory):
    if not entry_exists(directory):
        return {}
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError('Artifact directory is not a regular directory')
    found = {}
    for path in sorted(directory.rglob('*')):
        if path.is_symlink():
            raise ValueError('Symlink in artifact tree')
        if path.is_dir():
            continue
        raw = read_regular(path)
        found[path.relative_to(directory).as_posix()] = hashlib.sha256(raw).hexdigest()
    return found


def collect_emit(plan, log_path):
    found = artifact_inventory(plan['stage'])
    if set(found) != plan['expected']:
        raise ValueError('Fresh compiler output incomplete or unexpected')
    listed = []
    for name in re.findall(r'^TSFILE: (.+)$', log_path.read_text(), re.M):
        path = Path(name)
        if path == plan['buildInfo']:
            read_regular(path)
            continue
        if not path.is_absolute() or not path.is_relative_to(plan['stage']):
            raise ValueError('Compiler reported unexpected output location')
        listed.append(path.relative_to(plan['stage']).as_posix())
    if len(set(listed)) != len(listed) or set(listed) != plan['expected']:
        raise ValueError('Actual emitted-file listing differs from complete fresh output')
    return found


def publish_emit(plan, before, hashes, published):
    destination = plan['destination']
    if artifact_inventory(destination) != before:
        raise ValueError('Existing dist changed during compiler execution')
    # Preflight every path before replacing any output. Unrelated survivors are retained.
    for name in hashes:
        path = destination / name
        for parent in [path.parent, *path.parent.parents]:
            if parent == destination.parent:
                break
            if entry_exists(parent) and (parent.is_symlink() or not parent.is_dir()):
                raise ValueError('Unsafe emit publication ancestor')
        if entry_exists(path) and (path.is_symlink() or not path.is_file()):
            raise ValueError('Unsafe emit publication entry')
    for name, expected in sorted(hashes.items()):
        source = plan['stage'] / name
        if hashlib.sha256(read_regular(source)).hexdigest() != expected:
            raise ValueError('Fresh artifact drift before publication')
        path = destination / name
        path.parent.mkdir(parents=True, exist_ok=True)
        os.replace(source, path)
        published[str(path.relative_to(ROOT))] = expected
    return published


def validate_results(raw, approval):
    report = json.loads(raw)
    literal = approval['literalFiles']
    files = report.get('testResults')
    if not isinstance(files, list) or not files or len(files) != len(literal):
        raise ValueError('Result manifest incomplete')
    expected = {str(ROOT / name) for name in literal}
    seen = set()
    counts = dict.fromkeys(('passed', 'failed', 'skipped', 'pending', 'todo'), 0)
    for file in files:
        if file.get('name') not in expected or file['name'] in seen or file.get('status') not in ('passed', 'failed'):
            raise ValueError('Result manifest unselected, duplicate or invalid file')
        seen.add(file['name'])
        assertions = file.get('assertionResults')
        if not isinstance(assertions, list) or not assertions:
            raise ValueError('Selected file has no assertions')
        for assertion in assertions:
            status_name = assertion.get('status')
            if status_name not in counts:
                raise ValueError('Invalid assertion status')
            counts[status_name] += 1
    aggregates = {'numTotalTests': sum(counts.values()), 'numPassedTests': counts['passed'],
                  'numFailedTests': counts['failed'], 'numPendingTests': counts['skipped'] + counts['pending'],
                  'numTodoTests': counts['todo']}
    if any(report.get(key) != value for key, value in aggregates.items()):
        raise ValueError('Contradictory assertion aggregates')
    if (report.get('success') is not True or any(file['status'] != 'passed' for file in files)
        or any(counts[name] for name in ('failed', 'skipped', 'pending', 'todo'))):
        raise ValueError('Zero-failure/skip/pending/todo acceptance gate failed')
    return counts


def diagnostic(errors, phase, error):
    errors.append({'phase': phase, 'type': type(error).__name__, 'message': str(error)})


def execute_attempt(options):
    """Called only under flock. Reserve first; finalization owns all error paths."""
    paths = {name: OUT / f'{options.label}{suffix}' for name, suffix in
             (('log', '.log'), ('record', '.command.json'), ('result', '.json'), ('inputs', '.inputs.json'))}
    attempts = OUT / 'attempts'
    if attempts.is_symlink():
        raise ValueError('Attempt namespace must not be a symlink')
    attempts.mkdir(mode=0o700, exist_ok=True)
    attempt = attempts / options.label
    if any(entry_exists(path) for path in (*paths.values(), attempt, OUT / 'tmp' / f'{options.label}.tsbuildinfo')):
        raise FileExistsError('Evidence label already exists; use a new label')
    attempt.mkdir(mode=0o700)
    errors = []
    start = time.monotonic()
    child = None
    command = []
    hashes = {}
    snapshot = {}
    approval = None
    emit = None
    before_artifacts = {}
    emitted = {}
    published = {}
    result_hash = None
    timed_out = False
    unchanged = False
    code = 125
    heap = 512 if options.kind in ('test', 'static') else 640
    record = {'label': options.label, 'kind': options.kind, 'target': options.target,
              'attemptDirectory': str(attempt.relative_to(ROOT)), 'runnerIdentity': str(Path(__file__)),
              'runnerSha256': None, 'diagnostics': errors}
    # Retain the descriptor: a late collision cannot overwrite somebody else's
    # record. The already-exclusive private namespace is the fallback evidence.
    try:
        record_handle = exclusive_open(paths['record'])
    except OSError as error:
        diagnostic(errors, 'command-record-reservation', error)
        record_handle = exclusive_open(attempt / 'final.command.json')
    with record_handle:
        try:
            with exclusive_open(attempt / 'reservation.json') as reservation:
                write_json(reservation, {**record, 'state': 'reserved'})
            if errors:
                raise ValueError('Shared record reservation failed; attempt retained privately')
            record['runnerSha256'] = digest(Path(__file__))
            command, inputs, heap = command_for(options.kind, options.target)
            planned_base = list(command)
            inputs += [Path(__file__), POLICY, GUARD, ROOT / 'pnpm-lock.yaml',
                       ROOT / 'threats/sequential-fixes/package12-29-harness.ts']
            hashes = {str(path.relative_to(ROOT)): digest(path) for path in inputs}
            if options.kind == 'emit':
                command, emit = emit_plan(options.target, command, attempt)
                before_artifacts = artifact_inventory(emit['destination'])
            elif '--tsBuildInfoFile' in command:
                build_info = attempt / 'compiler.tsbuildinfo'
                if entry_exists(build_info):
                    raise FileExistsError('Build-info collision')
                command[command.index('--tsBuildInfoFile') + 1] = str(build_info)
            snapshot = workspace_inputs(options.kind, options.target)
            with exclusive_open(paths['inputs']) as fingerprint:
                write_json(fingerprint, snapshot)
            with exclusive_open(paths['log']) as log:
                # Plan + approval are read again under the SAME lock immediately before Popen.
                fresh_command, fresh_inputs, fresh_heap = command_for(options.kind, options.target)
                if fresh_command != planned_base or fresh_heap != heap or any(digest(path) != hashes.get(str(path.relative_to(ROOT))) for path in fresh_inputs):
                    raise ValueError('Command inputs drifted during planning')
                if snapshot != workspace_inputs(options.kind, options.target):
                    raise ValueError('Workspace inputs drifted before launch')
                approval = validate_approval(options.kind, options.target, snapshot)
                child = subprocess.Popen(command, cwd=ROOT, env=synthetic_environment(options.label, heap, attempt),
                                         stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
                code, timed_out = wait_for_check(child, options.timeout_seconds)
        except BaseException as error:
            diagnostic(errors, 'planning-or-launch-or-wait', error)
            code = 125
        finally:
            if child is not None and not timed_out:
                try:
                    # A completed leader may leave workers in its owned process group.
                    stop_owned_child(child)
                except BaseException as error:
                    diagnostic(errors, 'owned-child-shutdown', error)
                    code = 125
            try:
                unchanged = bool(snapshot) and snapshot == workspace_inputs(options.kind, options.target)
                unchanged = unchanged and all(digest(ROOT / name) == value for name, value in hashes.items())
                if not unchanged:
                    raise ValueError('Workspace/input drift after attempt')
            except BaseException as error:
                diagnostic(errors, 'postrun-inputs', error)
                if code == 0:
                    code = 125
            if options.kind == 'test' and child is not None:
                try:
                    raw = read_regular(attempt / 'results.json')
                    # Retain rejected reports as evidence too; never overwrite prior labels.
                    result_hash = publish_bytes(paths['result'], raw)
                    validate_results(raw, approval)
                except BaseException as error:
                    diagnostic(errors, 'result-collection-or-acceptance', error)
                    if code == 0:
                        code = 125
            if emit is not None and child is not None:
                try:
                    emitted = collect_emit(emit, paths['log'])
                    if code == 0 and unchanged:
                        publish_emit(emit, before_artifacts, emitted, published)
                except BaseException as error:
                    diagnostic(errors, 'artifact-collection-or-publication', error)
                    if code == 0:
                        code = 125
            collected_hashes = {}
            for name in ('log', 'inputs'):
                try:
                    collected_hashes[name] = digest(paths[name])
                except BaseException as error:
                    collected_hashes[name] = None
                    diagnostic(errors, name + '-hash', error)
                    if code == 0:
                        code = 125
            try:
                affinity = sorted(os.sched_getaffinity(0))
            except BaseException as error:
                affinity = None
                diagnostic(errors, 'affinity-collection', error)
                if code == 0:
                    code = 125
            record.update({
                'command': command, 'exitCode': code, 'timedOut': timed_out,
                'timeoutSeconds': options.timeout_seconds or None,
                'finishedUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                'elapsedSeconds': round(time.monotonic() - start, 3),
                'cpuAffinity': affinity, 'nodeHeapMb': heap,
                'inputSha256': hashes, 'logSha256': collected_hashes['log'],
                'workspaceInputManifest': str(paths['inputs'].relative_to(ROOT)),
                'workspaceInputManifestSha256': collected_hashes['inputs'],
                'workspaceInputsUnchanged': unchanged, 'childExitCode': child.returncode if child is not None else None,
                'resultSha256': result_hash, 'approvalBinding': approval,
                'freshStagedArtifactsSha256': emitted, 'emittedArtifactsSha256': published,
                'preexistingDistSha256': before_artifacts,
                'staleDistSurvivorsSha256': {name: value for name, value in before_artifacts.items() if name not in emitted},
                'syntheticEnvironment': True, 'nodeNetworkAndCredentialGuard': str(GUARD.relative_to(ROOT)),
                'scope': 'Reviewed offline check; not native, SQL, provider or deployment acceptance',
            })
            try:
                write_json(record_handle, record)
            except BaseException as error:
                # A write failure must not silently erase an otherwise completed
                # attempt. Preserve a private final record when storage permits.
                diagnostic(errors, 'command-record-finalization', error)
                code = 125
                record['exitCode'] = code
                fallback = attempt / 'finalization-failure.command.json'
                with exclusive_open(fallback) as handle:
                    write_json(handle, record)
    print(json.dumps(record, indent=2))
    if entry_exists(paths['log']):
        try:
            print(paths['log'].read_text()[-20000:])
        except OSError:
            pass
    return code


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
    if OUT.is_symlink():
        raise ValueError('Evidence directory must not be a symlink')
    OUT.mkdir(exist_ok=True)
    os.sched_setaffinity(0, {0})
    with verification_lock() as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        # Cooperating verification serialization, NOT a lock on independent writers.
        return execute_attempt(options)


if __name__ == '__main__':
    sys.exit(main())
