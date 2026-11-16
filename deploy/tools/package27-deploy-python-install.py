#!/usr/bin/env python3
"""Operator-invoked, unprivileged, hash-locked wheel installation; never auto-runs.

Use an already provisioned empty venv with reviewed Python/pip. No virtualenv,
bootstrap, upgrade, build, editable install or dependency resolution is performed.
The checked-in pending lock deliberately blocks until an independently reviewed
complete wheel/runtime inventory is available. Do not run during source review.
"""
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

LOCK = Path(__file__).with_name('package27-deploy-python.lock.json')
SHA256 = re.compile(r'[0-9a-f]{64}')
NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]*')
VERSION = re.compile(r'[A-Za-z0-9][A-Za-z0-9.!+_-]*')


def approved_requirements(lock, wheelhouse):
    if lock.get('schema') != 1 or lock.get('approval') != 'reviewed':
        raise ValueError('Approved complete Python lock unavailable')
    if not isinstance(lock.get('pythonVersion'), str) or not isinstance(lock.get('pipVersion'), str) or not SHA256.fullmatch(lock.get('pythonSha256', '')):
        raise ValueError('Exact Python and pip runtime required')
    runtime = lock.get('runtime', {})
    if (not re.fullmatch(r'[^\s]+@sha256:[0-9a-f]{64}', runtime.get('image', '')) or
            not all(isinstance(runtime.get(key), str) and runtime[key]
                    for key in ('abi', 'platform')) or not runtime.get('nativeFiles')):
        raise ValueError('Approved immutable ABI/platform/native runtime inventory required')
    for row in runtime['nativeFiles']:
        path = Path(row['path'])
        if (not path.is_absolute() or '..' in path.parts or path.is_symlink() or
                any(parent.is_symlink() for parent in path.parents) or
                not path.is_file() or not SHA256.fullmatch(row.get('sha256', '')) or
                hashlib.sha256(path.read_bytes()).hexdigest() != row['sha256']):
            raise ValueError('Native runtime inventory/hash mismatch')
    if wheelhouse.is_symlink() or any(parent.is_symlink() for parent in wheelhouse.parents) or not wheelhouse.is_dir() or not lock.get('wheels') or not lock.get('pipFiles'):
        raise ValueError('Complete reviewed wheels and pip inventory required')
    requirements, files, names = [], set(), set()
    for row in lock['wheels']:
        name, version, filename, digest = row['name'], row['version'], row['file'], row['sha256']
        canonical = re.sub(r'[-_.]+', '-', name).lower()
        if (not NAME.fullmatch(name) or not VERSION.fullmatch(version) or canonical in names or
                Path(filename).name != filename or not filename.endswith('.whl') or
                filename in files or not SHA256.fullmatch(digest)):
            raise ValueError('Invalid or duplicate locked wheel')
        path = wheelhouse / filename
        if path.is_symlink() or not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise ValueError('Wheel inventory/hash mismatch')
        names.add(canonical)
        files.add(filename)
        requirements.append(f'{name}=={version} --hash=sha256:{digest}')
    if {path.name for path in wheelhouse.iterdir()} != files or 'pattern-ml' not in names:
        raise ValueError('Require only inventoried wheels including the application wheel')
    return '\n'.join(requirements) + '\n'


def install(wheelhouse):
    if os.geteuid() == 0 or sys.prefix == sys.base_prefix:
        raise ValueError('Only an already provisioned unprivileged venv is supported')
    lock = json.loads(LOCK.read_text())
    requirements = approved_requirements(lock, wheelhouse)
    if ('.'.join(map(str, sys.version_info[:3])) != lock['pythonVersion'] or
            hashlib.sha256(Path(sys.executable).resolve().read_bytes()).hexdigest() != lock['pythonSha256']):
        raise ValueError('Reviewed Python runtime mismatch')
    pip = importlib.metadata.distribution('pip')
    if pip.version != lock['pipVersion']:
        raise ValueError('Reviewed pip version mismatch')
    expected = {row['path']: row['sha256'] for row in lock['pipFiles']}
    actual = {str(path) for path in pip.files or ()}
    if set(expected) != actual or any(not SHA256.fullmatch(digest) or hashlib.sha256(Path(pip.locate_file(name)).read_bytes()).hexdigest() != digest for name, digest in expected.items()):
        raise ValueError('Reviewed complete pip inventory mismatch')
    # Reject inherited application distributions: no silent reuse of old dependencies.
    if any(dist.metadata['Name'].lower() not in ('pip', 'setuptools', 'wheel') for dist in importlib.metadata.distributions()):
        raise ValueError('Use a clean preprovisioned venv')
    with tempfile.TemporaryDirectory(prefix='swat-python-install-') as tmp:
        requirement_path = Path(tmp) / 'requirements.txt'
        requirement_path.write_text(requirements)
        # Isolated env + pip config isolate acquisition from ambient credentials/indexes.
        env = {'PATH': '/usr/bin:/bin', 'HOME': tmp, 'PIP_CONFIG_FILE': os.devnull,
               'PYTHONNOUSERSITE': '1', 'PIP_DISABLE_PIP_VERSION_CHECK': '1'}
        subprocess.run([sys.executable, '-I', '-m', 'pip', 'install', '--isolated', '--no-index',
                        '--no-cache-dir', '--no-deps', '--require-hashes', '--only-binary=:all:',
                        '--find-links', str(wheelhouse), '-r', str(requirement_path)], env=env, check=True)
        subprocess.run([sys.executable, '-I', '-m', 'pip', 'check', '--isolated'], env=env, check=True)


if __name__ == '__main__':
    os.umask(0o077)
    if len(sys.argv) != 2:
        raise SystemExit('Usage: approved-venv/bin/python -I package27-deploy-python-install.py ABSOLUTE-WHEELHOUSE')
    path = Path(sys.argv[1])
    if not path.is_absolute():
        raise SystemExit('Wheelhouse must be an absolute reviewed artifact path')
    try:
        install(path)
    except (ValueError, OSError, KeyError, TypeError, subprocess.CalledProcessError):
        raise SystemExit('Python setup blocked: approved offline wheel/runtime inventory required')
