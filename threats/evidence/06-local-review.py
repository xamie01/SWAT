#!/usr/bin/env python3
"""Resource-light local read/scan helper; never prints suspected credential literals."""
import datetime, hashlib, json, os, re, sys
from pathlib import Path
ROOT = Path('/home/xahmie/Documents/SWAT')
EVIDENCE = ROOT / 'threats/evidence/06-local-source-inventory.json'
SKIP_DIRS = {'.git', 'node_modules', '.next', 'dist', 'build', '.turbo', 'target', '__pycache__', 'secrets', '.secrets', 'wallets-private'}
SUFFIXES = {'.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.sql', '.yaml', '.yml', '.html', '.toml'}
KEYWORD = re.compile(r'(secret|password|passwd|private.?key|api.?key|access.?token|refresh.?token|mnemonic|seed.?phrase|credential|database_url|redis_url|signature|sealed_secret)', re.I)
PATTERNS = {
 'private-key-material': re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY'),
 'credential-bearing-url': re.compile(r'\b(?:postgres(?:ql)?|redis|https?)://[^\s/"\']+:[^\s/@"\']+@', re.I),
 'structured-token-literal': re.compile(r'\b(?:AKIA[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9]{20,}|sk_live_[A-Za-z0-9]+|eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b'),
}
QUOTES = re.compile(r'''(["'])([^"'\n]{4,})\1''')
def denied(p):
 return p.name.startswith('.env') or any(d in SKIP_DIRS for d in p.parts) or bool(re.search(r'(?:id_rsa|id_ed25519|keypair(?:\.json)?|private[-_]key(?:\.json)?|wallet\.json|credentials\.json)$', p.name, re.I)) or p.is_symlink()
def classes(line):
 out = [name for name, pat in PATTERNS.items() if pat.search(line)]
 if KEYWORD.search(line) and ('=' in line or ':' in line):
  for _, value in QUOTES.findall(line):
   if len(value) >= 20 and re.fullmatch(r'[A-Za-z0-9_+/=.-]+', value) and value not in {'polymarket-clob-credentials','polymarket-clob-auth'} and not re.fullmatch(r'[a-z]+(?:[_.-][a-z]+)+',value):
    out.append('suspected-sensitive-literal'); break
 return sorted(set(out))
def load():
 return json.loads(EVIDENCE.read_text()) if EVIDENCE.exists() else {'root':str(ROOT),'startedUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'files':{},'exclusions':sorted(SKIP_DIRS)+['.env/.env.*','private key/wallet/credential data files','symlinks','minified vendor bundles deep-read excluded','runtime artifacts and actual responses excluded'],'testsRun':False,'networkCalls':False}
def save(obj):
 EVIDENCE.write_text(json.dumps(obj,indent=2)+'\n')
def scan():
 obj=load()
 for top in ['apps','packages','pda-test-ui']:
  for base,ds,fs in os.walk(ROOT/top):
   ds[:]=sorted(d for d in ds if d not in SKIP_DIRS and not (Path(base)/d).is_symlink())
   for name in sorted(fs):
    p=Path(base)/name
    if denied(p) or p.suffix not in SUFFIXES or name.endswith(('lock.json','.min.js')):continue
    text=p.read_text(errors='replace'); rel=str(p.relative_to(ROOT)); lines=text.splitlines()
    entry=obj['files'].setdefault(rel,{})
    entry.update({'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'lines':len(lines),'searched':True,'testSource':'.test.' in name,'readRanges':entry.get('readRanges',[])})
    for no,line in enumerate(lines,1):
     tags=classes(line)
     if tags: print(rel+':'+str(no)+' '+'|'.join(tags)+' names='+','.join(sorted(set(m.group(0) for m in KEYWORD.finditer(line)))))
 save(obj)
def read(specs):
 obj=load()
 for spec in specs:
  bits=spec.rsplit(':',2)
  if len(bits)==3 and bits[1].isdigit() and bits[2].isdigit(): name,start,end=bits[0],int(bits[1]),int(bits[2])
  else:name,start,end=spec,1,10**9
  p=ROOT/name
  if denied(p):raise ValueError('Denied path')
  if not p.exists():print('MISSING '+name);continue
  lines=p.read_text(errors='replace').splitlines();end=min(end,len(lines))
  entry=obj['files'].setdefault(name,{'lines':len(lines),'searched':False,'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'readRanges':[]})
  entry.setdefault('readRanges',[]).append([start,end]);print('\nFILE '+str(p))
  for no in range(start,end+1):
   line=lines[no-1];tags=classes(line)
   print(str(no)+'\t'+('[REDACTED SOURCE LINE; '+','.join(tags)+'; names='+','.join(sorted(set(m.group(0) for m in KEYWORD.finditer(line))))+']' if tags else line))
 save(obj)
if __name__=='__main__':
 if sys.argv[1]=='scan':scan()
 elif sys.argv[1]=='read':read(sys.argv[2:])
 elif sys.argv[1]=='search':
  pat=re.compile(sys.argv[2],re.I);obj=load()
  for name,entry in obj['files'].items():
   if len(sys.argv)>3 and not any(name.startswith(t) for t in sys.argv[3:]):continue
   p=ROOT/name
   for no,line in enumerate(p.read_text(errors='replace').splitlines(),1):
    if pat.search(line):print(name+':'+str(no)+' classifications='+','.join(sorted(set(m.group(0) for m in pat.finditer(line)))))
