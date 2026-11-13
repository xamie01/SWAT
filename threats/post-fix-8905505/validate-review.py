#!/usr/bin/env python3
"""Validate post-fix artifacts, explicit citations and source stability."""
import collections
import datetime
import hashlib
import json
import os
import re
import subprocess
from pathlib import Path

os.sched_setaffinity(0, {0})
ROOT = Path('/home/xahmie/Documents/SWAT')
OUT = ROOT/'threats/post-fix-8905505'
snapshot = json.loads((OUT/'source-snapshot.json').read_text())
issues=[]
changed=[]
for name, entry in snapshot['files'].items():
    p=ROOT/name
    if not p.is_file() or hashlib.sha256(p.read_bytes()).hexdigest()!=entry['sha256']:
        changed.append(name)
if changed:issues.append('Source snapshot changed: '+', '.join(changed))

def git(*args):
    return subprocess.check_output(['git','-C',str(ROOT),*args],text=True).strip()
head=git('rev-parse','HEAD')
if head != snapshot['head']:issues.append('HEAD changed')
tracked=git('diff','--name-only','HEAD').splitlines()
if any(not name.startswith('threats/') for name in tracked):issues.append('Tracked edits outside threats')

reports=[ROOT/'threats/07-post-remediation-review.md',OUT/'api-web-review.md',OUT/'execution-review.md',OUT/'secondary-contract-review.md',OUT/'data-indexer-review.md',OUT/'verification.md',OUT/'closure-ledger.md']
count=0
links=0
unvalidated=[]
pattern=re.compile(r'(?:/home/xahmie/Documents/SWAT/)?((?:apps|packages|programs|deploy|tests|pattern-ml|docs|scripts)/[^\s`|;():]+|(?:DEPLOYMENT\.md|vitest\.integration\.config\.ts|package\.json|\.woodpecker(?:/ci)?\.yaml)):(\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)')
for report in reports:
    text=report.read_text()
    for match in pattern.finditer(text):
        name,ranges=match.groups()
        p=ROOT/name
        if not p.is_file():issues.append('Missing citation '+name+' in '+report.name);continue
        # Credential-bearing config is counted structurally without displaying content.
        total=len(p.read_bytes().splitlines())
        for span in ranges.split(','):
            nums=span.split('-');start,end=int(nums[0]),int(nums[-1])
            if not 1<=start<=end<=total:issues.append(f'Invalid range {name}:{span} ({total}) in {report.name}')
        count+=1
    for target in re.findall(r'\]\(([^)]+)\)',text):
        if '://' in target or target.startswith('#'):continue
        p=(report.parent/target.split('#')[0]) if not target.startswith('/') else Path(target.split('#')[0])
        if not p.exists():issues.append('Missing report link '+target+' in '+report.name)
        links+=1
for target in re.findall(r'\]\(([^)]+)\)',(ROOT/'threats/README.md').read_text()):
    if '://' not in target and not target.startswith('#'):
        p=ROOT/'threats'/target
        if not p.exists():issues.append('Missing index link '+target)
        links+=1
ledger=json.loads((OUT/'closure-ledger.json').read_text())
if len(ledger['items'])!=97 or len({r['id'] for r in ledger['items']})!=97:issues.append('Closure IDs incomplete/nonunique')
counts=dict(collections.Counter(r['status'] for r in ledger['items']))
if counts!=ledger['counts']:issues.append('Closure counts mismatch')

selected=['existing-pure-regressions','existing-changed-regressions','api-invariants-offline','parser-session-invariants','sensitive-flow-invariants','jito-invariants-stateful']
tests=[]
for label in selected:
    data=json.loads((OUT/(label+'.json')).read_text())
    tests.append({'label':label,'passed':data['numPassedTests'],'failed':data['numFailedTests'],'total':data['numTotalTests']})
if sum(x['total'] for x in tests)!=193 or sum(x['failed'] for x in tests)!=16:issues.append('Test totals mismatch')

reads=[]
for line in (OUT/'read-ledger.jsonl').read_text().splitlines():
    reads.append(json.loads(line))
coverage={'recordedRequestedReadFiles':len({r['path'] for r in reads}), 'recordedRequestedRanges':len(reads), 'qualification':'Helper requested ranges only, not proof of untruncated complete reads. See partition coverage for direct reads/searches and truncation caveats.'}
scan=json.loads((OUT/'sensitive-literal-scan.json').read_text())
result={
 'checkedUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'head':head,'cpuAffinity':sorted(os.sched_getaffinity(0)),
 'sourceFilesHashed':len(snapshot['files']),'changedSourceFiles':changed,'trackedChanges':tracked,'gitStatus':git('status','--short'),
 'explicitCitationOccurrencesChecked':count,'localLinksChecked':links,'closureCounts':counts,'testRunsUsedForUniqueCounts':tests,
 'coverage':coverage,'literalScanFiles':len(scan['files']),'literalScanCandidates':len(scan['candidates']),
 'limitations':'Structural/source consistency only. Not an exploitability, production privilege, clean-current-bundle or OWASP-compliance attestation.',
 'issues':issues
}
(OUT/'final-validation.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result,indent=2))
raise SystemExit(1 if issues else 0)
