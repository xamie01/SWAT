#!/usr/bin/env python3
"""Offline approved-tree handoff. No resolution, downloading, package install or build.

The credential-free producer must deliver complete locked tool/runtime and Vercel
Build Output trees. Approval stays pending until every file's public SHA256 and
an immutable OCI runtime image digest have been independently reviewed. Hashes
establish identity relative to that review, not provenance or runtime safety.
"""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import tempfile

LOCK = Path(__file__).with_name('package27-deploy-artifacts.lock.json')
ROOT = Path(__file__).resolve().parents[2]
INPUT = ROOT / '.package27-approved'
OUTPUT = ROOT / '.package27-deploy'
RUNTIME_IMAGE = 'python:3.11-slim'  # Must be replaced by the reviewed @sha256 digest in BOTH CI files.
PUBLISH_ENABLED = False  # Requires a separately reviewed authorization/source change.
SHA256 = re.compile(r'[0-9a-f]{64}')
IMAGE = re.compile(r'[^\s]+@sha256:[0-9a-f]{64}')


def file_map(rows):
    if not isinstance(rows, list) or not rows:
        raise ValueError('Complete nonempty file inventory required')
    expected = {}
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get('path'), str):
            raise ValueError('Inventory row/path must be an object/string')
        name = row['path']
        path = PurePosixPath(name)
        if (not name or path.is_absolute() or path.as_posix() != name or
                any(part in ('', '.', '..') for part in path.parts) or
                any(ord(char) < 32 or char == '\\' for char in name) or
                any(part == '.env' or part.startswith('.env.') or part in ('.npmrc', '.netrc', '.git') for part in path.parts) or
                name in expected or not isinstance(row.get('sha256'), str) or
                not SHA256.fullmatch(row['sha256'])):
            raise ValueError('Unsafe, duplicate or unhashed artifact path')
        if row.get('mode') not in ('0444', '0555'):
            raise ValueError('Artifact mode must be immutable/readable')
        expected[name] = row
    if any(parent.as_posix() in expected for name in expected
           for parent in PurePosixPath(name).parents if parent.as_posix() != '.'):
        raise ValueError('File/directory inventory collision')
    return expected


def digest_file(path):
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def verify_provenance(lock):
    provenance = lock.get('provenance', {})
    if (provenance.get('approval') != 'reviewed' or
            provenance.get('target') != 'paper-staging' or
            not isinstance(provenance.get('sourceCommit'), str) or
            not re.fullmatch(r'[0-9a-f]{40}', provenance['sourceCommit']) or
            not isinstance(provenance.get('buildRun'), str) or
            not re.fullmatch(r'[A-Za-z0-9._-]{1,128}', provenance['buildRun'])):
        raise ValueError('Reviewed commit-bound paper staging build provenance required')
    sources = file_map(provenance.get('sourceFiles'))
    for required in ('pnpm-lock.yaml', 'package.json', 'pnpm-workspace.yaml',
                     'apps/web/package.json', 'apps/web/next.config.ts'):
        if required not in sources:
            raise ValueError('Source/lock/tool build identity incomplete')
    for name, row in sources.items():
        path = ROOT / name
        if (any(parent.is_symlink() for parent in path.parents if parent != ROOT.parent)
                or path.is_symlink() or not path.is_file() or digest_file(path) != row['sha256']):
            raise ValueError('Build source provenance mismatch')
    if provenance.get('pnpmVersion') != '10.2.0':
        raise ValueError('Build must use the project package manager pin')
    if not isinstance(provenance.get('nodeVersion'), str) or not re.fullmatch(r'22\.\d+\.\d+', provenance['nodeVersion']):
        raise ValueError('Exact reviewed Node22 build runtime required')
    if not isinstance(provenance.get('buildEvidenceSha256'), str) or not SHA256.fullmatch(provenance['buildEvidenceSha256']):
        raise ValueError('Reviewed build evidence hash required')


def load_lock(path=LOCK):
    lock = json.loads(path.read_text())
    if lock.get('schema') != 1 or lock.get('approval') != 'reviewed':
        raise ValueError('Deployment blocked: approved tool/artifact lock unavailable')
    if not isinstance(lock.get('runtimeImage'), str) or not IMAGE.fullmatch(lock['runtimeImage']):
        raise ValueError('Reviewed runtime image digest required')
    if lock['runtimeImage'] != RUNTIME_IMAGE:
        raise ValueError('Runtime image must match source-pinned acquisition and publish image')
    for config in (ROOT / '.woodpecker.yaml', ROOT / '.woodpecker/ci.yaml'):
        deploy_steps = config.read_text().split('  - name: acquire-deploy-artifacts\n', 1)[1]
        if deploy_steps.count('    image: ' + RUNTIME_IMAGE + '\n') != 2:
            raise ValueError('Both CI deployment steps must use the approved image digest')
    verify_provenance(lock)
    tool = lock['tool']
    if tool['name'] != 'vercel' or tool['version'] != '65.11.0':
        raise ValueError('Unexpected operator tool identity')
    tool_files, artifact_files = file_map(tool['files']), file_map(lock['artifact']['files'])
    if tool['entrypoint'] != 'node_modules/vercel/dist/index.js' or tool['entrypoint'] not in tool_files or 'bin/node' not in tool_files:
        raise ValueError('Complete approved CLI and Node runtime required')
    if not all(name.startswith('.vercel/output/') for name in artifact_files) or '.vercel/output/config.json' not in artifact_files:
        raise ValueError('Only reviewed prebuilt Vercel Build Output is accepted')
    return lock, tool_files, artifact_files


def verify_tree(root, expected, immutable=True):
    if root.is_symlink() or not root.is_dir():
        raise ValueError('Artifact root must be a real directory')
    if any(parent.is_symlink() for parent in root.parents):
        raise ValueError('Symlink artifact ancestors forbidden')
    actual = set()
    for path in root.rglob('*'):
        if path.is_symlink() or not (path.is_file() or path.is_dir()):
            raise ValueError('Symlinks/special files are forbidden')
        if path.is_file():
            name = path.relative_to(root).as_posix()
            actual.add(name)
            if name not in expected or digest_file(path) != expected[name]['sha256']:
                raise ValueError('Artifact file hash/inventory mismatch')
            if immutable and stat.S_IMODE(path.stat().st_mode) != int(expected[name]['mode'], 8):
                raise ValueError('Artifact permissions differ from reviewed immutable modes')
    if actual != set(expected):
        raise ValueError('Artifact inventory incomplete')
    if immutable and any(stat.S_IMODE(path.stat().st_mode) != 0o555
                         for path in (root, *root.rglob('*')) if path.is_dir()):
        raise ValueError('Immutable artifact directories must be 0555')


def copy_tree(source, target, expected):
    verify_tree(source, expected)
    target.mkdir(parents=True, exist_ok=False)
    for name, row in expected.items():
        dest = target / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source / name, dest)
        dest.chmod(int(row['mode'], 8))
    for path in sorted(target.rglob('*'), reverse=True):
        if path.is_dir():
            path.chmod(0o555)
    target.chmod(0o555)
    verify_tree(target, expected)


def acquire():
    # env -i at the CI callsite prevents credential inheritance into acquisition.
    if any(name in os.environ for name in ('VERCEL_TOKEN', 'VERCEL_ORG_ID', 'VERCEL_PROJECT_ID')):
        raise ValueError('Acquisition must not receive deployment credentials')
    _, tool_files, artifact_files = load_lock()
    if OUTPUT.exists() or OUTPUT.is_symlink():
        raise ValueError('Refusing reused deployment handoff')
    OUTPUT.mkdir(mode=0o700)
    copy_tree(INPUT / 'tool', OUTPUT / 'tool', tool_files)
    copy_tree(INPUT / 'artifact', OUTPUT / 'artifact', artifact_files)
    OUTPUT.chmod(0o555)


def publish():
    # Approval of observed files is NOT authorization to publish.
    if not PUBLISH_ENABLED:
        raise ValueError('Publishing disabled pending separately reviewed manual authorization')
    # No shell, install, project pull or build; only the already-verified CLI runs.
    _, tool_files, artifact_files = load_lock()
    verify_tree(OUTPUT / 'tool', tool_files)
    verify_tree(OUTPUT / 'artifact', artifact_files)
    token = os.environ.get('VERCEL_TOKEN')
    org = os.environ.get('VERCEL_ORG_ID')
    project = os.environ.get('VERCEL_PROJECT_ID')
    if not token or not org or not project:
        raise ValueError('Scoped publish credentials required')
    with tempfile.TemporaryDirectory(prefix='swat-publish-') as tmp:
        work = Path(tmp)
        # Private writable metadata is separate from the immutable tool and output.
        copy_tree(OUTPUT / 'artifact', work / 'prebuilt', artifact_files)
        (work / '.vercel').mkdir(mode=0o700)
        (work / '.vercel/output').symlink_to(work / 'prebuilt/.vercel/output', target_is_directory=True)
        (work / '.vercel/project.json').write_text(json.dumps({'orgId': org, 'projectId': project}))
        home = work / 'home'
        home.mkdir(mode=0o700)
        env = {'PATH': '/usr/bin:/bin', 'HOME': str(home), 'CI': '1',
               'VERCEL_TOKEN': token, 'VERCEL_ORG_ID': org, 'VERCEL_PROJECT_ID': project,
               'VERCEL_TELEMETRY_DISABLED': '1'}
        # Vercel's CLI requires --token; CI/operator must suppress command/process logs.
        subprocess.run([str(OUTPUT / 'tool/bin/node'), str(OUTPUT / 'tool/node_modules/vercel/dist/index.js'),
                        'deploy', '--prebuilt', '--prod', '--yes', '--token', token],
                       cwd=work, env=env, check=True)


if __name__ == '__main__':
    os.umask(0o077)
    if len(sys.argv) != 2 or sys.argv[1] not in ('acquire', 'publish'):
        raise SystemExit('Usage: package27-deploy-artifacts.py acquire|publish')
    try:
        acquire() if sys.argv[1] == 'acquire' else publish()
    except (ValueError, OSError, KeyError, TypeError, subprocess.CalledProcessError):
        # Avoid printing subprocess argv, paths supplied by credentials or exception secrets.
        raise SystemExit('Deployment blocked: approved immutable inputs/prerequisites unavailable')
