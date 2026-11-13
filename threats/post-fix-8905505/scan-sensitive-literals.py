#!/usr/bin/env python3
"""Classify potential browser/API disclosures without emitting candidate values."""
import datetime
import hashlib
import json
import os
import re
from pathlib import Path

os.sched_setaffinity(0, {0})
ROOT = Path('/home/xahmie/Documents/SWAT')
OUT = ROOT / 'threats/post-fix-8905505'
PATTERNS = {
    'private-key-material': re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY'),
    'authenticated-connection-url': re.compile(r'\b(?:postgres(?:ql)?|redis|https?)://[^\s/"\'`<>]+:[^\s/@"\'`<>]+@', re.I),
    'structured-provider-token': re.compile(r'\b(?:AKIA[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9]{20,}|sk_live_[A-Za-z0-9]{16,}|eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b'),
    'sensitive-literal-assignment': re.compile(r'(?:api[_-]?key|api[_-]?secret|private[_-]?key|password|passphrase|master[_-]?key|access[_-]?token)\s*[:=]\s*[\"\'][A-Za-z0-9_+/=.-]{16,}[\"\']', re.I),
    'credential-query-url-literal': re.compile(r'https?://[^\s"\'`<>]+[?&](?:api[-_]?key|token|secret|access_token)=[A-Za-z0-9_+/=.-]{12,}', re.I),
}
files = []
candidates = []
public_names = set()
for top in ['apps/web', 'apps/api/src', 'apps/lp/src', 'pda-test-ui']:
    for base, dirs, names in os.walk(ROOT/top):
        dirs[:] = sorted(d for d in dirs if d not in {'.git','node_modules','.next','dist','build','.turbo','certs','secrets','__pycache__'} and not (Path(base)/d).is_symlink())
        for name in sorted(names):
            path = Path(base)/name
            if path.is_symlink() or name.startswith('.env') or path.suffix not in {'.ts','.tsx','.mjs','.js','.html'} or '.test.' in name:
                continue
            files.append(('source', path))
client = ROOT/'apps/web/.next/static'
if client.is_dir():
    for path in sorted(client.rglob('*')):
        if path.is_file() and not path.is_symlink() and path.suffix in {'.js','.map','.json'}:
            files.append(('existing-client-build',path))
manifest=[]
for origin,path in files:
    if path.stat().st_size > 12_000_000:
        manifest.append({'path':str(path.relative_to(ROOT)), 'origin':origin, 'skipped':'file-size-budget'})
        continue
    data=path.read_bytes()
    text=data.decode('utf8',errors='replace')
    rel=str(path.relative_to(ROOT))
    manifest.append({'path':rel,'origin':origin,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'mtimeNs':path.stat().st_mtime_ns})
    public_names.update(re.findall(r'\bNEXT_PUBLIC_[A-Z0-9_]+',text))
    for tag,regex in PATTERNS.items():
        for hit in regex.finditer(text):
            candidates.append({'path':rel,'origin':origin,'classification':tag,'line':text.count('\n',0,hit.start())+1,'offset':hit.start(),'length':len(hit.group(0)),'value':'REDACTED; not tested for validity'})
payload={
 'checkedUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),
 'cpuAffinity':sorted(os.sched_getaffinity(0)),
 'files':manifest,'candidates':candidates,'publicEnvironmentVariableNames':sorted(public_names),
 'scope':'Bounded heuristic literal scan of current frontend/API/LP/PDA source and existing local client .next/static artifacts. Does not read server bundles, dotenv, actual secrets, logs or live responses.',
 'limits':'Existing client artifacts are not proven built from current HEAD. Heuristics cannot detect all formats, obfuscation, runtime injection, response leakage, or secret validity. Public keys/project IDs are not private credentials.',
 'noCandidateValuesEmitted':True
}
(OUT/'sensitive-literal-scan.json').write_text(json.dumps(payload,indent=2)+'\n')
print(json.dumps({'filesScanned':len(manifest),'sourceFiles':sum(f['origin']=='source' for f in manifest),'clientArtifactFiles':sum(f['origin']=='existing-client-build' for f in manifest),'totalBytes':sum(f.get('bytes',0) for f in manifest),'candidateCount':len(candidates),'candidates':candidates[:45],'publicEnvironmentVariableNames':sorted(public_names)},indent=2))
