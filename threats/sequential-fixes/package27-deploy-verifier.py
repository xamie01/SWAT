#!/usr/bin/env python3
"""Reviewed standard-library, source-only package27 checks; never runs deployment code."""
import ast
import hashlib
import json
from pathlib import Path
import re
import sys
import tempfile
import unittest

ROOT = Path('/home/xahmie/Documents/SWAT')
MANIFEST = ROOT / 'threats/sequential-fixes/package27-deploy-manifest.json'


def source_checks():
    manifest = json.loads(MANIFEST.read_text())
    sources = {name: (ROOT / name).read_text() for name in manifest['sourceFiles']}
    results = []

    def check(name, condition):
        results.append({'name': name, 'passed': bool(condition)})

    for name, text in sources.items():
        if name.endswith('.service'):
            check(name + ':unprivileged-path', 'User=swat\n' in text and
                  'Group=swat\n' in text and '/root/' not in text and
                  'WorkingDirectory=/opt/swat/current' in text and
                  'EnvironmentFile=/etc/swat/' in text)
            check(name + ':read-only-code-explicit-state',
                  'ProtectSystem=strict\n' in text and 'ProtectHome=true\n' in text and
                  'NoNewPrivileges=true\n' in text and 'StateDirectory=swat-' in text and
                  'UMask=0077\n' in text)
    cron = sources['deploy/crontab.example']
    check('cron:no-protected-home-or-inline-database-password',
          '/root/' not in cron and 'postgresql://' not in cron and 'PGSERVICE=' in cron)
    ci = sources['.woodpecker.yaml']
    check('ci:mirrored-config', ci == sources['.woodpecker/ci.yaml'])
    split = ci.split('  - name: deploy-vercel\n', 1)
    publish = split[1] if len(split) == 2 else ''
    check('ci:credential-free-local-acquisition-stage',
          '  - name: acquire-deploy-artifacts\n' in ci and
          'env -i PATH=/usr/local/bin:/usr/bin:/bin python3 deploy/tools/package27-deploy-artifacts.py acquire' in ci)
    check('ci:publish-does-not-install-pull-or-build',
          bool(publish) and 'from_secret: vercel_token' in publish and
          'package27-deploy-artifacts.py publish' in publish and
          not any(word in publish for word in ('npm install', 'corepack', 'vercel pull', 'vercel build', 'pnpm ', 'curl ', 'wget ')))
    check('ci:pending-publish-does-not-receive-secrets', "evaluate: 'false'" in publish)
    runbook = sources.get('DEPLOYMENT.md', '')
    if runbook:
        section = runbook.split('### Method A: Systemd Services (Recommended)', 1)[1].split('## 8.', 1)[0]
        check('runbook:canonical-not-root-or-global-pm2',
              'User=root' not in section and 'npm install -g pm2' not in section and
              '/opt/swat/current' in section and 'StateDirectory' in section and
              'ProtectHome=true' in section and 'root:swat' in section)
    artifact = sources.get('deploy/tools/package27-deploy-artifacts.py', '')
    python_setup = sources.get('deploy/tools/package27-deploy-python-install.py', '')
    if artifact:
        tree = ast.parse(artifact)
        compile(tree, 'package27-deploy-artifacts.py', 'exec')  # Never exec/import script.
        check('artifacts:pending-lock-blocks-runtime',
              json.loads(sources['deploy/tools/package27-deploy-artifacts.lock.json'])['approval'] == 'pending' and
              "lock.get('approval') != 'reviewed'" in artifact and
              'IMAGE.fullmatch' in artifact and 'verify_tree(OUTPUT' in artifact)
        acquire = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'acquire')
        check('artifacts:acquisition-does-not-run-child-process',
              not any(isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and node.value.id == 'subprocess' for node in ast.walk(acquire)))
        check('artifacts:complete-hash-inventory-and-no-symlinks',
              "actual != set(expected)" in artifact and "path.is_symlink()" in artifact and
              "hashlib.sha256(path.read_bytes())" in artifact and "'.env'" in artifact)
    if python_setup:
        compile(ast.parse(python_setup), 'package27-deploy-python-install.py', 'exec')
        check('python:offline-hash-locked-no-resolution',
              all(flag in python_setup for flag in ('--no-index', '--require-hashes', '--no-deps', '--only-binary=:all:', '--no-cache-dir', '--isolated')) and
              "os.geteuid() == 0" in python_setup and "sys.prefix == sys.base_prefix" in python_setup and
              "lock.get('approval') != 'reviewed'" in python_setup and
              json.loads(sources['deploy/tools/package27-deploy-python.lock.json'])['approval'] == 'pending')
    return manifest, sources, results


class NeighborChecks(unittest.TestCase):
    def test_billing_timer_policy_unchanged(self):
        text = (ROOT / 'deploy/systemd/swat-billing-sweep.timer').read_text()
        self.assertIn('OnCalendar=*-*-* 00:00:00 UTC', text)
        self.assertIn('Persistent=true', text)

    def test_ci_non_deployment_policy_identical(self):
        baseline = json.loads((ROOT / 'threats/sequential-fixes/package27-deploy-red.json').read_text())
        text = (ROOT / '.woodpecker.yaml').read_text().split('  - name: acquire-deploy-artifacts\n')[0]
        self.assertEqual(hashlib.sha256(text.encode()).hexdigest(), baseline['nonDeployCiSha256'])

    def test_executor_concurrency_preserved(self):
        text = (ROOT / 'deploy/systemd/swat-trade-executor.service').read_text()
        self.assertIn('Environment=TRADE_CONCURRENCY_SOLANA=5', text)
        self.assertIn('Environment=TRADE_CONCURRENCY_POLYGON=3', text)


if __name__ == '__main__':
    if len(sys.argv) != 3 or sys.argv[1] not in ('red', 'green', 'neighbors'):
        raise SystemExit('Usage: verifier.py red|green|neighbors UNIQUE-ABSOLUTE-EVIDENCE.json')
    phase, output = sys.argv[1:]
    manifest, sources, results = source_checks()
    tests = None
    if phase == 'neighbors':
        tests = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(NeighborChecks))
    record = {
        'phase': phase, 'manifest': str(MANIFEST),
        'sourceFiles': [str(ROOT / name) for name in sources],
        'sourceSha256': {name: hashlib.sha256(text.encode()).hexdigest() for name, text in sources.items()},
        'nonDeployCiSha256': hashlib.sha256(sources['.woodpecker.yaml'].split('  - name: deploy-vercel\n')[0].encode()).hexdigest(),
        'assertions': results, 'passed': sum(row['passed'] for row in results),
        'failed': sum(not row['passed'] for row in results), 'skipped': 0,
        'neighborTests': None if tests is None else {'run': tests.testsRun, 'failed': len(tests.failures), 'errors': len(tests.errors), 'skipped': len(tests.skipped)},
        'executedDeploymentOrInstallerCode': False, 'runtimeAcceptance': False,
        'safety': 'Only explicit public source reads, SHA256, static assertions and stdlib unittest; no subprocess, network, credential reads or deployment imports.'
    }
    code = 0 if all(row['passed'] for row in results) and (tests is None or tests.wasSuccessful()) else 1
    record['exitCode'] = code
    with Path(output).open('x') as handle:
        json.dump(record, handle, indent=2)
        handle.write('\n')
    print(json.dumps(record, indent=2))
    raise SystemExit(code)
