#!/usr/bin/env python3
"""Read-only deployment inventory/preflight. Never runs tools or changes a host.

--verify-only is mandatory. JSON stdout is public hashes/metadata only; environment
values and backup content are never emitted. An observed inventory is not approval.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys

ROOT = Path(__file__).resolve().parents[2]
SERVICES = {
    'api': ('apps/api', 'apps/api/dist/index.js'),
    'lp': ('apps/lp', 'apps/lp/dist/index.js'),
    'trade-executor': ('apps/trade-executor', 'apps/trade-executor/dist/index.js'),
    'billing-sweep': ('apps/api', 'apps/api/dist/cron/billing-sweep.js'),
    'web': ('apps/web', 'apps/web/node_modules/next/dist/bin/next'),
}
SOURCE_TOP = ('apps', 'packages', 'scripts', 'deploy', '.woodpecker', 'pattern-ml', 'programs')
SOURCE_ROOT = ('package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'turbo.json',
               'tsconfig.json', 'tsconfig.base.json', '.woodpecker.yaml', 'DEPLOYMENT.md')
SKIP = {'node_modules', 'dist', '.next', '.git', '__pycache__', '.venv', 'venv',
        'data', 'models', 'artifacts', 'cache', '.pytest_cache', 'target', '.turbo'}
EXTENSIONS = {'.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.yaml', '.yml', '.sql',
              '.py', '.toml', '.rs', '.sh', '.service', '.timer', '.css', '.html'}
HEX = re.compile(r'[0-9a-f]{64}')
KEY = re.compile(r'[A-Z][A-Z0-9_]*')
FORBIDDEN = re.compile(r'(?:PRIVATE_KEY|CUSTODY_MASTER_KEY|MNEMONIC|SEED_PHRASE|VERCEL_TOKEN|JITO_AUTH_KEY)')


def sha(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def safe_name(name):
    if not isinstance(name, str) or not name:
        raise ValueError('Invalid inventory path')
    path = PurePosixPath(name)
    if (path.is_absolute() or path.as_posix() != name or '..' in path.parts or
            any(ord(c) < 32 or c == '\\' for c in name) or
            any(p.startswith('.env') or p in ('.npmrc', '.netrc', '.git', 'pgpass', 'userlist.txt')
                for p in path.parts)):
        raise ValueError('Unsafe or credential-bearing inventory path')
    return path


def source_inventory(root):
    paths = set()
    for name in SOURCE_ROOT:
        path = root / name
        if path.is_file() and not path.is_symlink():
            paths.add(path)
    for top in SOURCE_TOP:
        directory = root / top
        if directory.is_symlink() or not directory.is_dir():
            continue
        for base, dirs, files in os.walk(directory, followlinks=False):
            dirs[:] = sorted(d for d in dirs if d not in SKIP and
                             not (Path(base) / d).is_symlink())
            for name in sorted(files):
                path = Path(base) / name
                if path.suffix not in EXTENSIONS or path.is_symlink():
                    continue
                try:
                    safe_name(path.relative_to(root).as_posix())
                except ValueError:
                    continue
                paths.add(path)
    return [{'path': path.relative_to(root).as_posix(), 'sha256': sha(path),
             'mode': '0444'} for path in sorted(paths)]


def lock_packages(text):
    # Exact pnpm v9 package blocks, not a generic YAML parser. Keep raw integrity
    # lines/identity; unknown format is refused, never treated as a resolved lock.
    if not text.startswith("lockfileVersion: '9.0'\n") or '\npackages:\n' not in text:
        raise ValueError('Unsupported lock format')
    section = text.split('\npackages:\n', 1)[1].split('\nsnapshots:\n', 1)[0]
    rows = []
    for block in re.split(r'\n(?=  \S)', section):
        lines = block.splitlines()
        if not lines or not lines[0].startswith('  ') or not lines[0].endswith(':'):
            continue
        identity = lines[0].strip()[:-1].strip("'")
        integrity = re.search(r'integrity: ([^},\s]+)', block)
        rows.append({'identity': identity, 'integrity': integrity.group(1) if integrity else None})
    if not rows:
        raise ValueError('Missing lock package records')
    return rows


def observe(root):
    source_lock = root / 'pnpm-lock.yaml'
    source_text = source_lock.read_text()
    records = lock_packages(source_text)
    installed = root / 'node_modules/.pnpm/lock.yaml'
    installed_records = lock_packages(installed.read_text()) if installed.is_file() else []
    expected = {r['identity']: r['integrity'] for r in records}
    actual = {r['identity']: r['integrity'] for r in installed_records}
    modules = root / 'node_modules/.modules.yaml'
    manager = re.search(r'^packageManager: (.+)$', modules.read_text(), re.M) if modules.is_file() else None
    tools = []
    for name, path in [('node', Path('/usr/bin/node')),
                       ('pnpm-launcher', Path('/usr/local/lib/node_modules/pnpm/package.json')),
                       ('python', Path(sys.executable).resolve())]:
        if path.is_file():
            row = {'name': name, 'path': str(path), 'sha256': sha(path)}
            if path.suffix == '.json':
                row['launcherMetadataVersion'] = json.loads(path.read_text()).get('version')
            tools.append(row)
    artifacts = []
    for service, (_, name) in SERVICES.items():
        path = root / name
        artifacts.append({'service': service, 'path': name, 'present': path.is_file(),
                          'sha256': sha(path) if path.is_file() else None,
                          'buildProvenance': 'unverified'})
    for name in ('apps/web/.next/BUILD_ID', 'apps/web/.next/required-server-files.json'):
        path = root / name
        artifacts.append({'path': name, 'present': path.is_file(),
                          'sha256': sha(path) if path.is_file() else None,
                          'buildProvenance': 'unverified'})
    locks = {}
    for name in ('package27-deploy-artifacts.lock.json', 'package27-deploy-python.lock.json'):
        path = root / 'deploy/tools' / name
        locks[name] = {'sha256': sha(path), 'approval': json.loads(path.read_text()).get('approval')}
    return {'schema': 1, 'approval': 'observed-only', 'publisherApproved': False,
            'runtimeAcceptance': False, 'effectivePnpmInvocation': 'not executed; launcher may delegate',
            'requiredPnpm': json.loads((root / 'package.json').read_text())['packageManager'],
            'installedManagerMetadata': manager.group(1) if manager else None,
            'lockSha256': sha(source_lock), 'installedLockSha256': sha(installed) if installed.is_file() else None,
            'lockPackages': records, 'installedMissingPackageIdentities': sorted(set(expected) - set(actual)),
            'installedIntegrityMismatches': sorted(k for k in expected.keys() & actual.keys() if expected[k] != actual[k]),
            'importerBytesMatch': (source_text.split('\npackages:\n')[0] ==
                                  installed.read_text().split('\npackages:\n')[0]) if installed.is_file() else False,
            'tools': tools, 'artifacts': artifacts, 'approvalLocks': locks,
            'sourceFiles': source_inventory(root),
            'gates': ['immutable image/tool/runtime/transitive inventory and independent approval',
                      'fresh emitted artifacts with source/lock/build evidence binding',
                      'paper staging schema/roles/zero certifications and no custody keys',
                      'host permissions/TLS/ingress/state-cache/restart proof',
                      'encrypted offsite backup and nightly isolated restore proof',
                      'separate manual production authorization; no self-promotion']}


def parse_env(text):
    env = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        if '=' not in line:
            raise ValueError('Environment must be literal KEY=value data')
        name, value = line.split('=', 1)
        if not KEY.fullmatch(name) or name in env:
            raise ValueError('Duplicate/invalid environment key')
        # Deliberately conservative subset of systemd EnvironmentFile grammar.
        if any(c in value for c in ('$', '`', '\\', '"', "'", '\x00')):
            raise ValueError('Shell expansion/quoting is not accepted in paper env')
        env[name] = value
    return env


def paper_env(env, service):
    if env.get('NODE_ENV') != 'production' or env.get('TRADING_MODE') != 'paper' or env.get('AUTO_EXECUTE') != 'false':
        raise ValueError('Explicit production/paper/auto-execute=false clamps required')
    if 'LIVE_ENABLED_CHAINS' not in env or env['LIVE_ENABLED_CHAINS'].strip():
        raise ValueError('Explicit empty certified chain allowlist required')
    if any(name.startswith('TRADING_MODE_') and value != 'paper' for name, value in env.items()):
        raise ValueError('Per-chain overrides must remain paper')
    if any(FORBIDDEN.search(name) and value.strip() for name, value in env.items()):
        raise ValueError('Paper service must not receive signing/custody/publish secrets')
    if service in ('api', 'lp', 'trade-executor', 'billing-sweep') and not env.get('DATABASE_URL'):
        raise ValueError('Scoped database connection required')
    if service in ('api', 'lp', 'trade-executor') and not env.get('REDIS_URL'):
        raise ValueError('Scoped cache connection required')
    if service in ('api', 'lp') and not env.get('API_KEY'):
        raise ValueError('Production service authentication required')
    if service == 'api' and env.get('DISABLE_BILLING_SWEEPER_DAEMON') != 'true':
        raise ValueError('API billing daemon must be disabled when dedicated timer is used')
    return {'paperEnvironment': 'verified', 'valuesDisclosed': False,
            'databaseCertificationState': 'unverified; must be independently zero'}


def root_owned(path, directory=False):
    info = path.stat()
    if info.st_uid != 0 or info.st_mode & 0o022 or (directory and not path.is_dir()):
        raise ValueError('Release/ancestor must be root-owned and not group/other writable')


def verify_release(root, service):
    # current may be a root-controlled release pointer; every resolved ancestor is checked.
    root_owned(root.parent, True)
    if root.is_symlink() and root.lstat().st_uid != 0:
        raise ValueError('Release pointer must be root-owned')
    root = root.resolve(strict=True)
    for path in (root, *root.parents):
        root_owned(path, True)
    manifest_path = root / 'deploy/release-manifest.json'
    if manifest_path.is_symlink():
        raise ValueError('Release manifest must not be a link')
    manifest = json.loads(manifest_path.read_text())
    if (manifest.get('schema') != 1 or manifest.get('approval') != 'reviewed' or
            manifest.get('target') != 'paper-staging' or
            not re.fullmatch(r'[0-9a-f]{40}', manifest.get('sourceCommit', '')) or
            not HEX.fullmatch(manifest.get('buildEvidenceSha256', '')) or
            not re.fullmatch(r'[^\s]+@sha256:[0-9a-f]{64}', manifest.get('runtimeImage', ''))):
        raise ValueError('Reviewed immutable paper build provenance required')
    rows = manifest.get('files', [])
    if not isinstance(rows, list) or not rows:
        raise ValueError('Complete release inventory required')
    expected = {}
    for row in rows:
        name = safe_name(row.get('path')).as_posix()
        if name in expected or row.get('mode') not in ('0444', '0555'):
            raise ValueError('Duplicate release file/unsafe mode')
        expected[name] = row
    actual = set()
    for base, dirs, files in os.walk(root, followlinks=False):
        for name in dirs + files:
            path = Path(base) / name
            relative = path.relative_to(root).as_posix()
            root_owned(path)
            if path.is_symlink():
                # Runtime dependency links must be explicitly inventoried and contained.
                row = expected.get(relative, {})
                if relative == 'apps/web/.next/cache':
                    if str(path.resolve()) != '/var/lib/swat-web/cache':
                        raise ValueError('Only scoped Next cache link permitted')
                    continue
                if row.get('link') != os.readlink(path) or not path.resolve().is_relative_to(root):
                    raise ValueError('Uninventoried/escaping runtime link')
                actual.add(relative)
            elif path.is_file():
                if relative == 'deploy/release-manifest.json':
                    continue
                row = expected.get(relative, {})
                if not HEX.fullmatch(row.get('sha256', '')) or sha(path) != row['sha256']:
                    raise ValueError('Release inventory/hash mismatch')
                if stat.S_IMODE(path.stat().st_mode) != int(row.get('mode', '0'), 8):
                    raise ValueError('Release file mode mismatch')
                actual.add(relative)
            elif not path.is_dir():
                raise ValueError('Special files forbidden in release')
    if actual != set(expected):
        raise ValueError('Release inventory incomplete')
    entry = SERVICES[service][1]
    for required in (entry, 'pnpm-lock.yaml', 'package.json', 'packages/shared/dist/index.js',
                     'packages/db/dist/index.js'):
        if not (root / required).is_file() or required not in expected:
            raise ValueError('Runtime/lock entrypoint inventory incomplete')
    if sha(root / 'pnpm-lock.yaml') != manifest.get('lockSha256'):
        raise ValueError('Build lock provenance mismatch')
    node = Path('/usr/bin/node')
    if not HEX.fullmatch(manifest.get('nodeSha256', '')) or sha(node) != manifest['nodeSha256']:
        raise ValueError('Host Node runtime differs from reviewed inventory')
    if service == 'web':
        for name in ('BUILD_ID', 'required-server-files.json'):
            if 'apps/web/.next/' + name not in expected:
                raise ValueError('Next build artifacts required')
    return {'releaseInventory': 'verified', 'runtimeAcceptance': False,
            'sourceCommit': manifest['sourceCommit'], 'publisherApproved': False}


def backup_preflight(manifest, artifact):
    # Only inspect an already encrypted artifact; never decrypt, restore or call pg tools.
    if artifact.is_symlink() or not artifact.is_file():
        raise ValueError('Encrypted backup must be a regular file')
    if artifact.stat().st_mode & 0o077:
        raise ValueError('Backup must be owner-only')
    if (manifest.get('schema') != 1 or manifest.get('approval') != 'reviewed' or
            manifest.get('encrypted') is not True or manifest.get('retentionDays') != 30 or
            manifest.get('rpoHours') != 24 or manifest.get('target') != 'isolated-paper-staging' or
            not HEX.fullmatch(manifest.get('sha256', '')) or
            manifest['sha256'] != sha(artifact) or manifest.get('bytes') != artifact.stat().st_size or
            not HEX.fullmatch(manifest.get('schemaSha256', '')) or
            not HEX.fullmatch(manifest.get('encryptionEvidenceSha256', ''))):
        raise ValueError('Reviewed encrypted backup/retention/schema/hash evidence required')
    return {'backupIdentity': 'verified', 'restoreExecuted': False, 'restoreAccepted': False,
            'gates': ['independent decryptability/key recovery proof', 'nightly offsite retention audit',
                      'disposable DB identity/zero certifications/no custody keys',
                      'restore/schema/role/reconciliation and measured RPO/RTO proof']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--verify-only', action='store_true', required=True)
    parser.add_argument('--root', type=Path, default=ROOT)
    parser.add_argument('--service', choices=SERVICES)
    parser.add_argument('--release', type=Path)
    parser.add_argument('--env-file', type=Path)
    parser.add_argument('--backup-manifest', type=Path)
    parser.add_argument('--encrypted-backup', type=Path)
    args = parser.parse_args()
    try:
        if args.backup_manifest or args.encrypted_backup:
            if not args.backup_manifest or not args.encrypted_backup:
                raise ValueError('Both backup manifest and artifact required')
            result = backup_preflight(json.loads(args.backup_manifest.read_text()), args.encrypted_backup)
        elif args.service:
            env = dict(os.environ)
            if args.env_file:
                if args.env_file.is_symlink() or args.env_file.stat().st_mode & 0o027:
                    raise ValueError('Scoped environment file must be regular and no broader than 0640')
                env = parse_env(args.env_file.read_text())
            result = paper_env(env, args.service)
            if not args.release:
                raise ValueError('Immutable release proof required for service preflight')
            result.update(verify_release(args.release, args.service))
        else:
            if args.release or args.env_file:
                raise ValueError('Service required for release/environment verification')
            result = observe(args.root)
        print(json.dumps(result, indent=2, sort_keys=True))
    except (ValueError, OSError, KeyError, TypeError):
        print(json.dumps({'ready': False, 'runtimeAcceptance': False,
                          'reason': 'Readiness blocked: reviewed inputs/permissions/paper prerequisites unavailable'}))
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
