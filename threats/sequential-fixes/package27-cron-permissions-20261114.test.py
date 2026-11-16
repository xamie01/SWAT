#!/usr/bin/env python3
"""Source-only cron provisioning checks; no credentials or deployment execution."""
import hashlib
import json
import os
from pathlib import Path
import unittest

ROOT = Path('/home/xahmie/Documents/SWAT')
SOURCE = ROOT / 'deploy/crontab.example'


class CronPasswordFileChecks(unittest.TestCase):
    def test_password_file_is_private_to_the_unprivileged_reader(self):
        text = SOURCE.read_text()
        self.assertIn('# /etc/swat/pgpass: swat:swat 0600; libpq rejects group/other access.', text)

    def test_service_metadata_keeps_separate_root_owned_permissions(self):
        text = SOURCE.read_text()
        self.assertIn('# /etc/swat/pg_service.conf: root:swat 0640 (non-secret connection settings).', text)
        self.assertIn('PGSERVICEFILE=/etc/swat/pg_service.conf\n', text)

    def test_maintenance_uses_password_file_without_inline_credentials(self):
        text = SOURCE.read_text()
        self.assertIn('PGPASSFILE=/etc/swat/pgpass\n', text)
        self.assertIn('PGSERVICE=swat-maintenance\n', text)
        self.assertIn('/usr/bin/psql --no-password', text)
        self.assertNotIn('postgresql://', text)
        self.assertNotIn('PGPASSWORD=', text)


if __name__ == '__main__':
    result = unittest.TextTestRunner(verbosity=2).run(
        unittest.defaultTestLoader.loadTestsFromTestCase(CronPasswordFileChecks)
    )
    record = {
        'kind': 'source-only-cron-provisioning-regression',
        'testFile': str(Path(__file__).resolve()),
        'sourceFiles': [str(SOURCE)],
        'sourceSha256': hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
        'methodsRun': result.testsRun,
        'passed': result.testsRun - len(result.failures) - len(result.errors) - len(result.skipped),
        'failed': len(result.failures),
        'errors': len(result.errors),
        'skipped': len(result.skipped),
        'deploymentOrCredentialAccessExecuted': False,
        'libpqRuntimeExecuted': False,
        'exitCode': 0 if result.wasSuccessful() else 1
    }
    with Path(os.environ['REVIEW_RESULTS']).open('x') as handle:
        json.dump(record, handle, indent=2)
        handle.write('\n')
    print(json.dumps(record, indent=2))
    raise SystemExit(record['exitCode'])
