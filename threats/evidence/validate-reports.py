#!/usr/bin/env python3
"""Validate report structure and update bounded source-coverage evidence offline."""
import collections
import hashlib
import json
import re
from pathlib import Path

ROOT = Path('/home/xahmie/Documents/SWAT')
OUT = ROOT / 'threats'
EVIDENCE = OUT / 'evidence'
EXPECTED = [
    '01-api', '02-database', '03-crypto-authority', '04-on-chain-programs',
    '05-indexer-parsers', '06-signals-scorer', '07-trade-executor',
    '08-secondary-services', '09-agent-mcp', '10-web-app',
    '11-infrastructure-supply-chain', '12-test-assurance',
]
INV = EVIDENCE / 'source-inventory.json'
inventory = json.loads(INV.read_text())
findings = []
checks = []
references = []
coverage = {}
for report in sorted((OUT / 'security-review').glob('*.md')):
    text = report.read_text()
    has_sections = all(re.search(r'^## ' + label + r'\.', text, re.M) for label in 'ABCD')
    rows = []
    for line_number, line in enumerate(text.splitlines(), 1):
        if not re.match(r'^\|\s*(?:\*\*)?[A-Z]+-\d+', line):
            continue
        cells = [x.strip().replace('**', '') for x in line.split('|')[1:-1]]
        rows.append({'report': report.stem, 'line': line_number, 'cells': cells})
        if len(cells) == 6:
            findings.append({'report': report.stem, 'line': line_number,
                             'id': cells[0], 'severity': cells[1],
                             'confidence': cells[2], 'evidence': cells[3]})
    bad_rows = [r for r in rows if len(r['cells']) != 6
                or r['cells'][1] not in ('Critical', 'High', 'Medium', 'Low')
                or r['cells'][2] not in ('Verified', 'Likely', 'Needs check')]
    checks.append({'report': report.stem, 'ABCD_sections': has_sections,
                   'finding_rows': len(rows), 'bad_rows': bad_rows})
    manifests = []
    for payload in re.findall(r'```json\s*\n(.*?)\n```', text, re.S):
        try:
            value = json.loads(payload)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict) and ('deep' in value or 'skim' in value):
            manifests.append(value)
    if manifests:
        coverage[report.stem] = manifests[-1]
        (EVIDENCE / (report.stem + '-coverage.json')).write_text(json.dumps(manifests[-1], indent=2) + '\n')
    else:
        previous = EVIDENCE / (report.stem + '-coverage.json')
        if previous.exists():
            coverage[report.stem] = json.loads(previous.read_text())
    pattern = r'(?P<path>(?:/home/xahmie/Documents/SWAT/)?(?:apps|packages|programs|tests|scripts|deploy|docs|pattern-ml|pda-test-ui)/[A-Za-z0-9_./-]+\.[A-Za-z0-9_-]+|(?:\.woodpecker(?:/ci)?\.ya?ml|docker-compose\.yml|README\.md|DEPLOYMENT\.md|package\.json|turbo\.json|pnpm-workspace\.yaml|\.env\.example|vitest\.integration\.config\.ts)):(?P<ranges>\d+(?:[-–]\d+)?(?:,\d+(?:[-–]\d+)?)*)'
    for match in re.finditer(pattern, text):
        raw = match.group('path')
        path = Path(raw) if raw.startswith('/') else ROOT / raw
        row = {'report': report.stem, 'path': str(path.relative_to(ROOT)), 'ranges': match.group('ranges')}
        if not path.is_file():
            row['issue'] = 'missing source path'
        else:
            count = len(path.read_bytes().splitlines())
            spans = [tuple(map(int, re.split('[-–]', s))) for s in match.group('ranges').split(',')]
            if any(x[0] < 1 or max(x) > count or (len(x) == 2 and x[0] > x[1]) for x in spans):
                row['issue'] = 'range outside source line count'
                row['source_lines'] = count
        references.append(row)

for files in inventory['modules'].values():
    for entry in files:
        entry['status'] = 'not-reviewed'
        entry.pop('evidence_reports', None)
        for report, manifest in coverage.items():
            for category, status in (('deep', 'in-depth-relevant-path'), ('skim', 'skim')):
                paths = manifest.get(category, [])
                normalized = []
                for value in paths:
                    raw = value['path'] if isinstance(value, dict) else value
                    if raw.startswith(str(ROOT) + '/'):
                        raw = raw[len(str(ROOT)) + 1:]
                    normalized.append(raw)
                if entry['path'] in normalized:
                    if status == 'in-depth-relevant-path' or entry['status'] == 'not-reviewed':
                        entry['status'] = status
                    entry.setdefault('evidence_reports', [])
                    if report not in entry['evidence_reports']:
                        entry['evidence_reports'].append(report)
INV.write_text(json.dumps(inventory, indent=2) + '\n')

ledger = ['# Coverage ledger', '',
          '`done` means the bounded module review and report are complete, not that every file was audited. `In-depth relevant path` includes selected regions whose effect and callers were traced; exact full/partial ranges and search-only reads are in module appendices. LOC counts are inventory sizes, not audited LOC.', '',
          '| Module | Files | LOC | In-depth relevant path | Skim/search | Not reviewed | Status |',
          '|---|---:|---:|---:|---:|---:|---|']
totals = collections.Counter()
for name in EXPECTED:
    files = inventory['modules'][name]
    counts = collections.Counter(x['status'] for x in files)
    totals.update(counts)
    status = 'done' if (OUT / 'security-review' / (name + '.md')).exists() else 'in-progress'
    ledger.append(f'| [{name}](security-review/{name}.md) | {len(files)} | {sum(x["loc"] for x in files)} | {counts["in-depth-relevant-path"]} | {counts["skim"]} | {counts["not-reviewed"]} | {status} |')
ledger += [f'| **Total** | **{sum(len(v) for v in inventory["modules"].values())}** | **{sum(x["loc"] for v in inventory["modules"].values() for x in v)}** | **{totals["in-depth-relevant-path"]}** | **{totals["skim"]}** | **{totals["not-reviewed"]}** | **bounded review complete** |', '', '## Coverage and exclusions', '',
           '- The concrete per-file statuses and evidence-report ownership are in [source-inventory.json](evidence/source-inventory.json). Unlisted sections of partial files remain unreviewed.',
           '- Both local programs, standalone PDA UI, Python secondary service and cross-cutting test assurance were included. No Solidity source was discovered; this is not an audit of external EVM contracts.',
           '- No tests/builds/services were run. No live system/public RPC/venue/advisory requests or current real `.env`/credential reads. Mainnet deployment, balances, firewall, key distribution, dependency internals and external audits are NOT VERIFIED.',
           '- Historical coverage is bounded to all locally reachable commits; binary payloads, unreachable/reflog-only objects, external submodules/LFS payloads and encoded/obfuscated secrets are excluded as recorded in module 11.',
           '- Static Critical/High revalidation and neighboring caller compatibility appear in each report; local test descriptions are not passing tests.',
           '- Source-integrity, table/reference checks, and final severity inventory are recorded in [artifact-validation.json](evidence/artifact-validation.json).', '']
(OUT / 'coverage-ledger.md').write_text('\n'.join(ledger))

baseline = json.loads((EVIDENCE / 'source-hashes-before.json').read_text())
changes = []
for relative, expected_hash in baseline.items():
    path = ROOT / relative
    actual = hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None
    if actual != expected_hash:
        changes.append({'path': relative, 'expected': expected_hash, 'actual': actual})
validation = {'expected_reports': EXPECTED,
              'missing_reports': [n for n in EXPECTED if not (OUT / 'security-review' / (n + '.md')).exists()],
              'structure': checks, 'findings': findings,
              'severity_counts_raw': dict(collections.Counter(f['severity'] for f in findings)),
              'confidence_counts_raw': dict(collections.Counter(f['confidence'] for f in findings)),
              'source_reference_occurrences_checked': len(references),
              'reference_issues': [r for r in references if 'issue' in r],
              'inventory_files': sum(len(v) for v in inventory['modules'].values()),
              'inventory_loc': sum(x['loc'] for v in inventory['modules'].values() for x in v),
              'coverage_status_counts': dict(totals),
              'baseline_files_checked': len(baseline), 'source_hash_changes': changes,
              'tests_run': False, 'network_calls': False}
consolidation = {'EXE-01': ['CRY-01'], 'EXE-02': ['SIG-01'],
                 'API-03': ['CRY-06'], 'API-06': ['CRY-07'],
                 'INF-04': ['WEB-04'], 'EXE-06': ['EXE-09']}
folded = {value: key for key, values in consolidation.items() for value in values}
deduplicated = [dict(f, folded_observations=consolidation.get(f['id'], []))
                for f in findings if f['id'] not in folded]
register = {'scope': 'Static bounded observations; no exploit/test/deployment claim. Previous five lenses are not counted again.',
            'raw_count': len(findings), 'raw_severity_counts': validation['severity_counts_raw'],
            'deduplicated_count': len(deduplicated),
            'deduplicated_severity_counts': dict(collections.Counter(f['severity'] for f in deduplicated)),
            'deduplicated_confidence_counts': dict(collections.Counter(f['confidence'] for f in deduplicated)),
            'folded_into': folded, 'findings': deduplicated}
(EVIDENCE / 'finding-register.json').write_text(json.dumps(register, indent=2) + '\n')
root_issues = []
broken_links = []
root_reference_count = 0
for report in OUT.glob('*.md'):
    text = report.read_text()
    for match in re.finditer(pattern, text):
        root_reference_count += 1
        raw = match.group('path')
        path = Path(raw) if raw.startswith('/') else ROOT / raw
        count = len(path.read_bytes().splitlines()) if path.is_file() else 0
        if not count or any(max(map(int, re.split('[-–]', span))) > count
                            for span in match.group('ranges').split(',')):
            root_issues.append({'report': report.name, 'path': raw,
                                'ranges': match.group('ranges'), 'source_lines': count})
    for match in re.finditer(r'\]\(([^)]+)\)', text):
        if '://' not in match[1] and not (report.parent / match[1]).exists():
            broken_links.append({'report': report.name, 'missing_link': match[1]})
import subprocess
validation.update(root_source_reference_occurrences_checked=root_reference_count,
                  root_reference_issues=root_issues, broken_root_links=broken_links,
                  deduplicated_finding_count=len(deduplicated),
                  deduplicated_severity_counts=register['deduplicated_severity_counts'],
                  deduplicated_confidence_counts=register['deduplicated_confidence_counts'],
                  git_head=subprocess.check_output(['git', '-C', str(ROOT), 'rev-parse', 'HEAD'], text=True).strip(),
                  tracked_git_diff=subprocess.check_output(['git', '-C', str(ROOT), 'diff', '--stat'], text=True).strip(),
                  git_status=subprocess.check_output(['git', '-C', str(ROOT), 'status', '--short'], text=True).splitlines())
(EVIDENCE / 'artifact-validation.json').write_text(json.dumps(validation, indent=2) + '\n')
print(json.dumps({k: v for k, v in validation.items() if k not in ('findings', 'structure', 'expected_reports')}, indent=2))
print('bad_tables', json.dumps([c for c in checks if c['bad_rows'] or not c['ABCD_sections']], indent=2))
