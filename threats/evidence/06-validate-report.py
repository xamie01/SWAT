#!/usr/bin/env python3
"""Validate focused review artifacts without executing application code."""
import collections
import datetime
import hashlib
import json
import os
import re
import subprocess
from pathlib import Path

os.sched_setaffinity(0, {0})
root = Path('/home/xahmie/Documents/SWAT')
evidence = root / 'threats/evidence'
inventory = json.loads((evidence / '06-local-source-inventory.json').read_text())
report = root / 'threats/06-owasp-and-sensitive-data-review.md'
text = report.read_text()
issues = []
changed = []
missing = []
for name, entry in inventory['files'].items():
    path = root / name
    if not path.is_file() or path.is_symlink():
        missing.append(name)
        continue
    if hashlib.sha256(path.read_bytes()).hexdigest() != entry['sha256']:
        changed.append(name)
if changed or missing:
    issues.append('Indexed source integrity differs from recorded baseline')

rows = re.findall(r'^\| ((?:OWA|LEAK)-\d+) \| (High|Medium|Low|Critical) \| (Verified|Likely|Needs check)', text, re.M)
counts = dict(collections.Counter(severity for _, severity, _ in rows))
confidence = dict(collections.Counter(level for _, _, level in rows))
if len(rows) != 15 or len({row[0] for row in rows}) != 15:
    issues.append('Finding register must contain 15 unique standard-confidence rows')
if counts != {'High': 4, 'Medium': 8, 'Low': 3}:
    issues.append('Finding severity counts differ from executive snapshot')

citations = 0
pattern = re.compile(re.escape(str(root)) + r'/([^\s`|;()]+?):(\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)')
for match in pattern.finditer(text):
    name, ranges = match.groups()
    path = root / name
    if name not in inventory['files']:
        issues.append('Citation outside safe indexed source: ' + name)
        continue
    if not path.is_file():
        issues.append('Missing cited source: ' + name)
        continue
    total = len(path.read_text(errors='replace').splitlines())
    for span in ranges.split(','):
        parts = span.split('-')
        start, end = int(parts[0]), int(parts[-1])
        if not 1 <= start <= end <= total:
            issues.append('Invalid source range: ' + name + ':' + span)
    citations += 1

artifact_paths = 0
for path_text in set(re.findall(re.escape(str(root)) + r'/threats/[^\s`|;,()]+', text)):
    if not Path(path_text).exists():
        issues.append('Missing referenced artifact: ' + path_text)
    artifact_paths += 1
readme_links = 0
for link in re.findall(r'\]\(([^)]+)\)', (root / 'threats/README.md').read_text()):
    if '://' not in link and not link.startswith('#'):
        if not (root / 'threats' / link.split('#')[0]).exists():
            issues.append('Missing index link: ' + link)
        readme_links += 1

routes = json.loads((evidence / '06-route-register.json').read_text())
route_counts = collections.Counter()
for route in routes:
    source = route.get('file', route.get('path', ''))
    for component in ['apps/api', 'apps/lp', 'apps/mcp-server']:
        if component in source:
            route_counts[component] += 1

def git(*args):
    return subprocess.check_output(['git', '-C', str(root), *args], text=True).strip()

head = git('rev-parse', 'HEAD')
tracked_diff = git('diff', '--name-only', 'HEAD', '--', '.')
if head != 'd5852a0e31e8e9a517c6e7c47ed9623819c7fc71':
    issues.append('HEAD differs from assessment checkpoint')
if tracked_diff:
    issues.append('Tracked changes exist; inspect independently')

result = {
    'checkedUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'cpuAffinity': sorted(os.sched_getaffinity(0)),
    'scope': 'Focused report structure, explicit citation ranges, index links and indexed-source integrity; not exploitability or compliance verification',
    'indexedFilesChecked': len(inventory['files']),
    'changedIndexedFiles': changed,
    'missingIndexedFiles': missing,
    'findingCount': len(rows),
    'severityCounts': counts,
    'confidenceCounts': confidence,
    'explicitSourceCitationOccurrencesChecked': citations,
    'referencedArtifactsChecked': artifact_paths,
    'indexLinksChecked': readme_links,
    'literalHttpRouteEntries': len(routes),
    'routeCounts': dict(route_counts),
    'head': head,
    'trackedDiffEmpty': not tracked_diff,
    'gitStatus': git('status', '--short'),
    'applicationRequestsTestsBuildsServicesRunByValidator': False,
    'issues': issues,
}
(evidence / '06-coordinator-validation.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result, indent=2))
raise SystemExit(1 if issues else 0)
