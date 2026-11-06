#!/usr/bin/env python3
"""Offline reachable-history scan; never prints source lines or credential values."""
import bisect
import collections
import hashlib
import json
import math
import re
import subprocess
from pathlib import Path

ROOT = Path('/home/xahmie/Documents/SWAT')
OUTPUT = ROOT / 'threats/evidence/history-scan-summary.json'

def git(*args):
    return subprocess.check_output(['git', '-C', str(ROOT), *args])

def real_env(path):
    base = path.rsplit('/', 1)[-1].lower()
    return (base == '.env' or base.startswith('.env.')) and not any(x in base for x in ('example', 'sample', 'template'))

commits = git('rev-list', '--all').decode().splitlines()
blobs = {}
paths_seen = set()
for commit in commits:
    for entry in git('ls-tree', '-rz', '--full-tree', commit).split(b'\0'):
        if not entry:
            continue
        meta, raw_path = entry.split(b'\t', 1)
        mode, kind, oid = meta.decode().split()
        if kind != 'blob':
            continue
        path = raw_path.decode('utf-8', 'replace')
        paths_seen.add(path)
        item = blobs.setdefault(oid, {'commit': commit, 'path': path, 'paths': set()})
        item['paths'].add(path)
        if real_env(item['path']) and not real_env(path):
            item.update(commit=commit, path=path)

rules = [
    ('private-key-pem', re.compile(r'-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----')),
    ('private-key-marker', re.compile(r'-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----')),
    ('github-token', re.compile(r'\b(?:gh[pousr]_[A-Za-z0-9]{30,255}|github_pat_[A-Za-z0-9_]{40,255})\b')),
    ('slack-token', re.compile(r'\bxox[baprs]-[A-Za-z0-9-]{15,200}\b')),
    ('aws-access-key-id', re.compile(r'\b(?:AKIA|ASIA)[A-Z0-9]{16}\b')),
    ('google-api-key', re.compile(r'\bAIza[A-Za-z0-9_-]{35}\b')),
    ('stripe-secret-key', re.compile(r'\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,200}\b')),
    ('npm-token', re.compile(r'\bnpm_[A-Za-z0-9]{30,200}\b')),
    ('sendgrid-token', re.compile(r'\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{20,}\b')),
    ('jwt-token', re.compile(r'\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}\b')),
    ('credential-url', re.compile(r'\b(?:postgres(?:ql)?|mysql|redis|amqps?|mongodb(?:\+srv)?)://[^\s/:@\"\']+:(?P<value>[^\s/@\"\']+)@')),
    ('credential-assignment', re.compile(r'''(?im)(?<![A-Za-z0-9_])(?:["']?)(?:[A-Za-z0-9_]{0,80}?(?:private[_-]?key|secret[_-]?key|api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|client[_-]?secret|aws[_-]?secret[_-]?access[_-]?key|signer[_-]?key|wallet[_-]?key|mnemonic|seed[_-]?phrase|bearer[_-]?token|vercel[_-]?token|supabase[_-]?service[_-]?role[_-]?key))["']?\s*[:=]\s*(?:(?:["'](?P<quoted>[^"'\r\n]{4,2048})["'])|(?P<unquoted>[^\s,;#\r\n]{4,2048}))''')),
    ('ethereum-private-key-assignment', re.compile(r'''(?im)(?:private[_-]?key|signer[_-]?key)\s*["']?\s*[:=]\s*["']?(?P<value>(?:0x)?[a-fA-F0-9]{64})\b''')),
    ('solana-secret-array', re.compile(r'''(?im)(?:private[_-]?key|secret[_-]?key)\s*["']?\s*[:=]\s*(?P<value>\[\s*\d{1,3}(?:\s*,\s*\d{1,3}){31,63}\s*\])''')),
    ('secret-query-parameter', re.compile(r'''(?i)[?&](?:api[_-]?key|token|secret|access[_-]?token)=(?P<value>[A-Za-z0-9_.-]{16,256})''')),
    ('authorization-bearer', re.compile(r'''(?i)\bBearer\s+(?P<value>[A-Za-z0-9_.-]{20,2048})''')),
]
placeholder = re.compile(r'(?i)(placeholder|example|your[-_ ]|replace[-_ ]|changeme|change-me|dummy|test[-_]|mock|fixture|swat-ci|localhost|^swat$|^postgres$|^password$|^admin$|^secret$|^token$|^key$|^undefined$|^null$|^true$|^false$|from_secret|process\.env|os\.getenv|os\.environ|env\(|\$\{|\$[A-Za-z_]|^<|^\*|\.{3}|^0x[01]{64}$|^[01]{64}$)')
code_value = re.compile(r'(?i)^(?:string|boolean|number|Buffer\.|z\.|require\(|config\.|this\.|request\.|req\.|opts\.|options\.|settings\.|get[A-Z]|load[A-Z]|generate[A-Z]|undefined|readonly|async|new |[A-Za-z_][A-Za-z0-9_]*\()')
counts = collections.Counter()
findings = []
binary = []
lfs = []
env_skips = []
bytes_scanned = 0
text_scanned = 0
proc = subprocess.Popen(['git', '-C', str(ROOT), 'cat-file', '--batch'], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
for oid, item in blobs.items():
    if all(real_env(p) for p in item['paths']):
        env_skips.append({'commit': item['commit'], 'blob': oid, 'path': item['path']})
        continue
    proc.stdin.write((oid + '\n').encode())
    proc.stdin.flush()
    header = proc.stdout.readline().decode().split()
    size = int(header[2])
    data = proc.stdout.read(size)
    if len(data) != size or proc.stdout.read(1) != b'\n':
        raise RuntimeError('cat-file framing error')
    bytes_scanned += size
    if data.startswith(b'version https://git-lfs.github.com/spec/v1'):
        lfs.append({'commit': item['commit'], 'blob': oid, 'path': item['path']})
    dump_text = item['path'].endswith('.txt') and 'dump' in item['path'].lower()
    if b'\0' in data and not dump_text:
        binary.append({'commit': item['commit'], 'blob': oid, 'path': item['path'], 'bytes': size})
        continue
    try:
        text = data.decode('utf-8')
    except UnicodeDecodeError:
        if dump_text:
            text = data.decode('utf-8', 'replace')
            counts['mixed-binary-source-dump:text-recovered-with-replacement'] += 1
        else:
            binary.append({'commit': item['commit'], 'blob': oid, 'path': item['path'], 'bytes': size})
            continue
    text_scanned += 1
    newline_offsets = [m.start() for m in re.finditer('\n', text)]
    seen = set()
    pem_ranges = []
    for kind, rule in rules:
        for match in rule.finditer(text):
            if kind == 'private-key-marker' and any(a <= match.start() < b for a,b in pem_ranges):
                continue
            if kind == 'private-key-pem':
                pem_ranges.append(match.span())
            groups = match.groupdict()
            value = groups.get('value') or groups.get('quoted') or groups.get('unquoted') or match.group()
            line = bisect.bisect_left(newline_offsets, match.start()) + 1
            category = 'candidate'
            if placeholder.search(value):
                category = 'placeholder-or-reference'
            elif kind == 'credential-assignment' and code_value.search(value):
                category = 'identifier-or-low-signal'
            elif kind == 'credential-assignment' and re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{3,}', value):
                frequencies = collections.Counter(value)
                entropy = -sum((n / len(value)) * math.log2(n / len(value)) for n in frequencies.values())
                category = 'high-entropy-needs-check' if len(value) >= 24 and entropy >= 3.5 and any(c.isdigit() for c in value) else 'identifier-or-low-signal'
            elif any(x in item['path'].lower() for x in ('.test.', '/test/', '/tests/', 'fixture', 'example', 'acceptance')):
                category = 'fixture-or-example-needs-check'
            key = (line, kind, hashlib.sha256(value.encode()).hexdigest()[:16])
            if key in seen:
                continue
            seen.add(key)
            counts[kind + ':' + category] += 1
            findings.append({'commit': item['commit'], 'blob': oid, 'path': item['path'], 'line': line, 'type': kind + ':' + category, 'redacted_fingerprint': 'sha256:' + key[2]})
proc.stdin.close()
proc.wait()
if proc.returncode:
    raise RuntimeError('cat-file exited unsuccessfully')
summary = {
    'scope': 'all commits reachable from all local refs via git rev-list --all; every unique reachable blob enumerated via ls-tree; safe text inspected offline via cat-file --batch',
    'head': git('rev-parse', 'HEAD').decode().strip(),
    'commits': len(commits), 'unique_blobs': len(blobs), 'unique_paths': len(paths_seen),
    'text_blobs_scanned': text_scanned, 'bytes_read': bytes_scanned,
    'binary_or_non_utf8_blobs_not_text_scanned': binary,
    'git_lfs_pointer_blobs_payload_not_available': lfs,
    'real_env_blobs_not_read_by_authorization': env_skips,
    'patterns': [kind for kind, _ in rules], 'match_counts': dict(sorted(counts.items())),
    'findings': findings,
    'dump_like_paths': sorted(p for p in paths_seen if re.search(r'(?i)(dump|backup|\.bak$|\.sql$|\.sqlite[0-9]*$|\.db$|\.gz$|\.zip$|\.tar(?:\.|$))', p)),
    'limitations': ['Unreachable/dangling/reflog-only objects excluded; no raw .git recursion.', 'No remote refs fetched, no external submodule contents or LFS payload retrieval.', 'Binary/non-UTF8 contents not decoded or decompressed.', 'Real .env blobs excluded even in history; only metadata collected.', 'Pattern-based scan is not exhaustive; split/encoded/obfuscated secrets and proprietary formats may be missed.', 'Candidate records need offline context validation; placeholders and test fixtures are not established live credentials.', 'No token validity, revocation, remote secret policy or deployment settings checked.'],
}
OUTPUT.parent.mkdir(parents=True, exist_ok=True)
OUTPUT.write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps({k: summary[k] for k in ('commits','unique_blobs','unique_paths','text_blobs_scanned','bytes_read','match_counts')}, indent=2))
print('binary_skips', len(binary), 'lfs_pointers', len(lfs), 'real_env_skips', len(env_skips), 'findings', len(findings))
