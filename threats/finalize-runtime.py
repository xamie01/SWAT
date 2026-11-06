import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
from datetime import datetime, timezone

ROOT = Path('/home/xahmie/Documents/SWAT')
OUT = ROOT / 'threats/runtime'
os.sched_setaffinity(0, {0})


def now():
    return datetime.now(timezone.utc).isoformat()


def command(args):
    result = subprocess.run(args, cwd=ROOT, capture_output=True, text=True, timeout=60)
    if result.returncode:
        raise RuntimeError(f'{args[0]} failed ({result.returncode}): {result.stderr}')
    return result.stdout


def containers():
    names = [x['name'] for x in json.loads((OUT / 'runtime-summary.json').read_text())['containers']]
    entries = json.loads(command(['docker', 'inspect', *names]))
    return [{
        'name': c['Name'].lstrip('/'), 'id': c['Id'], 'image': c['Config']['Image'],
        'running': c['State']['Running'], 'status': c['State']['Status'],
        'exit_code': c['State']['ExitCode'], 'oom_killed': c['State']['OOMKilled'],
        'limits': {key: c['HostConfig'].get(key) for key in
                   ['CpusetCpus', 'NanoCpus', 'Memory', 'MemorySwap', 'PidsLimit']},
        'port_bindings': c['HostConfig']['PortBindings'],
        'mounts': [{key: m.get(key) for key in ['Type', 'Name', 'Source', 'Destination']} for m in c['Mounts']]
    } for c in entries]


before = containers()
review_names = ['swat-review-postgres', 'swat-review-redis']
for name, logfile in [('swat-review-postgres', 'create-postgres.log'),
                      ('swat-review-redis', 'create-redis.log')]:
    expected = (OUT / logfile).read_text().strip()
    actual = next(c for c in before if c['name'] == name)
    if actual['id'] != expected or actual['limits']['CpusetCpus'] != '0':
        raise RuntimeError(f'{name} no longer matches the review-created container')

if next(c for c in before if c['name'] == 'swat-review-postgres')['running']:
    snapshot = command(['docker', 'exec', 'swat-review-postgres', 'psql', '-U', 'swat',
                        '-d', 'swat_runtime_integration', '-At', '-c',
                        "BEGIN READ ONLY; SELECT json_build_object('wallets',(SELECT count(*) FROM wallets),'signals',(SELECT count(*) FROM signals),'trades',(SELECT count(*) FROM trades),'paper_trades',(SELECT count(*) FROM trades WHERE execution_mode='paper')); COMMIT;"])
    (OUT / 'final-review-database-snapshot.log').write_text(snapshot)
else:
    snapshot = (OUT / 'final-review-database-snapshot.log').read_text()

if all(not c['running'] for c in before if c['name'] in review_names) and (OUT / 'cleanup.json').exists():
    cleanup = json.loads((OUT / 'cleanup.json').read_text())
    if cleanup['after'] != before:
        raise RuntimeError('Container state changed after recorded cleanup')
else:
    cleanup = {'timestamp_utc': now(), 'cpu_affinity': sorted(os.sched_getaffinity(0)),
               'before': before, 'actions': []}
    for name in review_names:
        result = command(['docker', 'stop', '--time', '20', name])
        cleanup['actions'].append({'name': name, 'action': 'stop', 'output': result.strip(), 'timestamp_utc': now()})
    cleanup['after'] = containers()
    cleanup['removed_containers_or_volumes'] = False
    cleanup['existing_containers_unchanged'] = all(
        a == next(b for b in cleanup['after'] if b['name'] == a['name'])
        for a in before if a['name'] not in review_names
    )
    if any(c['running'] for c in cleanup['after'] if c['name'] in review_names):
        raise RuntimeError('A review container remains running')
    (OUT / 'cleanup.json').write_text(json.dumps(cleanup, indent=2) + '\n')

baseline = json.loads((ROOT / 'threats/evidence/source-hashes-before.json').read_text())
changes = []
for path, expected in baseline.items():
    f = ROOT / path
    actual = hashlib.sha256(f.read_bytes()).hexdigest() if f.is_file() else None
    if actual != expected:
        changes.append({'path': path, 'expected': expected, 'actual': actual})

reports = ['README.md', '00-repository-map.md', 'coverage-ledger.md', '01-previous-findings.md',
           '02-synthesis-and-remediation.md', '03-latency-and-ordering.md', '04-runtime-verification.md',
           'evidence/validation-notes.md']
issues = []
abbreviated_citations = []
citations = 0
links = 0
for relative in reports:
    f = ROOT / 'threats' / relative
    text = f.read_text()
    for target in re.findall(r'\]\(([^)]+)\)', text):
        if '://' in target or target.startswith('#'):
            continue
        links += 1
        path = target.split('#')[0]
        if not (f.parent / path).exists():
            issues.append({'report': relative, 'missing_link': target})
    for path, spans in re.findall(r'([A-Za-z0-9_./-]+\.(?:tsx?|sql|json|ya?ml|mjs|md|py|toml|rs)):(\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)', text):
        source = ROOT / path
        if not source.is_file() and not path.startswith(('apps/', 'packages/', 'programs/', 'tests/', 'scripts/', 'docs/', 'threats/', 'pda-test-ui/')):
            abbreviated_citations.append({'report': relative, 'citation': f'{path}:{spans}'})
            continue
        citations += 1
        if not source.is_file():
            issues.append({'report': relative, 'missing_source': path})
            continue
        total = len(source.read_text().splitlines())
        for span in spans.split(','):
            limits = [int(n) for n in span.split('-')]
            if min(limits) < 1 or max(limits) > total:
                issues.append({'report': relative, 'out_of_range': f'{path}:{span}', 'lines': total})

listeners = set()
for path in ['/proc/net/tcp', '/proc/net/tcp6']:
    for line in Path(path).read_text().splitlines()[1:]:
        fields = line.split()
        if fields[3] == '0A':
            listeners.add(int(fields[1].split(':')[-1], 16))
validation = {
    'timestamp_utc': now(), 'phase': 'runtime-finalization', 'cpu_affinity': [0],
    'baseline_files_checked': len(baseline), 'source_hash_changes': changes,
    'git_head': command(['git', 'rev-parse', 'HEAD']).strip(),
    'tracked_diff': command(['git', 'diff', 'HEAD', '--stat']),
    'git_status': command(['git', 'status', '--short']).splitlines(),
    'local_links_checked': links, 'source_citation_occurrences_checked': citations,
    'report_issues': issues, 'abbreviated_citations_not_validated': abbreviated_citations,
    'validation_scope': 'Local links and explicit repository source path/line ranges; not semantic review or abbreviated citation resolution.',
    'ports_listening': {str(p): p in listeners for p in [53001, 53010, 55432, 56379, 5432, 6379]},
    'memory': {line.split(':')[0]: line.split(':')[1].strip() for line in Path('/proc/meminfo').read_text().splitlines()
               if line.split(':')[0] in ['MemTotal', 'MemAvailable', 'SwapTotal', 'SwapFree']}
}
(OUT / 'final-integrity.json').write_text(json.dumps(validation, indent=2) + '\n')

summary = json.loads((OUT / 'runtime-summary.json').read_text())
records = [json.loads(x) for x in (OUT / 'commands.jsonl').read_text().splitlines() if x.strip()]
summary['phase'] = 'runtime-verification'
summary['finalized_at_utc'] = now()
summary['resource_controls'] = {'review_cpu': 0, 'all_recorded_commands_cpu_zero': all(r['cpu'] == 0 for r in records),
    'vitest_workers': 1, 'file_parallelism': False, 'node_heap_mib_initial': 384, 'node_heap_mib_retry': 640,
    'scope': 'Review-launched commands and containers only; existing infrastructure and Docker daemon not globally constrained.'}
summary.setdefault('containers_before_cleanup', cleanup['before'])
summary['containers'] = cleanup['after']
summary['cleanup_evidence'] = 'threats/runtime/cleanup.json'
summary['source_hash_changes'] = changes
for key in ['git_head', 'git_status', 'tracked_diff']:
    summary[key] = validation[key]
summary['integration']['configuration'] = 'threats/runtime-vitest.config.ts; migrations run separately; original global setup/schema guard not invoked'
summary['integration']['files'] = 18
summary['existing_local_schema'] = json.loads((OUT / 'existing-schema-check.json').read_text())
summary['existing_local_role'] = {'name': 'swat', 'superuser': True, 'createdb': True, 'createrole': True, 'bypassrls': True,
    'evidence': 'threats/runtime/existing-postgres-read-only.log', 'remote_role_verified': False}
summary['rls_correct_role']['role'] = 'swat_review_runtime, inherited swat_app grants; one test explicitly SET LOCAL ROLE swat_app'
summary['rls_correct_role']['caveat'] = 'Does not erase six initial failures or certify full service call paths/SQL-injection resistance.'
summary['build_and_typecheck_attempts'] = [r for r in records if r['name'].startswith('build-') or 'typecheck' in r['name'] or r['name'] == 'web-build-isolated']
summary['executor_build'] = {'emitted_retry': 'failed in temporary declaration layout: TS7006', 'source_typecheck': 'passed', 'original_emitted_build_verified': False}
summary['web_build'] = {'original_typecheck': 'failed: @solana/web3.js and tailwindcss unresolved',
    'copied_next_build': 'failed: tailwindcss missing and Inter/JetBrains Mono network fetch timeout', 'dependencies_installed_by_review': False}
summary['live_replay'] = json.loads((OUT / 'live-replay.json').read_text())
summary['service_checks'] = json.loads((OUT / 'service-smoke.json').read_text())
summary['queue_real_data'] = json.loads((OUT / 'queue-real-data.json').read_text())
summary['solana_success_parse'] = json.loads((OUT / 'solana-success-replay.json').read_text())
fetches = json.loads((OUT / 'live-fetches.json').read_text())
summary['live_read_only_calls'] = {'count': len(fetches), 'http_responses': sum('status' in r for r in fetches),
    'transport_errors': [r for r in fetches if 'error' in r], 'ledger': 'threats/runtime/live-fetches.json',
    'http_200_not_equivalent_to_rpc_success': True}
summary['solana_version_observation'] = {'rejected_limit': 0, 'retrieved_transaction_version': 1,
    'retrieved_sample_failed_on_chain': True, 'successful_sample_version': 0, 'successful_version_1_swap_verified': False}
audit = json.loads((OUT / 'dependency-audit-summary.json').read_text())
summary['dependency_audit'] = {'metadata': audit['metadata'], 'ratings_are_registry_advisories_not_application_exploits': True,
    'raw_evidence': 'threats/runtime/dependency-audit.log', 'reachability_fully_triaged': False}
summary['unverified'] = ['Funded custody and real signer paths', 'Full two-user real-source autonomous paper fan-out and lot exits',
    'Rust/Anchor/local-validator runtime tests: tools absent', 'Remote deployment/runtime roles/TLS/firewall',
    'Polygon public RPC verification: requests blocked', 'External contract/dependency audit', 'End-to-end latency percentiles', 'Rendered browser UI acceptance']
summary['no_application_source_fixes'] = True
summary['no_real_submissions_or_fund_movements'] = True
summary['final_integrity_evidence'] = 'threats/runtime/final-integrity.json'
(OUT / 'runtime-summary.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps({'validation': validation, 'review_containers_stopped': [c['name'] for c in cleanup['after'] if c['name'] in review_names and not c['running']],
                  'existing_containers_unchanged': cleanup['existing_containers_unchanged'], 'database_snapshot': snapshot}, indent=2))
if changes or issues or not cleanup['existing_containers_unchanged'] or any(p in listeners for p in [53001, 53010, 55432, 56379]):
    raise SystemExit(1)
