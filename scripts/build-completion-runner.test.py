"""Keyless runner unit tests. Children/affinity/signals are mocked; no compiler."""
import contextlib
import fcntl
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

SCRIPT = Path(__file__).resolve().with_name('build-completion-runner.py')
spec = importlib.util.spec_from_file_location('bounded_runner', SCRIPT)
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class FixtureTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.out = self.root / 'threats/build-completion-20261116-sequential'
        self.out.mkdir(parents=True)
        self.policy = self.root / 'scripts/build-completion-inputs.json'
        self.put('scripts/build-completion-inputs.json', (SCRIPT.with_name('build-completion-inputs.json')).read_text())
        policy = json.loads(self.policy.read_text())
        policy['runtimePaths'] = []
        self.policy.write_text(json.dumps(policy))
        self.guard = self.put('threats/sequential-fixes/offline-guard.cjs', '// guard')
        self.put('threats/sequential-fixes/package12-29-harness.ts', '// harness')
        self.put('threats/sequential-fixes/test-safety.ts', '// safety')
        self.put('scripts/build-completion-runner.py', '// runner fixture')
        self.put('package.json', '{}')
        self.put('pnpm-lock.yaml', 'lock')
        self.put('pnpm-workspace.yaml', 'packages: []')
        self.put('node_modules/.modules.yaml', 'metadata')
        self.put('node_modules/.pnpm/lock.yaml', 'installed lock')
        self.put('threats/build-completion-20261116-sequential/reviewed-configs.json', '{"configs": {}}')
        for attr, value in [('ROOT', self.root), ('OUT', self.out), ('GUARD', self.guard), ('POLICY', self.policy)]:
            mocked = patch.object(runner, attr, value)
            mocked.start()
            self.addCleanup(mocked.stop)

    def put(self, name, text='fixture'):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        return path

    def install(self, name, dependencies=None):
        package = self.root / 'node_modules/.pnpm' / name.replace('/', '+') / 'node_modules' / name
        package.mkdir(parents=True)
        (package / 'package.json').write_text(json.dumps({'name': name, 'dependencies': dependencies or {}}))
        (package / 'runtime.js').write_text('// runtime')
        link = self.root / 'node_modules' / name
        link.parent.mkdir(parents=True, exist_ok=True)
        link.symlink_to(package, target_is_directory=True)
        return package

    def options(self, kind='static', target='runner', label='build-unit'):
        return SimpleNamespace(label=label, kind=kind, target=target, timeout_seconds=0)

    def fake_child(self, code=0):
        child = Mock(pid=456, returncode=code)
        child.wait.return_value = code
        return child

    @contextlib.contextmanager
    def attempt_mocks(self, child=None, snapshot=None):
        script = self.put('scripts/check.py', '# fixture')
        child = child or self.fake_child()
        # The fixture runner path matches the input hashing contract, without reading real source twice.
        with patch.object(runner, '__file__', str(self.root / 'scripts/build-completion-runner.py')), \
             patch.object(runner, 'command_for', return_value=(['/usr/bin/python3', str(script)], [script], 512)) as plan, \
             patch.object(runner, 'workspace_inputs', return_value=snapshot or {'source': 'stable'}) as inputs, \
             patch.object(runner.subprocess, 'Popen', return_value=child) as launch, \
             patch.object(runner.os, 'killpg') as kill, \
             patch.object(runner.os, 'sched_getaffinity', return_value={0}), \
             contextlib.redirect_stdout(io.StringIO()):
            yield child, plan, inputs, launch, kill

    def record(self, label='build-unit', private=False):
        path = self.out / (f'attempts/{label}/final.command.json' if private else f'{label}.command.json')
        return json.loads(path.read_text())

    def approve(self):
        target = 'threats/build-completion-20261116-sequential/unit.config.ts'
        self.put('tests/unit.test.ts', '// test')
        config = self.put(target, "import { createPackageConfig } from '../sequential-fixes/package12-29-harness.js';\nexport default createPackageConfig(['tests/unit.test.ts']);")
        binding = runner.approval_binding(target)
        inventory = {'configs': {target: runner.digest(config)}, 'commandBindings': {target: binding}}
        (self.out / 'reviewed-configs.json').write_text(json.dumps(inventory))
        return target, binding

    def emit_fixture(self):
        self.put('tsconfig.base.json', json.dumps({'compilerOptions': {'declaration': True, 'declarationMap': True, 'sourceMap': True}}))
        self.put('packages/shared/tsconfig.json', json.dumps({'extends': '../../tsconfig.base.json',
            'compilerOptions': {'rootDir': 'src', 'outDir': 'dist', 'composite': True},
            'include': ['src'], 'exclude': ['src/**/*.test.ts']}))
        self.put('packages/shared/src/index.ts', 'export const a = 1;')
        self.put('packages/shared/src/ignored.test.ts', 'export const ignored = 1;')
        attempt = self.out / 'attempts/build-emit'
        attempt.mkdir(parents=True)
        command, plan = runner.emit_plan('shared', ['node', 'tsc', '-p', 'config'], attempt)
        return command, plan

    def complete_stage(self, plan):
        for name in plan['expected']:
            path = plan['stage'] / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('// freshly emitted')
        log = self.put('threats/build-completion-20261116-sequential/build-emit.log',
                       ''.join('TSFILE: ' + str(plan['stage'] / name) + '\n' for name in sorted(plan['expected'])))
        return log

    def test_omitted_roots_extensions_and_docs_are_inputs(self):
        names = ['vitest.integration.config.ts', 'scripts/test-integration.sh',
                 'deploy/loadtest/wave4/README.md', 'deploy/loadtest/wave4/run.sh',
                 '.woodpecker.yaml', '.woodpecker/ci.yaml', 'DEPLOYMENT.md',
                 'tests/fixtures/sample.txt', 'threats/project-completion-20261117/WAVE4-LP-PRIVILEGES-PROPOSAL.md',
                 'threats/project-completion-20261117/081-custody-schema.proposal.sql']
        for name in names:
            self.put(name)
        snapshot = runner.workspace_inputs()
        self.assertTrue(set(names).issubset(snapshot))
        for name in names:
            path = self.root / name
            old = path.read_text()
            path.write_text(old + ' changed')
            self.assertNotEqual(snapshot, runner.workspace_inputs(), name)
            path.write_text(old)

    def test_additions_and_removals_are_detected(self):
        before = runner.workspace_inputs()
        added = self.put('deploy/fixtures/new.unusual-extension')
        after = runner.workspace_inputs()
        self.assertNotEqual(before, after)
        added.unlink()
        self.assertNotEqual(after, runner.workspace_inputs())

    def test_runtime_declarations_data_resolution_and_symlinks_are_bound(self):
        typescript = self.install('typescript')
        (typescript / 'lib').mkdir()
        declaration = typescript / 'lib/lib.es2022.d.ts'
        declaration.write_text('// declaration')
        vite = self.install('vite')
        self.install('std-env')
        vitest = self.install('vitest', {'vite': '*', 'std-env': '*'})
        (vitest / 'data.txt').write_text('consumed data')
        before = runner.workspace_inputs()
        self.assertIn(str(declaration.relative_to(self.root)), before)
        self.assertIn(str((vite / 'runtime.js').relative_to(self.root)), before)
        self.assertIsInstance(before['node_modules/vitest'], dict)
        declaration.write_text('// changed declaration')
        self.assertNotEqual(before, runner.workspace_inputs())
        link = self.root / 'node_modules/vitest'
        link.unlink()
        link.symlink_to(vite, target_is_directory=True)
        self.assertNotEqual(before, runner.workspace_inputs())

    def test_package_absent_resolution_probes_change_on_install(self):
        self.install('vitest')
        metadata = self.root / 'node_modules/vitest/package.json'
        metadata.write_text(json.dumps({'optionalDependencies': {'std-env': '*'}}))
        before = runner.workspace_inputs()
        self.assertTrue(any(name.endswith('std-env#absent') for name in before))
        self.install('std-env')
        self.assertNotEqual(before, runner.workspace_inputs())

    def test_unreachable_store_is_not_blindly_hashed(self):
        self.put('node_modules/.pnpm/unreachable/node_modules/unreachable/package.json', '{}')
        snapshot = runner.workspace_inputs()
        self.assertFalse(any('unreachable' in name for name in snapshot))

    def test_symlink_target_content_and_identity_drift(self):
        first = self.put('tests/first.fixture')
        second = self.put('tests/second.fixture')
        link = self.root / 'scripts/fixture-link'
        link.symlink_to(first)
        before = runner.workspace_inputs()
        first.write_text('changed')
        self.assertNotEqual(before, runner.workspace_inputs())
        link.unlink()
        link.symlink_to(second)
        self.assertNotEqual(before, runner.workspace_inputs())

    def test_escaping_dangling_and_cyclic_symlinks_fail_closed(self):
        link = self.root / 'tests/link'
        link.parent.mkdir(exist_ok=True)
        link.symlink_to('/outside-workspace')
        with self.assertRaises((FileNotFoundError, ValueError)):
            runner.workspace_inputs()
        link.unlink()
        link.symlink_to(self.root / 'tests', target_is_directory=True)
        with self.assertRaises(ValueError):
            runner.workspace_inputs()

    def test_generated_reports_excluded_but_consumed_dist_retained(self):
        self.put('packages/shared/dist/index.d.ts')
        self.put('packages/db/dist/index.d.ts')
        before = runner.workspace_inputs()
        self.put('threats/build-completion-20261116-sequential/build-generated.json', '{}')
        self.put('threats/build-completion-20261116-sequential/attempts/build-x/results.json', '{}')
        self.assertEqual(before, runner.workspace_inputs())
        emitted = runner.workspace_inputs('emit', 'shared')
        self.assertNotIn('packages/shared/dist/index.d.ts', emitted)
        self.assertIn('packages/db/dist/index.d.ts', emitted)

    def test_credentials_are_not_read(self):
        self.put('.env', 'DO NOT READ')
        self.put('tests/credentials.json', 'DO NOT READ')
        snapshot = runner.workspace_inputs()
        self.assertNotIn('.env', snapshot)
        self.assertNotIn('tests/credentials.json', snapshot)

    def test_full_binding_generated_without_recursive_root_and_validated(self):
        target, binding = self.approve()
        self.assertNotIn('threats/build-completion-20261116-sequential/reviewed-configs.json', binding['inputSha256'])
        self.assertEqual(binding['literalFiles'], ['tests/unit.test.ts'])
        result = runner.validate_approval('test', target, runner.workspace_inputs('test', target))
        self.assertIn('inventorySha256', result)
        self.put('scripts/new-input.sh')
        with self.assertRaisesRegex(ValueError, 'complete input closure'):
            runner.validate_approval('test', target, runner.workspace_inputs('test', target))

    def test_historical_inventory_is_unchanged_but_not_new_approval(self):
        target, _ = self.approve()
        inventory = self.out / 'reviewed-configs.json'
        value = json.loads(inventory.read_text())
        value.pop('commandBindings')
        inventory.write_text(json.dumps(value))
        before = inventory.read_bytes()
        with self.assertRaisesRegex(ValueError, 'commandBindings'):
            runner.validate_approval('test', target, runner.workspace_inputs('test', target))
        self.assertEqual(inventory.read_bytes(), before)

    def test_literals_harness_guard_and_inventory_drift_refused(self):
        target, _ = self.approve()
        snapshot = runner.workspace_inputs('test', target)
        self.guard.write_text('// changed guard')
        with self.assertRaises(ValueError):
            runner.validate_approval('test', target, runner.workspace_inputs('test', target))
        with self.assertRaises(ValueError):
            runner.validate_approval('test', target, snapshot)

    def test_result_gate_preserves_zero_skip_todo_and_exact_inventory(self):
        approval = {'literalFiles': ['tests/unit.test.ts']}
        report = {'success': True, 'numTotalTests': 1, 'numPassedTests': 1,
                  'numFailedTests': 0, 'numPendingTests': 0, 'numTodoTests': 0,
                  'testResults': [{'name': str(self.root / 'tests/unit.test.ts'), 'status': 'passed',
                                   'assertionResults': [{'status': 'passed'}]}]}
        self.assertEqual(runner.validate_results(json.dumps(report), approval)['passed'], 1)
        for status_name, aggregate in [('skipped', 'numPendingTests'), ('pending', 'numPendingTests'), ('todo', 'numTodoTests')]:
            changed = json.loads(json.dumps(report))
            changed['testResults'][0]['assertionResults'][0]['status'] = status_name
            changed['numPassedTests'] = 0
            changed[aggregate] = 1
            with self.assertRaises(ValueError):
                runner.validate_results(json.dumps(changed), approval)
        report['testResults'][0]['name'] = str(self.root / 'tests/unselected.test.ts')
        with self.assertRaises(ValueError):
            runner.validate_results(json.dumps(report), approval)

    def test_popen_failure_finalizes_immutable_command(self):
        with self.attempt_mocks() as (_, _, _, launch, _):
            launch.side_effect = OSError('launch refused')
            self.assertEqual(runner.execute_attempt(self.options()), 125)
        record = self.record()
        self.assertIsNone(record['childExitCode'])
        self.assertIn('runnerSha256', record)
        self.assertTrue(any('launch refused' in item['message'] for item in record['diagnostics']))
        self.assertTrue((self.out / 'attempts/build-unit/reservation.json').is_file())

    def test_postrun_missing_unreadable_inputs_finalizes_actual_child_code(self):
        for error in [FileNotFoundError('removed input'), PermissionError('unreadable input')]:
            label = 'build-' + type(error).__name__
            with self.attempt_mocks() as (_, _, inputs, _, _):
                inputs.side_effect = [{'source': 'stable'}, {'source': 'stable'}, error]
                self.assertEqual(runner.execute_attempt(self.options(label=label)), 125)
            record = self.record(label)
            self.assertEqual(record['childExitCode'], 0)
            self.assertFalse(record['workspaceInputsUnchanged'])
            self.assertTrue(any(item['phase'] == 'postrun-inputs' for item in record['diagnostics']))

    def test_planner_drift_refused_immediately_before_launch(self):
        with self.attempt_mocks() as (_, planner, _, launch, _):
            script = self.root / 'scripts/check.py'
            planner.side_effect = [(['python', str(script)], [script], 512), (['python', str(script), '--changed'], [script], 512)]
            self.assertEqual(runner.execute_attempt(self.options()), 125)
            launch.assert_not_called()
        self.assertIsNone(self.record()['childExitCode'])

    def test_snapshot_drift_before_launch_no_child(self):
        with self.attempt_mocks() as (_, _, inputs, launch, _):
            inputs.side_effect = [{'a': 'first'}, {'a': 'changed'}, {'a': 'changed'}]
            self.assertEqual(runner.execute_attempt(self.options()), 125)
            launch.assert_not_called()

    def test_result_hash_failure_and_late_collision_retained(self):
        target, _ = self.approve()
        with self.attempt_mocks() as (_, _, _, launch, _), patch.object(runner, 'validate_approval', return_value={'literalFiles': ['tests/unit.test.ts']}):
            def child_launch(*args, **kwargs):
                (self.out / 'build-unit.json').write_text('prior result')
                Path(kwargs['env']['REVIEW_RESULTS']).write_text('{}')
                return self.fake_child()
            launch.side_effect = child_launch
            self.assertEqual(runner.execute_attempt(self.options('test', target)), 125)
        self.assertEqual((self.out / 'build-unit.json').read_text(), 'prior result')
        self.assertTrue(any(item['phase'] == 'result-collection-or-acceptance' for item in self.record()['diagnostics']))

    def test_missing_result_and_log_hash_failure_each_finalize(self):
        with self.attempt_mocks(), patch.object(runner, 'validate_approval', return_value={'literalFiles': ['tests/unit.test.ts']}):
            self.assertEqual(runner.execute_attempt(self.options('test', 'unused')), 125)
        self.assertEqual(self.record()['childExitCode'], 0)
        real_digest = runner.digest
        with self.attempt_mocks(), patch.object(runner, 'digest', side_effect=lambda path: (_ for _ in ()).throw(OSError('hash failed')) if path.suffix == '.log' else real_digest(path)):
            self.assertEqual(runner.execute_attempt(self.options(label='build-hash')), 125)
        self.assertIsNone(self.record('build-hash')['logSha256'])

    def test_timeout_actual_returncode_not_synthetic_124(self):
        child = self.fake_child(-runner.signal.SIGTERM)
        child.wait.side_effect = [runner.subprocess.TimeoutExpired('fixture', 1), -15, -15]
        with self.attempt_mocks(child):
            options = self.options()
            options.timeout_seconds = 1
            self.assertEqual(runner.execute_attempt(options), 124)
        record = self.record()
        self.assertEqual(record['childExitCode'], -15)
        self.assertTrue(record['timedOut'])

    def test_dangling_label_entries_and_build_info_collision(self):
        for suffix in ['.log', '.command.json', '.json', '.inputs.json']:
            path = self.out / ('build-collision' + suffix)
            path.symlink_to(self.root / 'missing')
            with self.attempt_mocks() as (_, _, _, launch, _):
                with self.assertRaises(FileExistsError):
                    runner.execute_attempt(self.options(label='build-collision'))
                launch.assert_not_called()
            path.unlink()
        self.put('threats/build-completion-20261116-sequential/tmp/build-collision.tsbuildinfo')
        with self.attempt_mocks(), self.assertRaises(FileExistsError):
            runner.execute_attempt(self.options(label='build-collision'))

    def test_late_record_collision_finalizes_private_namespace(self):
        original = runner.exclusive_open
        def collide(path):
            if path.name == 'build-unit.command.json':
                path.write_text('prior command')
            return original(path)
        with self.attempt_mocks() as (_, _, _, launch, _), patch.object(runner, 'exclusive_open', side_effect=collide):
            self.assertEqual(runner.execute_attempt(self.options()), 125)
            launch.assert_not_called()
        self.assertEqual((self.out / 'build-unit.command.json').read_text(), 'prior command')
        self.assertEqual(self.record(private=True)['exitCode'], 125)

    def test_no_follow_results_and_hardlink_artifacts(self):
        source = self.put('tests/source.json', '{}')
        link = self.root / 'tests/link.json'
        link.symlink_to(source)
        with self.assertRaises(OSError):
            runner.read_regular(link)
        link.unlink()
        os.link(source, link)
        with self.assertRaises(ValueError):
            runner.read_regular(source)
        with self.assertRaises(FileExistsError):
            runner.publish_bytes(link, b'new')
        self.assertEqual(source.read_text(), '{}')

    def test_staged_results_namespace_not_shared_overwrite(self):
        attempt = self.out / 'attempts/build-unit'
        values = runner.synthetic_environment('build-unit', 512, attempt)
        self.assertEqual(values['REVIEW_RESULTS'], str(attempt / 'results.json'))
        self.assertEqual(values['HOME'], str(attempt))

    def test_emit_fresh_stage_complete_listing_and_noemit_separation(self):
        command, plan = self.emit_fixture()
        self.assertIn('--outDir', command)
        self.assertIn('--listEmittedFiles', command)
        self.assertNotIn('--noEmit', command)
        self.assertEqual(len(plan['expected']), 4)
        self.assertFalse(any('ignored' in name for name in plan['expected']))
        log = self.complete_stage(plan)
        self.assertEqual(set(runner.collect_emit(plan, log)), plan['expected'])

    def test_emit_rejects_empty_incomplete_extra_and_unexpected_listing(self):
        _, plan = self.emit_fixture()
        log = self.put('threats/build-completion-20261116-sequential/build-emit.log', '')
        with self.assertRaises(ValueError):
            runner.collect_emit(plan, log)
        log = self.complete_stage(plan)
        removed = plan['stage'] / 'index.js'
        removed.unlink()
        with self.assertRaises(ValueError):
            runner.collect_emit(plan, log)
        removed.write_text('// freshly emitted')
        log.write_text(log.read_text() + 'TSFILE: /unexpected/location.js\n')
        with self.assertRaisesRegex(ValueError, 'location'):
            runner.collect_emit(plan, log)
        log = self.complete_stage(plan)
        (plan['stage'] / 'stale.js').write_text('stale')
        with self.assertRaises(ValueError):
            runner.collect_emit(plan, log)

    def test_emit_preserves_unrelated_survivors_and_publishes_proven_only(self):
        _, plan = self.emit_fixture()
        old = self.put('packages/shared/dist/stale.js', 'unrelated old survivor')
        self.put('packages/shared/dist/index.js', 'old emitted index')
        before = runner.artifact_inventory(plan['destination'])
        hashes = runner.collect_emit(plan, self.complete_stage(plan))
        published = {}
        runner.publish_emit(plan, before, hashes, published)
        self.assertEqual(old.read_text(), 'unrelated old survivor')
        self.assertEqual(set(published), {str((plan['destination'] / name).relative_to(self.root)) for name in hashes})
        self.assertNotIn('packages/shared/dist/stale.js', published)

    def test_emit_existing_dist_drift_and_symlink_preflight(self):
        _, plan = self.emit_fixture()
        self.put('packages/shared/dist/old.js', 'old')
        before = runner.artifact_inventory(plan['destination'])
        hashes = runner.collect_emit(plan, self.complete_stage(plan))
        self.put('packages/shared/dist/old.js', 'changed')
        with self.assertRaises(ValueError):
            runner.publish_emit(plan, before, hashes, {})
        link = plan['destination'] / 'index.js'
        link.symlink_to(self.root / 'missing')
        with self.assertRaises(ValueError):
            runner.artifact_inventory(plan['destination'])

    def test_emit_partial_publication_is_recordable(self):
        _, plan = self.emit_fixture()
        hashes = runner.collect_emit(plan, self.complete_stage(plan))
        published = {}
        replace = runner.os.replace
        def fail_second(source, destination):
            if published:
                raise OSError('publication interrupted')
            replace(source, destination)
        with patch.object(runner.os, 'replace', side_effect=fail_second), self.assertRaises(OSError):
            runner.publish_emit(plan, {}, hashes, published)
        self.assertEqual(len(published), 1)

    def test_emit_collection_failure_finalizes_command(self):
        _, plan = self.emit_fixture()
        with self.attempt_mocks(), patch.object(runner, 'emit_plan', return_value=(['node', 'tsc'], plan)), \
             patch.object(runner, 'collect_emit', side_effect=OSError('artifact unreadable')):
            self.assertEqual(runner.execute_attempt(self.options('emit', 'shared')), 125)
        record = self.record()
        self.assertEqual(record['childExitCode'], 0)
        self.assertTrue(any(item['phase'] == 'artifact-collection-or-publication' for item in record['diagnostics']))

    def test_shutdown_failure_and_final_record_write_failure_retained(self):
        with self.attempt_mocks(), patch.object(runner, 'stop_owned_child', side_effect=OSError('shutdown refused')):
            self.assertEqual(runner.execute_attempt(self.options()), 125)
        self.assertTrue(any(item['phase'] == 'owned-child-shutdown' for item in self.record()['diagnostics']))
        write = runner.write_json
        def fail_record(handle, value):
            if value.get('label') == 'build-final-write' and 'exitCode' in value and not any(
                    item['phase'] == 'command-record-finalization' for item in value['diagnostics']):
                raise OSError('record write failed')
            write(handle, value)
        with self.attempt_mocks(), patch.object(runner, 'write_json', side_effect=fail_record):
            self.assertEqual(runner.execute_attempt(self.options(label='build-final-write')), 125)
        fallback = self.out / 'attempts/build-final-write/finalization-failure.command.json'
        self.assertEqual(json.loads(fallback.read_text())['exitCode'], 125)

    def test_result_symlink_after_launch_never_followed(self):
        with self.attempt_mocks() as (_, _, _, launch, _), patch.object(runner, 'validate_approval', return_value={'literalFiles': ['tests/unit.test.ts']}):
            source = self.put('tests/unsafe-result.json', '{}')
            def create_symlink(*args, **kwargs):
                Path(kwargs['env']['REVIEW_RESULTS']).symlink_to(source)
                return self.fake_child()
            launch.side_effect = create_symlink
            self.assertEqual(runner.execute_attempt(self.options('test', 'unused')), 125)
        self.assertFalse((self.out / 'build-unit.json').exists())
        self.assertEqual(source.read_text(), '{}')

    def test_successful_staged_report_published_once(self):
        report = {'success': True, 'numTotalTests': 1, 'numPassedTests': 1,
                  'numFailedTests': 0, 'numPendingTests': 0, 'numTodoTests': 0,
                  'testResults': [{'name': str(self.root / 'tests/unit.test.ts'), 'status': 'passed',
                                   'assertionResults': [{'status': 'passed'}]}]}
        with self.attempt_mocks() as (_, _, _, launch, _), patch.object(runner, 'validate_approval', return_value={'literalFiles': ['tests/unit.test.ts']}):
            def write_result(*args, **kwargs):
                Path(kwargs['env']['REVIEW_RESULTS']).write_text(json.dumps(report))
                return self.fake_child()
            launch.side_effect = write_result
            self.assertEqual(runner.execute_attempt(self.options('test', 'unused')), 0)
        self.assertIsNotNone(self.record()['resultSha256'])
        before = (self.out / 'build-unit.json').read_bytes()
        with self.attempt_mocks(), self.assertRaises(FileExistsError):
            runner.execute_attempt(self.options('test', 'unused'))
        self.assertEqual((self.out / 'build-unit.json').read_bytes(), before)

    def test_emit_unsupported_config_and_dangling_build_info_refused(self):
        _, plan = self.emit_fixture()
        attempt = self.out / 'attempts/build-other'
        attempt.mkdir()
        (attempt / 'compiler.tsbuildinfo').symlink_to(self.root / 'missing')
        with self.assertRaises(FileExistsError):
            runner.emit_plan('shared', ['node', 'tsc'], attempt)
        unsupported = self.root / 'packages/shared/tsconfig.json'
        config = json.loads(unsupported.read_text())
        config['compilerOptions']['noEmit'] = True
        unsupported.write_text(json.dumps(config))
        with self.assertRaises(ValueError):
            runner.emit_plan('shared', ['node', 'tsc'], attempt)

    def test_main_plans_only_after_shared_flock(self):
        events = []
        @contextlib.contextmanager
        def lock():
            events.append('lock-open')
            yield Mock()
        def flock(*args):
            events.append('flock')
        def attempt(options):
            events.append('plan-execute')
            return 0
        with patch.object(runner.sys, 'argv', ['runner', 'build-unit', 'static', 'runner', '--timeout-seconds', '0']), \
             patch.object(runner.os, 'sched_setaffinity') as affinity, \
             patch.object(runner, 'verification_lock', side_effect=lock), \
             patch.object(runner.fcntl, 'flock', side_effect=flock), \
             patch.object(runner, 'execute_attempt', side_effect=attempt):
            self.assertEqual(runner.main(), 0)
        self.assertEqual(events, ['lock-open', 'flock', 'plan-execute'])
        affinity.assert_called_once_with(0, {0})


class RunnerTests(unittest.TestCase):
    def test_root_is_portable(self):
        self.assertEqual(runner.ROOT, SCRIPT.parents[1])

    def test_no_arbitrary_commands(self):
        for kind, target in [('shell', 'bash'), ('static', '/bin/sh'), ('emit', 'web'),
                             ('typecheck', '../secret'), ('test', 'package.json')]:
            with self.assertRaises(ValueError):
                runner.command_for(kind, target)

    def test_bounded_compilers_and_qualification_noemit(self):
        for target in ('db', 'qualification'):
            command, _, heap = runner.command_for('typecheck', target)
            self.assertEqual(heap, 640)
            self.assertIn('--noEmit', command)
            self.assertNotIn('pnpm', command)
        with self.assertRaises(ValueError):
            runner.command_for('emit', 'qualification')

    def test_zero_timeout_waits_without_runner_cap(self):
        child = Mock(returncode=0)
        child.wait.return_value = 0
        self.assertEqual(runner.wait_for_check(child, 0), (0, False))
        child.wait.assert_called_once_with(timeout=None)

    def test_timeout_escalates_only_owned_group_and_reaps(self):
        child = Mock(pid=123, returncode=-9)
        child.wait.side_effect = [runner.subprocess.TimeoutExpired('fixture', 1),
                                 runner.subprocess.TimeoutExpired('fixture', 5), -9]
        with patch.object(runner.os, 'killpg') as kill:
            self.assertEqual(runner.wait_for_check(child, 1), (124, True))
        self.assertEqual([call.args for call in kill.call_args_list], [(123, runner.signal.SIGTERM), (123, runner.signal.SIGKILL)])
        self.assertEqual(child.returncode, -9)

    def test_shutdown_exit_race_still_reaps(self):
        child = Mock(pid=123, returncode=0)
        child.wait.return_value = 0
        with patch.object(runner.os, 'killpg', side_effect=ProcessLookupError) as kill:
            runner.stop_owned_child(child)
        self.assertEqual(kill.call_count, 2)
        self.assertEqual(child.wait.call_count, 2)

    def test_no_real_environment_inherited(self):
        values = runner.synthetic_environment('build-unit', 512)
        self.assertEqual(values['TRADING_MODE'], 'paper')
        self.assertEqual(values['LIVE_ENABLED_CHAINS'], '')
        self.assertIn('--max-old-space-size=512', values['NODE_OPTIONS'])
        self.assertIn('--require=', values['NODE_OPTIONS'])
        self.assertNotIn('PRIVATE_KEY', values)

    def test_reviewed_config_inventory_still_required_by_planner(self):
        command, _, heap = runner.command_for('test', 'threats/build-completion-20261116-sequential/api-baseline.config.ts')
        self.assertEqual(heap, 512)
        self.assertIn('--config', command)

    def test_names_inventory_matches_current_template(self):
        command, inputs, _ = runner.command_for('static', 'env')
        self.assertIn('--names-file', command)
        self.assertIn(runner.ROOT / '.env.example', inputs)

    def test_inherited_lock_reuses_open_file_description(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(runner, 'LOCK', Path(directory) / 'checks.lock'):
            with runner.LOCK.open('a') as outer:
                fcntl.flock(outer, fcntl.LOCK_EX)
                with runner.verification_lock() as inner:
                    fcntl.flock(inner, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    self.assertNotEqual(outer.fileno(), inner.fileno())
                    self.assertEqual(os.fstat(outer.fileno()).st_ino, os.fstat(inner.fileno()).st_ino)

    def test_external_paths_rejected(self):
        with self.assertRaises(ValueError):
            runner.confined(Path('/usr/bin/node'))


if __name__ == '__main__':
    unittest.main()
