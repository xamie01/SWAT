#!/usr/bin/env python3
"""Bounded, redacted source evidence for the post-remediation assessment."""
import datetime
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

os.sched_setaffinity(0, {0})
ROOT = Path('/home/xahmie/Documents/SWAT')
OUT = ROOT / 'threats/post-fix-8905505'
BASE = 'd5852a0e31e8e9a517c6e7c47ed9623819c7fc71'
SKIP = {'.git', 'node_modules', '.next', 'dist', 'build', '.turbo', 'target', '__pycache__', 'secrets', '.secrets', 'certs'}
EXT = {'.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.sql', '.yaml', '.yml', '.html', '.toml', '.rs', '.sh', '.py', '.service', '.md'}
PATTERNS = {
    'private-key-material': re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY'),
    'credential-bearing-url': re.compile(r'\b(?:postgres(?:ql)?|redis|https?)://[^\s/"\']+:[^\s/@"\']+@', re.I),
    'structured-token-literal': re.compile(r'\b(?:AKIA[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9]{20,}|sk_live_[A-Za-z0-9]+|eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b'),
    'credential-assignment': re.compile(r'(?:api[_-]?key|api[_-]?secret|private[_-]?key|password|passphrase|master[_-]?key|access[_-]?token)\s*[:=]\s*[\"\'][A-Za-z0-9_+/=.-]{16,}[\"\']', re.I),
}

def allowed(path):
    rel = path.relative_to(ROOT)
    return not (path.is_symlink() or any(p in SKIP for p in rel.parts) or rel.parts[0] == 'threats' or path.name.startswith('.env') or path.name == '.mcp.json' or re.search(r'(?:id_rsa|id_ed25519|keypair|private[-_]key|wallet\.json|credentials\.json|\.pem$|\.key$)', path.name, re.I) or 'lock' in path.name.lower() or path.suffix not in EXT)

def git(*args):
    return subprocess.check_output(['git', '-C', str(ROOT), *args], text=True)

def read(spec):
    bits = spec.rsplit(':', 2)
    if len(bits) != 3 or not bits[1].isdigit() or not bits[2].isdigit():
        raise ValueError('Use relative/path:start:end')
    name, start, end = bits[0], int(bits[1]), int(bits[2])
    path = (ROOT / name).resolve()
    if not allowed(path) or end < start or start < 1 or end - start > 320:
        raise ValueError('Unsafe path or oversized read')
    lines = path.read_text(errors='replace').splitlines()
    print('\nFILE ' + name)
    for i in range(start, min(end, len(lines)) + 1):
        tags = [tag for tag, pattern in PATTERNS.items() if pattern.search(lines[i-1])]
        print(str(i) + '\t' + ('[REDACTED: ' + ','.join(tags) + ']' if tags else lines[i-1]))
    with (OUT / 'read-ledger.jsonl').open('a') as handle:
        handle.write(json.dumps({'path': name, 'requestedRange': [start, end], 'visibleRange': [start, min(end, len(lines))], 'scope': 'requested source read; output truncation must be qualified by reviewer'}) + '\n')

def snapshot():
    files = {}
    for name in git('ls-files', '-z').split('\0'):
        if not name:
            continue
        path = ROOT / name
        if allowed(path) and path.is_file():
            data = path.read_bytes()
            files[name] = {'sha256': hashlib.sha256(data).hexdigest(), 'lines': len(data.splitlines()), 'bytes': len(data)}
    status = git('status', '--short')
    changes = []
    for row in git('diff', '--numstat', BASE + '...HEAD').splitlines():
        added, deleted, name = row.split('\t', 2)
        if name.startswith('threats/'):
            continue
        changes.append({'path': name, 'added': added, 'deleted': deleted, 'contentExcluded': not allowed(ROOT/name)})
    payload = {'utc': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'baseline': BASE, 'head': git('rev-parse', 'HEAD').strip(), 'cpuAffinity': sorted(os.sched_getaffinity(0)), 'gitStatus': status, 'files': files, 'changes': changes, 'credentialFilesRead': False, 'atomicSnapshot': False}
    target = OUT / 'source-snapshot.json'
    if target.exists():
        raise ValueError('Refusing to replace established snapshot')
    target.write_text(json.dumps(payload, indent=2) + '\n')
    print(json.dumps({'filesHashed': len(files), 'changeEntries': len(changes), 'head': payload['head'], 'trackedDiff': git('diff', '--stat', 'HEAD'), 'cpuAffinity': payload['cpuAffinity']}))

if __name__ == '__main__':
    if sys.argv[1] == 'snapshot':
        snapshot()
    elif sys.argv[1] == 'read':
        for spec in sys.argv[2:]:
            read(spec)
    else:
        raise ValueError('Expected snapshot or read')
