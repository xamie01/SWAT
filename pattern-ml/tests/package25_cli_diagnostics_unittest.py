"""Actual rank/score CLI diagnostics with stdlib-only inert dependencies.

Invoke explicitly with /usr/bin/python3 -I -S via the locked historical runner.
The complete CLI source is loaded, but no package initialization, real Typer,
Rich, Polars, rank/native model, storage, provider, YAML or dotenv executes.
Only private disposable path fixtures and explicit synthetic settings are used.
"""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
RESULT_PATH = os.environ.get("REVIEW_RESULTS")


def module(name, **attributes):
    value = types.ModuleType(name)
    value.__dict__.update(attributes)
    sys.modules[name] = value
    return value


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    sys.modules[name] = value
    spec.loader.exec_module(value)
    return value


class CliExit(Exception):
    def __init__(self, code):
        self.exit_code = code
        super().__init__(code)


class InertApp:
    def __init__(self, **kwargs):
        pass

    def command(self, *args, **kwargs):
        return lambda function: function


# Empty package paths forbid native/project fallback imports. The reviewed CLI
# top level only imports stdlib/mocked modules and registers inert decorators.
module("pattern_ml", __path__=[])
module("pattern_ml.choice", __path__=[])
module("pattern_ml.choice.providers", __path__=[])
module("yaml", safe_load=Mock(side_effect=AssertionError("YAML parsing forbidden")))
module("dotenv", load_dotenv=Mock(side_effect=AssertionError("dotenv reads forbidden")))
config = load("pattern_ml.config", ROOT / "src/pattern_ml/config.py")
config._load_env = Mock()  # Before any actual get_settings invocation.

polars = module("polars", read_parquet=Mock(side_effect=AssertionError("native Parquet forbidden")))
module("typer", Typer=InertApp, Option=lambda default, *args, **kwargs: default, Exit=CliExit)
module("rich", __path__=[])
console = Mock()
module("rich.console", Console=lambda: console)
module("rich.table", Table=Mock(side_effect=AssertionError("table rendering not needed")))
storage = module("pattern_ml.storage", get_storage=Mock(side_effect=AssertionError("storage forbidden")))
artifacts = module("pattern_ml.choice.package25_artifacts",
                   load_ranker=Mock(side_effect=AssertionError("model loading forbidden")),
                   save_ranker=Mock(side_effect=AssertionError("model export forbidden")))
rank_module = module("pattern_ml.choice.rank",
                     train_ranker=Mock(side_effect=AssertionError("native training forbidden")),
                     RankerResult=Mock(side_effect=AssertionError("native result forbidden")),
                     score_candidates=Mock(side_effect=AssertionError("native scoring forbidden")))
providers = [module("pattern_ml.choice.providers." + chain, **{symbol: Mock(
    side_effect=AssertionError("provider access forbidden"))}) for chain, symbol in
    (("polymarket", "PolymarketSnapshotProvider"), ("solana", "SolanaSnapshotProvider"))]
cli = load("pattern_ml.cli", ROOT / "src/pattern_ml/cli.py")


class CliDiagnostics(unittest.TestCase):
    def setUp(self):
        previous_umask = os.umask(0o077)
        self.addCleanup(os.umask, previous_umask)
        self.tmp = tempfile.TemporaryDirectory(prefix="package25-cli-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.project = self.root / "project"
        self.project.mkdir(mode=0o700)
        root_patch = patch.object(config, "PROJECT_ROOT", self.project)
        root_patch.start()
        self.addCleanup(root_patch.stop)
        env = patch.dict(os.environ, {"PATTERN_ML_DATA_DIR": "data",
                                    "PATTERN_ML_DB": "data/test.duckdb"}, clear=True)
        env.start()
        self.addCleanup(env.stop)
        config.get_settings.cache_clear()
        self.addCleanup(config.get_settings.cache_clear)
        self.reset_mocks()

    def reset_mocks(self):
        for value in (console, polars.read_parquet, storage.get_storage,
                      artifacts.load_ranker, artifacts.save_ranker,
                      rank_module.train_ranker, rank_module.RankerResult,
                      rank_module.score_candidates, config._load_env):
            value.reset_mock()
        for provider, symbol in zip(providers, ("PolymarketSnapshotProvider", "SolanaSnapshotProvider")):
            getattr(provider, symbol).reset_mock()

    def invoke(self, command):
        if command == "rank":
            cli.rank(n_splits=4, drop_kol_features=False)
        else:
            cli.score(chain="polymarket", venue=None, top=10)

    def diagnostic(self, command, message):
        with self.assertRaises(CliExit) as caught:
            self.invoke(command)
        self.assertEqual(caught.exception.exit_code, 1)
        console.print.assert_called_once()
        self.assertTrue(console.print.call_args.args[0].endswith(message))

    def no_downstream(self):
        polars.read_parquet.assert_not_called()
        artifacts.load_ranker.assert_not_called()
        rank_module.train_ranker.assert_not_called()
        artifacts.save_ranker.assert_not_called()
        rank_module.RankerResult.assert_not_called()
        rank_module.score_candidates.assert_not_called()
        storage.get_storage.assert_not_called()
        for provider, symbol in zip(providers, ("PolymarketSnapshotProvider", "SolanaSnapshotProvider")):
            getattr(provider, symbol).assert_not_called()

    def test_01_rank_config_escape_diagnostic_before_downstream(self):
        os.environ["PATTERN_ML_DATA_DIR"] = "../outside"
        self.diagnostic("rank", "Parent traversal is not allowed in storage paths")
        self.no_downstream()

    def test_02_score_config_escape_diagnostic_before_downstream(self):
        os.environ["PATTERN_ML_DB"] = "../outside.duckdb"
        self.diagnostic("score", "Parent traversal is not allowed in storage paths")
        self.no_downstream()

    def test_03_both_config_symlink_and_writable_root_diagnostics(self):
        (self.project / "data").symlink_to(self.root, target_is_directory=True)
        for command in ("rank", "score"):
            with self.subTest(command=command, reason="symlink"):
                config.get_settings.cache_clear()
                self.reset_mocks()
                self.diagnostic(command, "Symlinks are not allowed in storage paths")
                self.no_downstream()
        (self.project / "data").unlink()  # Only this new disposable fixture.
        self.project.chmod(0o777)
        for command in ("rank", "score"):
            with self.subTest(command=command, reason="permissions"):
                config.get_settings.cache_clear()
                self.reset_mocks()
                self.diagnostic(command, "Storage must be same-user and not group/world writable")
                self.no_downstream()

    def test_04_rank_artifact_symlink_diagnostic_before_read(self):
        directory = self.project / "artifacts"
        directory.mkdir(mode=0o700)
        (directory / "choice_candidates.parquet").symlink_to(self.root / "opaque")
        self.diagnostic("rank", "Symlinks are not allowed in storage paths")
        self.no_downstream()

    def test_05_rank_rechecks_path_before_native_read(self):
        outside = self.root / "opaque.parquet"
        outside.write_text("opaque fixture, never parsed")
        settings = config.get_settings()
        # Simulate a path invalidated after settings resolution; the real
        # confined_path guard must still reject it before native Parquet I/O.
        with patch.object(config.Settings, "artifact_path", return_value=outside):
            self.diagnostic("rank", "Storage path must stay beneath the approved package root")
        self.no_downstream()

    def test_06_rank_missing_artifact_keeps_existing_diagnostic(self):
        self.diagnostic("rank", "No choice sets. Run `pattern-ml choice-sets` first.")
        self.no_downstream()

    def test_07_score_loader_rejection_keeps_existing_diagnostic(self):
        with patch.object(artifacts, "load_ranker", side_effect=ValueError("invalid local JSON")) as loader:
            self.diagnostic("score", "invalid local JSON")
            loader.assert_called_once_with(config.get_settings())
        self.no_downstream()

    def test_08_rank_allowed_path_reaches_inert_training_refusal(self):
        path = config.get_settings().artifact_path("choice_candidates.parquet")
        path.parent.mkdir(mode=0o700)
        path.write_text("opaque fixture, never parsed")
        frame = object()
        with patch.object(polars, "read_parquet", return_value=frame) as reader, \
                patch.object(rank_module, "train_ranker", side_effect=ImportError("native ranking unavailable")) as trainer:
            self.diagnostic("rank", "native ranking unavailable")
            reader.assert_called_once_with(path)
            trainer.assert_called_once_with(frame, n_splits=4)
        self.no_downstream()

    def test_09_unexpected_settings_error_not_swallowed(self):
        for command in ("rank", "score"):
            with self.subTest(command=command), patch.object(cli, "get_settings", side_effect=RuntimeError("unexpected")):
                with self.assertRaisesRegex(RuntimeError, "unexpected"):
                    self.invoke(command)
                console.print.assert_not_called()
                self.no_downstream()


if __name__ == "__main__":
    assertion_calls = {}

    def counted(method):
        def invoke(self, *args, **kwargs):
            assertion_calls[method.__name__] = assertion_calls.get(method.__name__, 0) + 1
            return method(self, *args, **kwargs)
        return invoke

    for name in ("assertRaises", "assertRaisesRegex", "assertEqual", "assertTrue"):
        setattr(CliDiagnostics, name, counted(getattr(unittest.TestCase, name)))
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(CliDiagnostics)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    failing_ids = {test.id().split(" (")[0] for test, _ in result.failures + result.errors}
    report = {"qualification": "actual CLI/config loaded with inert stdlib dependency fixtures; no real Typer/native/package initialization",
              "executedMethods": [name for name in dir(CliDiagnostics) if name.startswith("test_")],
              "unittestAssertionCalls": {"total": sum(assertion_calls.values()), "byName": assertion_calls,
                                         "qualification": "unittest invocations only; Mock assertions additional, not counted"},
              "testResults": [{"name": str(Path(__file__).resolve()), "passed": result.testsRun - len(failing_ids) - len(result.skipped),
                               "failed": len(failing_ids), "failureAssertions": len(result.failures),
                               "errorAssertions": len(result.errors), "skipped": len(result.skipped), "total": result.testsRun}]}
    print(json.dumps(report, indent=2))
    if RESULT_PATH:
        Path(RESULT_PATH).write_text(json.dumps(report, indent=2) + "\n")
    raise SystemExit(0 if result.wasSuccessful() else 1)
