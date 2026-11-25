"""Keyless runner unit tests. Children/affinity/signals are mocked; no compiler."""
import contextlib
import fcntl
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import Mock, patch

def load_bound_runner_source(path):
    # Loader caches are excluded inputs; execute only the bound source bytes.
    module = ModuleType('bounded_runner')
    module.__file__ = str(path)
    exec(compile(path.read_bytes(), str(path), 'exec', dont_inherit=True), module.__dict__)
    return module


SCRIPT = Path(__file__).resolve().with_name('build-completion-runner.py')
runner = load_bound_runner_source(SCRIPT)


def owned_child(pid=123, code=0):
    child = Mock(pid=pid, returncode=None, actual_exit_code=code)
    def reap():
        child.returncode = code
        return code
    child.wait.side_effect = reap
    return child


def exit_status(pid, code=0):
    return SimpleNamespace(si_pid=pid, si_code=runner.os.CLD_EXITED if code >= 0 else runner.os.CLD_KILLED,
                           si_status=code if code >= 0 else -code)


class SourceLoaderTests(unittest.TestCase):
    def test_bound_source_bypasses_existing_bytecode_and_observes_source_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            script = root / 'runner.py'
            script.write_text('value = "bound source"\n')
            cache = root / '__pycache__'
            cache.mkdir()
            cached = cache / 'runner.cpython-312.pyc'
            stale = b'unbound cached bytes'
            cached.write_bytes(stale)
            module = load_bound_runner_source(script)
            self.assertEqual(module.value, 'bound source')
            self.assertEqual(module.__file__, str(script))
            script.write_text('value = "new bound source"\n')
            self.assertEqual(load_bound_runner_source(script).value, 'new bound source')
            self.assertEqual(cached.read_bytes(), stale)
            self.assertEqual(list(cache.iterdir()), [cached])

    def test_bound_source_does_not_create_bytecode_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            script = root / 'runner.py'
            script.write_text('value = 7\n')
            self.assertEqual(load_bound_runner_source(script).value, 7)
            self.assertEqual(list(root.iterdir()), [script])


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
        return owned_child(pid=456, code=code)

    @contextlib.contextmanager
    def attempt_mocks(self, child=None, snapshot=None):
        script = self.put('scripts/check.py', '# fixture')
        child = child or self.fake_child()
        # The fixture runner path matches the input hashing contract, without reading real source twice.
        with patch.object(runner, '__file__', str(self.root / 'scripts/build-completion-runner.py')), \
             patch.object(runner, 'command_for', return_value=(['/usr/bin/python3', str(script)], [script], 512)) as plan, \
             patch.object(runner, 'workspace_inputs', return_value=snapshot or {'source': 'stable'}) as inputs, \
             patch.object(runner.subprocess, 'Popen', return_value=child) as launch, \
             patch.object(runner.os, 'waitid', side_effect=lambda *_: exit_status(child.pid, child.actual_exit_code)), \
             patch.object(runner.os, 'killpg') as kill, \
             patch.object(runner, 'live_group_members', return_value=set()), \
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

    def test_generated_reports_are_only_direct_regular_declared_outputs(self):
        directories = ['threats/build-completion-20261116-sequential',
                       'threats/project-completion-20261117']
        # Create the declared directory identities before comparing manifests.
        for directory in directories:
            (self.root / directory).mkdir(exist_ok=True)
        before = runner.workspace_inputs()
        for directory in directories:
            for suffix in ('.json', '.log'):
                self.put(directory + '/build-generated' + suffix)
        self.assertEqual(before, runner.workspace_inputs())

        names = ['threats/other/build-source.json', 'threats/other/build-source.log',
                 'tests/build-fixture.json', 'scripts/build-source.log',
                 'threats/project-completion-20261117/fixtures/build-nested.json',
                 'threats/build-completion-20261116-sequential/fixtures/build-nested.log',
                 'threats/project-completion-20261117/build-config.config.ts',
                 'threats/project-completion-20261117/not-build.json',
                 'threats/project-completion-20261117/build-directory.json/build-source.log']
        for name in names:
            self.put(name)
        linked = 'threats/project-completion-20261117/build-linked.json'
        (self.root / linked).symlink_to(self.root / 'tests/build-fixture.json')
        snapshot = runner.workspace_inputs()
        self.assertTrue(set(names + [linked]).issubset(snapshot))
        self.assertIn('threats/project-completion-20261117/build-directory.json/', snapshot)
        self.assertIsInstance(snapshot[linked], dict)
        for name in names:
            with self.subTest(name=name):
                path = self.root / name
                original = path.read_text()
                path.write_text(original + ' changed')
                self.assertNotEqual(snapshot, runner.workspace_inputs())
                path.write_text(original)

    def test_source_symlink_binds_excluded_evidence_bytes_and_modes(self):
        target_name = 'threats/project-completion-20261117/build-generated.json'
        target = self.put(target_name, 'consumed evidence fixture')
        target.chmod(0o644)
        unrelated_name = 'threats/project-completion-20261117/build-unrelated.log'
        unrelated = self.put(unrelated_name, 'ordinary generated evidence')
        link_name = 'scripts/build-fixture.json'
        link = self.root / link_name
        link.symlink_to(target)
        before = runner.workspace_inputs()
        self.assertIsInstance(before[link_name], dict)
        self.assertEqual(before[target_name], runner.digest(target))
        self.assertEqual(before[target_name + '#mode'], 0o644)
        self.assertNotIn(unrelated_name, before)
        self.assertNotIn(unrelated_name + '#mode', before)
        link.unlink()
        direct = runner.workspace_inputs()
        self.assertNotIn(target_name, direct)
        self.assertNotIn(target_name + '#mode', direct)
        link.symlink_to(target)
        before = runner.workspace_inputs()
        unrelated.write_text('unrelated generated output changed')
        self.assertEqual(before, runner.workspace_inputs())
        target.write_text('consumed evidence changed')
        changed = runner.workspace_inputs()
        self.assertNotEqual(before, changed)
        self.assertNotEqual(before[target_name], changed[target_name])
        target.chmod(0o600)
        mode_changed = runner.workspace_inputs()
        self.assertNotEqual(changed, mode_changed)
        self.assertEqual(mode_changed[target_name + '#mode'], 0o600)

    def test_excluded_symlink_target_mutation_rejects_command_binding(self):
        target_name = 'threats/project-completion-20261117/build-generated.json'
        consumed = self.put(target_name, 'approved consumed bytes')
        (self.root / 'scripts/build-fixture.json').symlink_to(consumed)
        unrelated = self.put('threats/project-completion-20261117/build-unrelated.json', '{}')
        target, binding = self.approve()
        approved = runner.workspace_inputs('test', target)
        self.assertEqual(binding['inputSha256'][target_name], runner.digest(consumed))
        runner.validate_approval('test', target, approved)
        unrelated.write_text('{"generated": "changed"}')
        self.assertEqual(approved, runner.workspace_inputs('test', target))
        runner.validate_approval('test', target, runner.workspace_inputs('test', target))
        consumed.write_text('unapproved consumed bytes')
        changed = runner.workspace_inputs('test', target)
        self.assertNotEqual(approved, changed)
        with self.assertRaisesRegex(ValueError, 'complete input closure'):
            runner.validate_approval('test', target, changed)

    def test_excluded_symlink_chain_records_intermediate_link_and_target(self):
        target_name = 'threats/project-completion-20261117/build-generated.json'
        target = self.put(target_name, 'consumed chain bytes')
        chain_name = 'threats/project-completion-20261117/tmp/build-chain.json'
        chain = self.put(chain_name)
        chain.unlink()
        chain.symlink_to('../build-generated.json')
        (self.root / 'scripts/build-fixture.json').symlink_to(chain)
        before = runner.workspace_inputs()
        self.assertEqual(before[chain_name]['symlink'], '../build-generated.json')
        self.assertEqual(before[chain_name]['target'], target_name)
        self.assertIn(chain_name + '#mode', before)
        self.assertEqual(before[target_name], runner.digest(target))
        chain.unlink()
        chain.symlink_to('.././build-generated.json')
        changed = runner.workspace_inputs()
        self.assertEqual(before[target_name], changed[target_name])
        self.assertNotEqual(before[chain_name], changed[chain_name])
        target.write_text('changed chain bytes')
        self.assertNotEqual(changed, runner.workspace_inputs())

    def test_symlink_target_parent_link_is_bound_outside_source_roots(self):
        target_name = 'threats/project-completion-20261117/build-generated.json'
        target = self.put(target_name, 'consumed through parent link')
        alias = self.root / '.fixture-alias'
        alias.symlink_to(target.parent, target_is_directory=True)
        (self.root / 'scripts/build-fixture.json').symlink_to(alias / target.name)
        before = runner.workspace_inputs()
        self.assertIn('.fixture-alias', before)
        self.assertIn('.fixture-alias#mode', before)
        self.assertEqual(before[target_name], runner.digest(target))
        alias.unlink()
        alias.symlink_to(str(target.parent) + '/.', target_is_directory=True)
        changed = runner.workspace_inputs()
        self.assertEqual(before[target_name], changed[target_name])
        self.assertNotEqual(before['.fixture-alias'], changed['.fixture-alias'])

    def test_consumed_directory_recurses_without_generated_exclusions(self):
        directory_name = 'threats/project-completion-20261117/tmp/consumed'
        names = [directory_name + '/build-generated.json',
                 directory_name + '/__pycache__/data.bin',
                 directory_name + '/node_modules/fixture/data.bin']
        for name in names:
            self.put(name, 'consumed directory bytes')
        directory = self.root / directory_name
        directory.chmod(0o755)
        self.put(directory_name + '/credentials.json', 'unreadable credential fixture')
        unrelated_name = 'threats/project-completion-20261117/tmp/unrelated/data.bin'
        unrelated = self.put(unrelated_name, 'unrelated excluded bytes')
        link_name = 'scripts/build-fixtures.json'
        (self.root / link_name).symlink_to(directory, target_is_directory=True)
        before = runner.workspace_inputs()
        self.assertIsInstance(before[link_name], dict)
        self.assertTrue(set(names).issubset(before))
        self.assertIn(directory_name + '/', before)
        self.assertIn(directory_name + '/__pycache__/', before)
        self.assertIn(directory_name + '/node_modules/', before)
        self.assertEqual(before[directory_name + '#mode'], 0o755)
        self.assertNotIn(directory_name + '/credentials.json', before)
        self.assertNotIn(unrelated_name, before)
        unrelated.write_text('still unrelated')
        self.assertEqual(before, runner.workspace_inputs())
        for name in names:
            with self.subTest(name=name):
                path = self.root / name
                original = path.read_text()
                path.write_text(original + ' changed')
                self.assertNotEqual(before, runner.workspace_inputs())
                path.write_text(original)
        added = self.put(directory_name + '/new.fixture')
        after = runner.workspace_inputs()
        self.assertNotEqual(before, after)
        added.unlink()
        self.assertEqual(before, runner.workspace_inputs())
        directory.chmod(0o700)
        self.assertNotEqual(before, runner.workspace_inputs())

    def test_resolution_probe_symlink_binds_excluded_target_directory(self):
        directory_name = 'threats/project-completion-20261117/tmp/installed-fixture'
        metadata_name = directory_name + '/package.json'
        data_name = directory_name + '/__pycache__/data.bin'
        self.put(metadata_name, '{}')
        data = self.put(data_name, 'consumed installed target bytes')
        (self.root / 'node_modules/fixture').symlink_to(self.root / directory_name, target_is_directory=True)
        before = runner.workspace_inputs()
        self.assertIsInstance(before['node_modules/fixture'], dict)
        self.assertIn(metadata_name, before)
        self.assertEqual(before[data_name], runner.digest(data))
        data.write_text('changed installed target bytes')
        self.assertNotEqual(before, runner.workspace_inputs())

    def test_consumed_evidence_directory_binds_direct_generated_children(self):
        name = 'threats/project-completion-20261117/build-generated.json'
        consumed = self.put(name, 'consumed directory evidence')
        unrelated_name = 'threats/build-completion-20261116-sequential/build-unrelated.log'
        unrelated = self.put(unrelated_name)
        (self.root / 'scripts/build-fixtures.json').symlink_to(consumed.parent, target_is_directory=True)
        before = runner.workspace_inputs()
        self.assertEqual(before[name], runner.digest(consumed))
        self.assertNotIn(unrelated_name, before)
        unrelated.write_text('unrelated evidence mutation')
        self.assertEqual(before, runner.workspace_inputs())
        consumed.write_text('consumed directory evidence mutation')
        self.assertNotEqual(before, runner.workspace_inputs())

    def test_consumed_excluded_targets_still_fail_closed(self):
        directory = self.root / 'threats/project-completion-20261117/tmp/consumed'
        directory.mkdir(parents=True)
        link = self.root / 'scripts/build-fixtures.json'
        link.symlink_to(directory, target_is_directory=True)
        nested = directory / 'nested-link'
        cases = [(directory, ValueError),
                 (directory / 'missing', FileNotFoundError),
                 (Path('/outside-workspace'), (FileNotFoundError, ValueError)),
                 (self.put('tests/credentials.json', 'unreadable credential fixture'), ValueError)]
        for target, error in cases:
            with self.subTest(target=str(target)):
                nested.symlink_to(target)
                with self.assertRaises(error):
                    runner.workspace_inputs()
                nested.unlink()
        chain = directory / 'chain'
        chain.symlink_to(link)
        link.unlink()
        link.symlink_to(chain)
        with self.assertRaises((ValueError, RuntimeError, OSError)):
            runner.workspace_inputs()

    def test_consumed_mode_key_collision_refused_in_both_orders(self):
        base_name = 'threats/project-completion-20261117/tmp/payload'
        payload = self.put(base_name, 'ordinary consumed bytes')
        hostile = self.root / (base_name + '#mode')
        unrelated_names = ['threats/project-completion-20261117/tmp/unrelated.bin',
                           'threats/project-completion-20261117/build-unrelated.log']
        unrelated = [self.put(name, 'ordinary excluded evidence') for name in unrelated_names]
        other = self.put('threats/project-completion-20261117/tmp/other', 'symlink target bytes')
        for kind in ('file', 'directory', 'symlink'):
            for hostile_first in (True, False):
                with self.subTest(kind=kind, hostile_first=hostile_first):
                    if kind == 'file':
                        hostile.write_text('hostile consumed bytes')
                    elif kind == 'directory':
                        hostile.mkdir()
                    else:
                        hostile.symlink_to(other)
                    baseline = runner.workspace_inputs()
                    for name in [base_name, base_name + '#mode', *unrelated_names]:
                        self.assertNotIn(name, baseline)
                    for path in unrelated:
                        path.write_text('unrelated evidence changed')
                    self.assertEqual(baseline, runner.workspace_inputs())
                    targets = (hostile, payload) if hostile_first else (payload, hostile)
                    links = [self.root / 'scripts/a-consumer', self.root / 'scripts/z-consumer']
                    for link, destination in zip(links, targets):
                        link.symlink_to(destination)
                    with self.assertRaisesRegex(ValueError, 'Input manifest collision'):
                        runner.workspace_inputs()
                    if kind == 'file':
                        hostile.write_text('mutated hostile consumed bytes')
                        with self.assertRaisesRegex(ValueError, 'Input manifest collision'):
                            runner.workspace_inputs()
                    for link in links:
                        link.unlink()
                    if kind == 'directory':
                        hostile.rmdir()
                    else:
                        hostile.unlink()

    def test_metadata_looking_filenames_are_not_silently_skipped(self):
        names = ['scripts/standalone#mode', 'scripts/standalone#canonical',
                 'scripts/standalone#absent', 'scripts/runtime:fixture']
        for name in names:
            self.put(name, 'ordinary source bytes')
        consumed_name = 'threats/project-completion-20261117/tmp/payload#mode'
        consumed = self.put(consumed_name, 'unambiguous consumed bytes')
        (self.root / 'scripts/a-consumer').symlink_to(consumed)
        before = runner.workspace_inputs()
        for name in [*names, consumed_name]:
            self.assertEqual(before[name], runner.digest(self.root / name))
            self.assertIn(name + '#mode', before)
        consumed.write_text('changed unambiguous consumed bytes')
        self.assertNotEqual(before, runner.workspace_inputs())

    def test_identical_consumed_target_recapture_preserves_mixed_manifest(self):
        name = 'threats/project-completion-20261117/tmp/payload'
        payload = self.put(name, 'repeated consumed bytes')
        payload.chmod(0o644)
        link_names = ['scripts/a-consumer', 'scripts/z-consumer']
        for link_name in link_names:
            (self.root / link_name).symlink_to(payload)
        unrelated = self.put('threats/project-completion-20261117/build-unrelated.json', '{}')
        before = runner.workspace_inputs()
        self.assertEqual(before[name], runner.digest(payload))
        self.assertIs(type(before[name + '#mode']), int)
        self.assertEqual(before[name + '#mode'], 0o644)
        for link_name in link_names:
            self.assertIs(type(before[link_name]), dict)
            self.assertEqual(before[link_name]['target'], name)
        self.assertTrue(any(type(value) is dict and value.get('directory') is True
                            for value in before.values()))
        self.assertTrue(any(key.endswith('#absent') and value is True for key, value in before.items()))
        self.assertTrue(runner.manifest_equal(before, runner.workspace_inputs()))
        unrelated.write_text('changed unrelated evidence')
        self.assertTrue(runner.manifest_equal(before, runner.workspace_inputs()))
        payload.write_text('changed repeated consumed bytes')
        self.assertFalse(runner.manifest_equal(before, runner.workspace_inputs()))

    def test_source_root_absent_key_collision_refused_in_both_orders(self):
        missing = 'scripts/missing-root'
        self.put(missing + '#absent', 'actual source bytes')
        policy = json.loads(self.policy.read_text())
        for roots in ([missing, 'scripts'], ['scripts', missing]):
            with self.subTest(roots=roots):
                policy['sourceRoots'] = roots
                self.policy.write_text(json.dumps(policy))
                with self.assertRaisesRegex(ValueError, 'Input manifest collision'):
                    runner.workspace_inputs()

    def test_installed_resolution_absent_key_collision_refused(self):
        package = self.install('fixture')
        (package / 'package.json').write_text(json.dumps({'optionalDependencies': {'missing': '*'}}))
        self.put(str((package / 'node_modules/missing#absent').relative_to(self.root)), 'hostile resolution bytes')
        with self.assertRaisesRegex(ValueError, 'Input manifest collision'):
            runner.workspace_inputs()

    def test_canonical_key_collision_with_parent_alias_refused_in_both_orders(self):
        directory = self.root / 'threats/project-completion-20261117/tmp/targets'
        self.put(str((directory / 'payload').relative_to(self.root)), 'consumed bytes')
        self.put(str((directory / 'payload#canonical').relative_to(self.root)), 'hostile canonical bytes')
        alias = self.root / '.fixture-alias'
        alias.symlink_to(directory, target_is_directory=True)
        names = ['.fixture-alias/payload', '.fixture-alias/payload#canonical']
        policy = json.loads(self.policy.read_text())
        original = list(policy['installedMetadata'])
        for probes in (names, list(reversed(names))):
            with self.subTest(probes=probes):
                policy['installedMetadata'] = original + probes
                self.policy.write_text(json.dumps(policy))
                with self.assertRaisesRegex(ValueError, 'Input manifest collision'):
                    runner.workspace_inputs()

    def test_runtime_key_collision_with_actual_workspace_path_refused(self):
        runtime = self.put('runtime-fixture', 'inert runtime bytes')
        actual_name = 'runtime:' + str(runtime)
        self.put(actual_name, 'hostile workspace bytes')
        policy = json.loads(self.policy.read_text())
        policy['sourceRoots'].append('runtime:')
        policy['runtimePaths'] = [str(runtime)]
        self.policy.write_text(json.dumps(policy))
        with self.assertRaisesRegex(ValueError, 'Input manifest collision'):
            runner.workspace_inputs()

    def test_collision_refuses_approval_generation_and_admission_without_child(self):
        target, _ = self.approve()
        inventory = self.out / 'reviewed-configs.json'
        historical_bytes = inventory.read_bytes()
        payload_name = 'threats/project-completion-20261117/tmp/payload'
        payload = self.put(payload_name, 'consumed bytes')
        hostile = self.put(payload_name + '#mode', 'hostile consumed bytes')
        a = self.root / 'scripts/a-consumer'
        z = self.root / 'scripts/z-consumer'
        with patch.object(runner.subprocess, 'Popen') as launch, \
             patch.object(runner, '__file__', str(self.root / 'scripts/build-completion-runner.py')), \
             patch.object(runner, 'command_for', return_value=(['inert-command'], [self.guard], 512)), \
             patch.object(runner.os, 'sched_getaffinity', return_value={0}), \
             contextlib.redirect_stdout(io.StringIO()):
            for hostile_first in (True, False):
                with self.subTest(hostile_first=hostile_first):
                    a.symlink_to(hostile if hostile_first else payload)
                    z.symlink_to(payload if hostile_first else hostile)
                    with self.assertRaisesRegex(ValueError, 'Input manifest collision'):
                        runner.approval_binding(target)
                    with self.assertRaisesRegex(ValueError, 'Input manifest collision'):
                        runner.validate_approval('test', target, runner.workspace_inputs('test', target))
                    label = 'build-collision-' + str(hostile_first)
                    self.assertEqual(runner.execute_attempt(self.options('test', target, label)), 125)
                    record = self.record(label)
                    self.assertIsNone(record['childExitCode'])
                    self.assertTrue(any(item['phase'] == 'planning-or-launch-or-wait'
                                        and 'Input manifest collision' in item['message']
                                        for item in record['diagnostics']))
                    self.assertEqual(inventory.read_bytes(), historical_bytes)
                    a.unlink()
                    z.unlink()
            launch.assert_not_called()

    def test_approval_rejects_bool_int_and_float_identity_substitution(self):
        target, _ = self.approve()
        inventory = self.out / 'reviewed-configs.json'
        original = json.loads(inventory.read_text())
        identities = original['commandBindings'][target]['inputSha256']
        mode_key = next(key for key, value in identities.items() if key.endswith('#mode') and type(value) is int)
        absent_key = next(key for key, value in identities.items() if key.endswith('#absent') and value is True)
        directory_key = next(key for key, value in identities.items()
                             if key.endswith('/') and type(value) is dict and value.get('directory') is True)
        for key, value in [(mode_key, float(identities[mode_key])), (absent_key, 1),
                           (directory_key, {'directory': 1})]:
            with self.subTest(key=key):
                altered = json.loads(json.dumps(original))
                altered['commandBindings'][target]['inputSha256'][key] = value
                inventory.write_text(json.dumps(altered))
                with self.assertRaisesRegex(ValueError, 'complete input closure'):
                    runner.validate_approval('test', target, runner.workspace_inputs('test', target))
        inventory.write_text(json.dumps(original))
        runner.validate_approval('test', target, runner.workspace_inputs('test', target))

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

    def test_typed_manifest_drift_before_launch_no_child(self):
        with self.attempt_mocks() as (_, _, inputs, launch, _):
            inputs.side_effect = [{'probe#absent': True}, {'probe#absent': 1}, {'probe#absent': True}]
            self.assertEqual(runner.execute_attempt(self.options()), 125)
            launch.assert_not_called()
        self.assertIsNone(self.record()['childExitCode'])

    def test_typed_manifest_drift_after_run_not_accepted(self):
        with self.attempt_mocks() as (_, _, inputs, _, _):
            inputs.side_effect = [{'probe#absent': True}, {'probe#absent': True}, {'probe#absent': 1}]
            self.assertEqual(runner.execute_attempt(self.options()), 125)
        record = self.record()
        self.assertEqual(record['childExitCode'], 0)
        self.assertFalse(record['workspaceInputsUnchanged'])
        self.assertTrue(any(item['phase'] == 'postrun-inputs' for item in record['diagnostics']))

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
        with self.attempt_mocks(child), \
             patch.object(runner.os, 'waitid', side_effect=[None, exit_status(child.pid, -15),
                                                         exit_status(child.pid, -15), exit_status(child.pid, -15),
                                                         exit_status(child.pid, -15)]), \
             patch.object(runner.time, 'monotonic', side_effect=[0, 0, 2, 2, 3]):
            options = self.options()
            options.timeout_seconds = 1
            self.assertEqual(runner.execute_attempt(options), 124)
        record = self.record()
        self.assertEqual(record['childExitCode'], -15)
        self.assertTrue(record['timedOut'])
        child.wait.assert_called_once_with()

    def test_wait_exception_shutdown_reaps_actual_child_not_synthetic_125(self):
        child = self.fake_child(7)
        with self.attempt_mocks(child), \
             patch.object(runner.os, 'waitid', side_effect=[OSError('observation refused'),
                                                         exit_status(child.pid, 7), exit_status(child.pid, 7),
                                                         exit_status(child.pid, 7), exit_status(child.pid, 7)]):
            self.assertEqual(runner.execute_attempt(self.options()), 125)
        record = self.record()
        self.assertEqual(record['childExitCode'], 7)
        self.assertFalse(record['timedOut'])
        self.assertTrue(any(item['phase'] == 'planning-or-launch-or-wait' for item in record['diagnostics']))
        child.wait.assert_called_once_with()

    def test_shutdown_signal_error_finalizes_actual_child_not_synthetic_125(self):
        child = self.fake_child(0)
        with self.attempt_mocks(child) as (_, _, _, _, kill):
            kill.side_effect = [OSError('TERM refused'), None]
            self.assertEqual(runner.execute_attempt(self.options()), 125)
        record = self.record()
        self.assertEqual(record['childExitCode'], 0)
        self.assertTrue(any(item['phase'] == 'owned-child-shutdown' for item in record['diagnostics']))
        child.wait.assert_called_once_with()

    def test_actual_child_124_or_125_is_not_a_synthetic_timeout(self):
        for code in (124, 125):
            with self.subTest(code=code), self.attempt_mocks(self.fake_child(code)):
                label = 'build-child-' + str(code)
                self.assertEqual(runner.execute_attempt(self.options(label=label)), code)
                record = self.record(label)
                self.assertEqual(record['childExitCode'], code)
                self.assertFalse(record['timedOut'])
                self.assertEqual(record['diagnostics'], [])

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
    def test_manifest_guard_retains_identical_recapture_for_every_form(self):
        captures = [
            ('scripts/payload', 'file', 'digest', runner.stat.S_IFREG),
            ('scripts/payload', 'mode', 0o644, runner.stat.S_IFREG),
            ('scripts/link', 'symlink', {'symlink': 'payload', 'target': 'scripts/payload',
                                       'device': 1, 'inode': 2}, runner.stat.S_IFLNK),
            ('scripts/directory', 'directory', {'directory': True}, runner.stat.S_IFDIR),
            ('scripts/alias/payload', 'canonical', 'scripts/payload', runner.stat.S_IFREG),
            ('scripts/missing', 'absent', True, None),
            ('/inert/runtime', 'runtime', {'sha256': 'digest', 'target': '/inert/runtime'}, None),
        ]
        manifest = runner.InputManifest()
        for name, form, value, kind in captures:
            with self.subTest(form=form):
                if kind is not None:
                    manifest.claim_path(name, kind)
                manifest.record(name, form, value)
                before = dict(manifest.entries)
                if kind is not None:
                    manifest.claim_path(name, kind)
                manifest.record(name, form, json.loads(json.dumps(value)))
                self.assertTrue(runner.manifest_equal(before, manifest.entries))

    def test_manifest_guard_rejects_metadata_path_aliases_in_both_orders(self):
        cases = [('scripts/payload', 'mode', 0o644),
                 ('scripts/payload', 'canonical', 'scripts/target'),
                 ('scripts/payload', 'absent', True),
                 ('/inert/runtime', 'runtime', {'sha256': 'digest', 'target': '/inert/runtime'})]
        for name, form, value in cases:
            key = 'runtime:' + name if form == 'runtime' else name + runner.InputManifest.SUFFIXES[form]
            for path_first in (True, False):
                for kind in (runner.stat.S_IFREG, runner.stat.S_IFDIR, runner.stat.S_IFLNK):
                    with self.subTest(form=form, path_first=path_first, kind=kind):
                        manifest = runner.InputManifest()
                        if path_first:
                            manifest.claim_path(key, kind)
                            with self.assertRaisesRegex(ValueError, 'Input manifest collision'):
                                manifest.record(name, form, value)
                        else:
                            manifest.record(name, form, value)
                            with self.assertRaisesRegex(ValueError, 'Input manifest collision'):
                                manifest.claim_path(key, kind)

    def test_manifest_guard_rejects_conflicting_provenance_even_when_values_match(self):
        cases = [
            (('scripts/payload', 'mode', 1), ('scripts/payload#mode', 'file', 1)),
            (('scripts/payload', 'canonical', 'target'), ('scripts/payload#canonical', 'file', 'target')),
            (('scripts/payload', 'absent', True), ('scripts/payload#absent', 'file', True)),
            (('scripts/directory', 'directory', {'directory': True}),
             ('scripts/directory/', 'symlink', {'directory': True})),
            (('/inert/runtime', 'runtime', {'sha256': 'same'}),
             ('runtime:/inert/runtime', 'symlink', {'sha256': 'same'})),
            (('scripts/payload', 'file', 'same'), ('scripts/payload', 'symlink', 'same')),
        ]
        # The trailing-slash case is guard-level only: filesystem paths cannot
        # retain a final '/' as a distinct filename. Provenance still guards it.
        for first, second in cases:
            for captures in ((first, second), (second, first)):
                with self.subTest(captures=captures):
                    manifest = runner.InputManifest()
                    manifest.record(*captures[0])
                    before = dict(manifest.entries)
                    with self.assertRaisesRegex(ValueError, 'Input manifest collision'):
                        manifest.record(*captures[1])
                    self.assertTrue(runner.manifest_equal(before, manifest.entries))

    def test_manifest_guard_rejects_conflicting_values_types_and_path_kinds(self):
        cases = [('file', 'digest', 'changed digest'), ('mode', 1, True), ('mode', 1, 1.0),
                 ('absent', True, 1), ('directory', {'directory': True}, {'directory': 1}),
                 ('symlink', {'device': 1, 'inode': 2}, {'device': True, 'inode': 2}),
                 ('canonical', 'target', 'changed target'),
                 ('runtime', {'sha256': 'digest', 'target': '/inert'},
                  {'sha256': 'changed digest', 'target': '/inert'})]
        for form, first, second in cases:
            with self.subTest(form=form):
                manifest = runner.InputManifest()
                manifest.record('inert', form, first)
                before = dict(manifest.entries)
                with self.assertRaisesRegex(ValueError, 'conflicting recapture'):
                    manifest.record('inert', form, second)
                self.assertTrue(runner.manifest_equal(before, manifest.entries))
        manifest = runner.InputManifest()
        manifest.claim_path('scripts/payload', runner.stat.S_IFREG)
        with self.assertRaisesRegex(ValueError, 'Input manifest collision'):
            manifest.claim_path('scripts/payload', runner.stat.S_IFDIR)
        for absent_first in (True, False):
            with self.subTest(absent_first=absent_first):
                manifest = runner.InputManifest()
                if absent_first:
                    manifest.record('scripts/payload', 'absent', True)
                    with self.assertRaisesRegex(ValueError, 'Input manifest collision'):
                        manifest.claim_path('scripts/payload', runner.stat.S_IFREG)
                else:
                    manifest.claim_path('scripts/payload', runner.stat.S_IFREG)
                    with self.assertRaisesRegex(ValueError, 'Input manifest collision'):
                        manifest.record('scripts/payload', 'absent', True)

    def test_manifest_equality_is_recursive_and_type_strict(self):
        original = {'file': 'digest', 'file#mode': 1, 'missing#absent': True,
                    'directory/': {'directory': True}, 'link': {'device': 1, 'inode': 2},
                    'runtime:/inert': {'sha256': 'digest', 'target': '/inert'},
                    'nested': [True, {'mode': 1}]}
        copy = json.loads(json.dumps(original))
        self.assertTrue(runner.manifest_equal(original, dict(reversed(list(copy.items())))))
        for key, value in [('file#mode', True), ('file#mode', 1.0), ('missing#absent', 1),
                           ('directory/', {'directory': 1}), ('link', {'device': True, 'inode': 2}),
                           ('nested', [1, {'mode': 1}]), ('nested', [True, {'mode': 1.0}])]:
            with self.subTest(key=key, value=value):
                changed = dict(original)
                changed[key] = value
                self.assertEqual(original, changed)  # Python's loose equality is insufficient.
                self.assertFalse(runner.manifest_equal(original, changed))
                self.assertFalse(runner.manifest_equal(changed, original))
        self.assertFalse(runner.manifest_equal(original, {**original, 'extra': 'digest'}))
        self.assertFalse(runner.manifest_equal(original, []))

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

    def test_zero_timeout_observes_without_cap_signal_or_reap(self):
        child = owned_child()
        with patch.object(runner.os, 'waitid', return_value=exit_status(child.pid)) as observe, \
             patch.object(runner.os, 'killpg') as kill:
            self.assertEqual(runner.wait_for_check(child, 0), (0, False))
        observe.assert_called_once_with(runner.os.P_PID, child.pid, runner.os.WEXITED | runner.os.WNOWAIT)
        child.wait.assert_not_called()
        child.poll.assert_not_called()
        kill.assert_not_called()
        self.assertIsNone(child.returncode)

    def test_bounded_wait_observes_exit_without_reap(self):
        child = owned_child(code=7)
        with patch.object(runner.os, 'waitid', side_effect=[None, exit_status(child.pid, 7)]) as observe, \
             patch.object(runner.time, 'monotonic', side_effect=[0, 0.25]), \
             patch.object(runner.time, 'sleep') as sleep:
            self.assertEqual(runner.wait_for_check(child, 1), (7, False))
        self.assertEqual([call.args for call in observe.call_args_list],
                         [(runner.os.P_PID, child.pid, runner.os.WEXITED | runner.os.WNOWAIT | runner.os.WNOHANG)] * 2)
        sleep.assert_called_once_with(0.05)
        child.wait.assert_not_called()
        self.assertIsNone(child.returncode)

    def test_timeout_retains_leader_through_escalation_then_reaps_once(self):
        child = owned_child(code=-9)
        events = []
        statuses = iter([None, None, None, None, exit_status(child.pid, -9)])
        def observe(which, pid, flags):
            self.assertIsNone(child.returncode)
            self.assertEqual((which, pid), (runner.os.P_PID, child.pid))
            self.assertTrue(flags & runner.os.WNOWAIT)
            events.append('observe')
            return next(statuses)
        def signal_group(pid, signum):
            self.assertEqual(pid, child.pid)
            self.assertIsNone(child.returncode)
            child.wait.assert_not_called()
            events.append(signum)
        def reap():
            self.assertEqual(events[-2:], [runner.signal.SIGKILL, 'observe'])
            events.append('reap')
            child.returncode = -9
            return -9
        child.wait.side_effect = reap
        with patch.object(runner.os, 'waitid', side_effect=observe), \
             patch.object(runner.os, 'killpg', side_effect=signal_group), \
             patch.object(runner, 'live_group_members', return_value=set()), \
             patch.object(runner.time, 'monotonic', side_effect=[0, 2, 2, 8]):
            self.assertEqual(runner.wait_for_check(child, 1), (124, True))
            child.wait.assert_not_called()
            self.assertIsNone(child.returncode)
            runner.stop_owned_child(child)
        self.assertEqual(events, ['observe', 'observe', runner.signal.SIGTERM, 'observe',
                                  'observe', runner.signal.SIGKILL, 'observe', 'reap'])
        child.wait.assert_called_once_with()
        child.poll.assert_not_called()
        self.assertEqual(child.returncode, -9)

    def test_completed_leader_retained_for_worker_signals_then_reaped(self):
        child = owned_child(code=7)
        def signal_group(pid, signum):
            self.assertEqual(pid, child.pid)
            self.assertIsNone(child.returncode)
            child.wait.assert_not_called()
        with patch.object(runner.os, 'waitid', return_value=exit_status(child.pid, 7)) as observe, \
             patch.object(runner.os, 'killpg', side_effect=signal_group) as kill, \
             patch.object(runner, 'live_group_members', return_value=set()):
            self.assertEqual(runner.wait_for_check(child, 0), (7, False))
            runner.stop_owned_child(child)
        self.assertEqual([call.args for call in kill.call_args_list],
                         [(child.pid, runner.signal.SIGTERM), (child.pid, runner.signal.SIGKILL)])
        self.assertTrue(all(call.args[2] & runner.os.WNOWAIT for call in observe.call_args_list))
        child.wait.assert_called_once_with()
        self.assertEqual(child.returncode, 7)

    def test_shutdown_group_absence_still_reaps_after_both_signal_attempts(self):
        child = owned_child()
        with patch.object(runner.os, 'waitid', return_value=exit_status(child.pid)), \
             patch.object(runner.os, 'killpg', side_effect=ProcessLookupError) as kill, \
             patch.object(runner, 'live_group_members', return_value=set()):
            runner.stop_owned_child(child)
        self.assertEqual(kill.call_count, 2)
        child.wait.assert_called_once_with()
        self.assertEqual(child.returncode, 0)

    def test_reaped_or_unowned_leader_never_signaled(self):
        for state in ('reaped', 'not-child', 'wrong-child'):
            with self.subTest(state=state):
                child = owned_child()
                if state == 'reaped':
                    child.returncode = 0
                with patch.object(runner.os, 'waitid') as observe, \
                     patch.object(runner.os, 'killpg') as kill, \
                     patch.object(runner, 'live_group_members', return_value=set()):
                    if state == 'not-child':
                        observe.side_effect = ChildProcessError('ECHILD')
                    else:
                        observe.return_value = exit_status(child.pid + 1)
                    with self.assertRaises(ChildProcessError):
                        runner.stop_owned_child(child)
                    kill.assert_not_called()
                    child.wait.assert_not_called()
                    if state == 'reaped':
                        observe.assert_not_called()

    def test_waitid_retries_eintr_and_preserves_signal_exit_status(self):
        for status_code in (runner.os.CLD_KILLED, runner.os.CLD_DUMPED):
            with self.subTest(status_code=status_code):
                child = owned_child(code=-9)
                observed = SimpleNamespace(si_pid=child.pid, si_code=status_code, si_status=9)
                with patch.object(runner.os, 'waitid', side_effect=[InterruptedError(), observed]) as observe:
                    self.assertEqual(runner.wait_for_check(child, 0), (-9, False))
                self.assertEqual(observe.call_count, 2)
                child.wait.assert_not_called()
                self.assertIsNone(child.returncode)

    def test_shutdown_wait_exception_still_signals_before_reap(self):
        child = owned_child(code=-9)
        with patch.object(runner.os, 'waitid', side_effect=[None, KeyboardInterrupt(), None,
                                                         exit_status(child.pid, -9)]), \
             patch.object(runner.os, 'killpg') as kill, \
             patch.object(runner, 'live_group_members', return_value=set()):
            with self.assertRaises(KeyboardInterrupt):
                runner.stop_owned_child(child)
        self.assertEqual([call.args for call in kill.call_args_list],
                         [(child.pid, runner.signal.SIGTERM), (child.pid, runner.signal.SIGKILL)])
        child.wait.assert_called_once_with()
        self.assertEqual(child.returncode, -9)

    def test_shutdown_signal_errors_still_attempt_kill_and_reap(self):
        for failures in ([OSError('TERM refused'), None], [None, OSError('KILL refused')]):
            with self.subTest(failures=failures):
                child = owned_child()
                with patch.object(runner.os, 'waitid', return_value=exit_status(child.pid)), \
                     patch.object(runner.os, 'killpg', side_effect=failures) as kill, \
                     patch.object(runner, 'live_group_members', return_value=set()):
                    with self.assertRaises(OSError):
                        runner.stop_owned_child(child)
                self.assertEqual(kill.call_count, 2)
                child.wait.assert_called_once_with()
                self.assertEqual(child.returncode, 0)

    def test_failed_kill_does_not_block_reaping_a_still_running_leader(self):
        child = owned_child(code=-9)
        with patch.object(runner.os, 'waitid', return_value=None), \
             patch.object(runner.os, 'killpg', side_effect=[None, OSError('KILL refused')]) as kill, \
             patch.object(runner, 'live_group_members', return_value=set()), \
             patch.object(runner.time, 'monotonic', side_effect=[0, 6]):
            with self.assertRaisesRegex(OSError, 'KILL refused'):
                runner.stop_owned_child(child)
        self.assertEqual(kill.call_count, 2)
        child.wait.assert_not_called()
        self.assertIsNone(child.returncode)

    def test_lost_retention_before_kill_refuses_signal_and_reap(self):
        child = owned_child()
        with patch.object(runner.os, 'waitid', side_effect=[exit_status(child.pid), exit_status(child.pid),
                                                         ChildProcessError('ECHILD')]), \
             patch.object(runner.os, 'killpg') as kill, \
             patch.object(runner, 'live_group_members', return_value=set()):
            with self.assertRaises(ChildProcessError):
                runner.stop_owned_child(child)
        kill.assert_called_once_with(child.pid, runner.signal.SIGTERM)
        child.wait.assert_not_called()

    def test_second_shutdown_after_reap_never_resignals(self):
        child = owned_child()
        with patch.object(runner.os, 'waitid', return_value=exit_status(child.pid)), \
             patch.object(runner.os, 'killpg') as kill, \
             patch.object(runner, 'live_group_members', return_value=set()):
            runner.stop_owned_child(child)
            with self.assertRaises(ChildProcessError):
                runner.stop_owned_child(child)
        self.assertEqual(kill.call_count, 2)
        child.wait.assert_called_once_with()

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

    def test_live_group_members_parses_stat_and_skips_leader_zombies_and_dead(self):
        with tempfile.TemporaryDirectory() as directory:
            proc = Path(directory)
            entries = {
                '100': '100 (leader) S 1 100 100 0 -1 0\n',
                '101': '101 (my (worker) 1) S 1 100 100 0 -1 0\n',
                '102': '102 (zombie) Z 1 100 100 0 -1 0\n',
                '103': '103 (dead) X 1 100 100 0 -1 0\n',
                '104': '104 (other-pg) S 1 999 999 0 -1 0\n',
            }
            for pid, content in entries.items():
                (proc / pid).mkdir()
                (proc / pid / 'stat').write_text(content)
            (proc / 'self').mkdir()
            real_path = Path
            with patch.object(runner, 'Path', side_effect=lambda p: proc if p == '/proc' else real_path(p)):
                self.assertEqual(runner.live_group_members(100, 100), {101})

    def test_stop_owned_child_grants_grace_only_when_live_workers_exist(self):
        child = owned_child(code=7)
        with patch.object(runner.os, 'waitid', return_value=exit_status(child.pid, 7)), \
             patch.object(runner.os, 'killpg') as kill, \
             patch.object(runner, 'live_group_members', side_effect=[{901}, {901}, set(), set()]) as live, \
             patch.object(runner.time, 'monotonic', side_effect=[0.0, 0.0, 0.1]), \
             patch.object(runner.time, 'sleep') as sleep:
            runner.stop_owned_child(child, grace_seconds=2)
        self.assertEqual(live.call_count, 4)
        sleep.assert_called_once_with(0.05)
        self.assertEqual([call.args for call in kill.call_args_list],
                         [(child.pid, signal.SIGTERM), (child.pid, signal.SIGKILL)])
        child.wait.assert_called_once_with()


class RealSubprocessReapingTests(unittest.TestCase):
    def _spawn_fork_group(self, script, extra_args=()):
        ready_r, ready_w = os.pipe()
        child = subprocess.Popen(
            [sys.executable, '-I', '-S', '-c', script, *extra_args, str(ready_w)],
            pass_fds=(ready_w,),
            start_new_session=True,
        )
        os.close(ready_w)
        def cleanup():
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            if child.returncode is None:
                try:
                    child.wait(timeout=2)
                except (OSError, subprocess.SubprocessError):
                    pass
        self.addCleanup(cleanup)
        chunks = []
        try:
            while True:
                chunk = os.read(ready_r, 64)
                if not chunk:
                    break
                chunks.append(chunk)
        finally:
            os.close(ready_r)
        worker_pid = int(b''.join(chunks).decode('ascii').strip())
        return child, worker_pid

    def test_real_linux_orphan_worker_gets_sigterm_grace_and_preserves_runner_pgid(self):
        runner_pgid = os.getpgrp()
        runner_sid = os.getsid(0)
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / 'worker.txt'
            script = (
                'import os, signal, sys, time\n'
                'marker_path, ready_fd = sys.argv[1], int(sys.argv[2])\n'
                'pid = os.fork()\n'
                'if pid == 0:\n'
                '    def handle_term(signum, frame):\n'
                '        with open(marker_path, "w") as handle:\n'
                '            handle.write("graceful\\n")\n'
                '        os._exit(0)\n'
                '    signal.signal(signal.SIGTERM, handle_term)\n'
                '    os.write(ready_fd, f"{os.getpid()}\\n".encode("ascii"))\n'
                '    os.close(ready_fd)\n'
                '    while True:\n'
                '        time.sleep(0.05)\n'
                'os.close(ready_fd)\n'
                'os._exit(7)\n'
            )
            child, worker_pid = self._spawn_fork_group(script, (str(marker),))
            self.assertEqual(runner.wait_for_check(child, 5), (7, False))
            self.assertIsNone(child.returncode)
            retained = os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOWAIT | os.WNOHANG)
            self.assertIsNotNone(retained)
            self.assertEqual(retained.si_pid, child.pid)
            self.assertEqual(retained.si_status, 7)
            live = runner.live_group_members(child.pid, child.pid)
            self.assertIn(worker_pid, live)
            self.assertNotIn(child.pid, live)

            runner.stop_owned_child(child, grace_seconds=2)

            self.assertEqual(marker.read_text(), 'graceful\n')
            self.assertEqual(child.returncode, 7)
            with self.assertRaises(ChildProcessError):
                os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG)
            self.assertEqual(runner.live_group_members(child.pid, child.pid), set())
            self.assertEqual(os.getpgrp(), runner_pgid)
            self.assertEqual(os.getsid(0), runner_sid)

    def test_real_linux_sigterm_ignoring_fork_worker_escalates_to_sigkill_and_reaps_leader(self):
        runner_pgid = os.getpgrp()
        runner_sid = os.getsid(0)
        script = (
            'import os, signal, sys, time\n'
            'ready_fd = int(sys.argv[1])\n'
            'pid = os.fork()\n'
            'if pid == 0:\n'
            '    signal.signal(signal.SIGTERM, signal.SIG_IGN)\n'
            '    os.write(ready_fd, f"{os.getpid()}\\n".encode("ascii"))\n'
            '    os.close(ready_fd)\n'
            '    while True:\n'
            '        time.sleep(0.05)\n'
            'os.close(ready_fd)\n'
            'os._exit(0)\n'
        )
        child, worker_pid = self._spawn_fork_group(script)
        self.assertEqual(runner.wait_for_check(child, 5), (0, False))
        self.assertIsNone(child.returncode)
        retained = os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOWAIT | os.WNOHANG)
        self.assertIsNotNone(retained)
        self.assertEqual(retained.si_pid, child.pid)
        self.assertEqual(retained.si_status, 0)
        self.assertIn(worker_pid, runner.live_group_members(child.pid, child.pid))

        runner.stop_owned_child(child, grace_seconds=0.3)

        self.assertEqual(child.returncode, 0)
        with self.assertRaises(ChildProcessError):
            os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG)
        self.assertEqual(runner.live_group_members(child.pid, child.pid), set())
        stat_path = Path(f'/proc/{worker_pid}/stat')
        if stat_path.exists():
            stat_text = stat_path.read_bytes().decode('ascii', errors='replace')
            fields = stat_text[stat_text.rfind(')') + 1:].split()
            self.assertIn(fields[0], ('Z', 'X'))
        self.assertEqual(os.getpgrp(), runner_pgid)
        self.assertEqual(os.getsid(0), runner_sid)

    def test_bound_runner_loader_pins_actual_source_file(self):
        self.assertEqual(runner.__file__, str(SCRIPT))
        self.assertEqual(runner.stop_owned_child.__code__.co_filename, str(SCRIPT))
        self.assertEqual(runner.live_group_members.__code__.co_filename, str(SCRIPT))


if __name__ == '__main__':
    unittest.main()
