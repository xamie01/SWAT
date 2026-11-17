"""Keyless unit tests for the bounded check planner; never launches children."""
import importlib.util
import fcntl
import os
from pathlib import Path
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().with_name('build-completion-runner.py')
spec = importlib.util.spec_from_file_location('bounded_runner', SCRIPT)
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class RunnerTests(unittest.TestCase):
    def test_root_is_portable(self):
        self.assertEqual(runner.ROOT, SCRIPT.parents[1])

    def test_no_arbitrary_commands(self):
        for kind, target in [('shell', 'bash'), ('static', '/bin/sh'), ('emit', 'web'),
                             ('typecheck', '../secret'), ('test', 'package.json')]:
            with self.assertRaises(ValueError):
                runner.command_for(kind, target)

    def test_bounded_compilers(self):
        command, _, heap = runner.command_for('typecheck', 'db')
        self.assertEqual(heap, 640)
        self.assertIn('--noEmit', command)
        self.assertNotIn('pnpm', command)

    def test_no_real_environment_inherited(self):
        values = runner.synthetic_environment('build-unit', 512)
        self.assertEqual(values['TRADING_MODE'], 'paper')
        self.assertEqual(values['LIVE_ENABLED_CHAINS'], '')
        self.assertIn('--require=', values['NODE_OPTIONS'])
        self.assertNotIn('PRIVATE_KEY', values)

    def test_reviewed_config_inventory_is_required(self):
        command, _, heap = runner.command_for('test', 'threats/build-completion-20261116-sequential/api-baseline.config.ts')
        self.assertEqual(heap, 512)
        self.assertIn('--config', command)

    def test_consumed_input_fingerprints(self):
        inputs = runner.workspace_inputs()
        for name in ['package.json', 'threats/sequential-fixes/test-safety.ts',
                     'threats/build-completion-20261116-sequential/api-baseline.config.ts',
                     'packages/shared/dist/index.d.ts']:
            self.assertIn(name, inputs)
        self.assertNotIn('.env', inputs)
        self.assertNotIn('.env.example', inputs)
        emitted = runner.workspace_inputs('emit', 'shared')
        self.assertNotIn('packages/shared/dist/index.d.ts', emitted)
        self.assertIn('packages/db/dist/index.d.ts', emitted)

    def test_names_inventory_matches_current_template(self):
        command, inputs, _ = runner.command_for('static', 'env')
        self.assertIn('--names-file', command)
        self.assertIn(runner.ROOT / '.env.example', inputs)

    def test_inherited_lock_reuses_open_file_description(self):
        previous = runner.LOCK
        with tempfile.TemporaryDirectory() as directory:
            runner.LOCK = Path(directory) / 'checks.lock'
            try:
                with runner.LOCK.open('a') as outer:
                    fcntl.flock(outer, fcntl.LOCK_EX)
                    with runner.verification_lock() as inner:
                        fcntl.flock(inner, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        self.assertNotEqual(outer.fileno(), inner.fileno())
                        self.assertEqual(os.fstat(outer.fileno()).st_ino, os.fstat(inner.fileno()).st_ino)
            finally:
                runner.LOCK = previous

    def test_external_paths_rejected(self):
        with self.assertRaises(ValueError):
            runner.confined(Path('/usr/bin/node'))


if __name__ == '__main__':
    unittest.main()
