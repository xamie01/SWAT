"""Stdlib tests of actual ML boundaries with inert optional-dependency mocks.

No package __init__, native ML/DB imports, dotenv, YAML parsing, or adapters.
Temporary files contain JSON/opaque bytes only. Full pytest/native inference
is independently blocked. Invoke explicitly with python -I -S.
"""
from __future__ import annotations

import ast
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


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


# Reviewed source imports are only stdlib plus these explicitly inert mocks.
pkg = types.ModuleType("pattern_ml")
pkg.__path__ = []
sys.modules["pattern_ml"] = pkg
for name in ("yaml", "dotenv", "duckdb", "polars"):
    sys.modules[name] = Mock()
sys.modules["dotenv"].load_dotenv = Mock(side_effect=AssertionError("dotenv reads forbidden"))
schema = types.ModuleType("pattern_ml.schema")
schema.CANONICAL_TRADE_SCHEMA = {}
schema.POSITION_SCHEMA = {}
schema.conform = Mock()
schema.empty_frame = Mock()
sys.modules[schema.__name__] = schema
choice = types.ModuleType("pattern_ml.choice")
choice.__path__ = []
sys.modules[choice.__name__] = choice
choice_schema = types.ModuleType("pattern_ml.choice.schema")
for node in ast.parse((ROOT / "src/pattern_ml/choice/schema.py").read_text()).body:
    if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.target.id == "FEATURE_COLUMNS":
        choice_schema.FEATURE_COLUMNS = ast.literal_eval(node.value)
sys.modules[choice_schema.__name__] = choice_schema
config = load("pattern_ml.config", ROOT / "src/pattern_ml/config.py")
config._load_env = Mock()
storage_module = load("pattern_ml.storage", ROOT / "src/pattern_ml/storage.py")
artifact_file = ROOT / "src/pattern_ml/choice/package25_artifacts.py"
artifacts = load("pattern_ml.choice.package25_artifacts", artifact_file) if artifact_file.exists() else None
SOL = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1"


def body():
    return {"format": "pattern-ml-ranker-json-v1", "producer": "pattern_ml.choice.rank",
            "features": ["price"], "trees": [{"feature": 0, "threshold": 2.0,
            "default_left": True, "missing_type": "NaN", "left": {"value": 1.0}, "right": {"value": -1.0}}]}


class Boundaries(unittest.TestCase):
    def setUp(self):
        previous_umask = os.umask(0o077)  # All temporary operator-owned fixtures.
        self.addCleanup(os.umask, previous_umask)
        self.tmp = tempfile.TemporaryDirectory(prefix="package25-ml-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.project = self.root / "project"
        self.project.mkdir(mode=0o700)
        config.PROJECT_ROOT = self.project
        self.env = patch.dict(os.environ, {"PATTERN_ML_DATA_DIR": "data", "PATTERN_ML_DB": "data/test.duckdb"}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)
        config.get_settings.cache_clear()
        self.addCleanup(config.get_settings.cache_clear)

    def write(self, value):
        self.assertIsNotNone(artifacts, "artifact loader absent")
        path = config.get_settings().artifact_path(artifacts.ARTIFACT_NAME)
        path.parent.mkdir(exist_ok=True)
        path.write_text(json.dumps(value))
        path.chmod(0o600)  # An explicit local operator fixture, not ambient umask trust.
        return path

    def test_01_solana_invalid_components(self):
        for value in ("../escape", "/tmp/escape", "a/b", "a\\b", "1" * 31, "1" * 33, "0" * 44):
            with self.subTest(value=value), self.assertRaises(config.KolRosterError):
                config._normalize_address(value, "solana")

    def test_02_canonical_neighbors(self):
        self.assertEqual(config._normalize_address("solana:" + SOL, "solana"), SOL)
        self.assertEqual(config._normalize_address("0X" + "A" * 40, "polymarket"), "0x" + "a" * 40)
        self.assertEqual(config._normalize_address("1" * 32, "solana"), "1" * 32)

    def test_03_evm_nonhex(self):
        with self.assertRaises(config.KolRosterError):
            config._normalize_address("0x" + "g" * 40, "polymarket")

    def test_04_storage_config_escape(self):
        for value in ("../escape", "data/../../escape", str(self.root / "outside")):
            with self.subTest(value=value), self.assertRaises(ValueError):
                config._resolve(value)

    def test_05_storage_config_symlink(self):
        (self.project / "data").symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(ValueError):
            config._resolve("data/file")

    def test_06_raw_boundary_before_nonempty_frame_write(self):
        storage = storage_module.Storage()
        for chain, address in (("../escape", SOL), ("solana", "../escape"), ("solana", str(self.root / "escaped"))):
            frame = Mock(height=1, columns=[])
            with self.subTest(chain=chain, address=address), self.assertRaises(ValueError):
                storage.write_raw_parquet(chain, address, frame)
            frame.write_parquet.assert_not_called()

    def test_07_raw_symlink_partition(self):
        storage = storage_module.Storage()
        partition = config.get_settings().raw_dir / "solana"
        partition.mkdir()
        (partition / SOL).symlink_to(self.root, target_is_directory=True)
        frame = Mock(height=1, columns=[])
        with self.assertRaises(ValueError):
            storage.write_raw_parquet("solana", SOL, frame)
        frame.write_parquet.assert_not_called()

    def test_08_raw_allowed_neighbor(self):
        storage = storage_module.Storage()
        frame = Mock(height=1, columns=[])
        frame.write_parquet.side_effect = lambda path, **kwargs: Path(path).write_bytes(b"opaque neighbor")
        path = storage.write_raw_parquet("solana", SOL, frame)
        self.assertTrue(path.is_relative_to(self.project))
        self.assertEqual(path.read_bytes(), b"opaque neighbor")

    def test_09_raw_list_symlink(self):
        storage = storage_module.Storage()
        outside = self.root / "outside.parquet"
        outside.write_text("opaque fixture")
        (config.get_settings().raw_dir / "fixture.parquet").symlink_to(outside)
        with self.assertRaises(ValueError):
            storage.list_raw_parquet()

    def test_10_database_escape(self):
        with self.assertRaises(ValueError):
            storage_module.Storage(self.root / "outside.duckdb")

    def test_11_inert_scoring_neighbor(self):
        self.write(body())
        loaded = artifacts.load_ranker(config.get_settings())
        self.assertEqual(loaded["model"].predict([[1.0], [3.0], [float("nan")]]), [1.0, -1.0, 1.0])

    def test_12_schema_and_provenance_rejection(self):
        for change in ({"format": "pickle"}, {"producer": "unknown"}, {"features": ["chosen"]}, {"features": ["price", "price"]}, {"trees": []}, {"extra": 1}, {"trees": [{"value": float("inf")}]}, {"trees": [{"value": True}]}):
            self.write(body() | change)
            with self.subTest(change=change), self.assertRaises(ValueError):
                artifacts.load_ranker(config.get_settings())

    def test_13_legacy_never_deserialized(self):
        self.assertIsNotNone(artifacts)
        path = config.get_settings().artifact_path("ranker.pkl")
        path.parent.mkdir()
        path.write_bytes(b"opaque fixture; not executable serialization")
        with self.assertRaises(ValueError):
            artifacts.load_ranker(config.get_settings())

    def test_14_artifact_symlink_read_write(self):
        self.assertIsNotNone(artifacts)
        outside = self.root / "outside.json"
        outside.write_text("untouched")
        directory = config.get_settings().artifacts_dir
        directory.mkdir()
        (directory / artifacts.ARTIFACT_NAME).symlink_to(outside)
        with self.assertRaises(ValueError):
            artifacts.load_ranker(config.get_settings())
        result = types.SimpleNamespace(model=Mock(), features_used=["price"])
        with self.assertRaises(ValueError):
            artifacts.save_ranker(config.get_settings(), result)
        result.model.booster_.dump_model.assert_not_called()
        self.assertEqual(outside.read_text(), "untouched")

    def test_15_mocked_training_export_neighbor(self):
        self.assertIsNotNone(artifacts)
        booster = Mock()
        booster.dump_model.return_value = {"objective": "lambdarank", "num_class": 1,
            "num_tree_per_iteration": 1, "average_output": False, "max_feature_idx": 0,
            "tree_info": [{"tree_structure": {"leaf_value": 0.5}}]}
        result = types.SimpleNamespace(model=types.SimpleNamespace(booster_=booster), features_used=["price"])
        artifacts.save_ranker(config.get_settings(), result)
        self.assertEqual(artifacts.load_ranker(config.get_settings())["model"].predict([[1.0]]), [0.5])


    def test_16_storage_subroot_cannot_override_project_trust(self):
        outside = self.root / "outside"
        outside.mkdir(mode=0o700)
        with self.assertRaises(ValueError):
            config.confined_path(outside / "file", root=outside)
        self.project.chmod(0o777)
        with self.assertRaises(ValueError):
            storage_module.Storage()
        self.assertFalse((self.project / "data").exists())
        storage_module.duckdb.connect.assert_not_called()


    def test_17_raw_canonical_identity_and_prefix_chain(self):
        storage = storage_module.Storage()
        first = Mock(height=1, columns=[])
        first.write_parquet.side_effect = lambda path, **kwargs: Path(path).write_bytes(b"opaque raw fixture")
        path = storage.write_raw_parquet("solana", SOL, first)
        alias = Mock(height=1, columns=[])
        alias.write_parquet.side_effect = lambda path, **kwargs: Path(path).write_bytes(b"opaque raw fixture")
        self.assertEqual(storage.write_raw_parquet("solana", "solana:" + SOL, alias), path)
        self.assertEqual(path.read_bytes(), b"opaque raw fixture")
        for chain, address in (("solana", "polygon:" + SOL),
                               ("polymarket", "solana:0x" + "a" * 40)):
            frame = Mock(height=1, columns=[])
            with self.subTest(chain=chain), self.assertRaises(ValueError):
                storage.write_raw_parquet(chain, address, frame)
            frame.write_parquet.assert_not_called()


    def test_18_export_rejects_out_of_subset_metadata_and_linear_leaves(self):
        base = {"objective": "lambdarank", "num_class": 1,
                "num_tree_per_iteration": 1, "average_output": False,
                "max_feature_idx": 0,
                "tree_info": [{"tree_structure": {"leaf_value": 0.5}}]}
        variants = [base | {"num_class": True},
                    base | {"num_tree_per_iteration": True},
                    base | {"max_feature_idx": False},
                    base | {"feature_names": ["wrong_order"]},
                    base | {"tree_info": [{"tree_structure": {
                        "leaf_value": 0.5, "is_linear": True,
                        "leaf_features": [], "leaf_coeff": []}}]}]
        for dump in variants:
            booster = Mock()
            booster.dump_model.return_value = dump
            result = types.SimpleNamespace(model=types.SimpleNamespace(booster_=booster), features_used=["price"])
            with self.subTest(dump=dump):
                with self.assertRaises(ValueError):
                    artifacts.save_ranker(config.get_settings(), result)
                self.assertFalse(config.get_settings().artifact_path(artifacts.ARTIFACT_NAME).exists())


    def test_19_json_numbers_reject_oversized_integer_as_value_error(self):
        self.write(body() | {"trees": [{"value": 10 ** 400}]})
        with self.assertRaises(ValueError):
            artifacts.load_ranker(config.get_settings())

    def test_20_numeric_missing_policies_and_multitree_order(self):
        for policy, expected in (("None", [1.5, 1.5, -0.5, 1.5]),
                                 ("NaN", [-0.5, 1.5, -0.5, -0.5])):
            value = body()
            value["trees"][0].update(missing_type=policy, default_left=False)
            value["trees"].append({"value": 0.5})
            self.write(value)
            model = artifacts.load_ranker(config.get_settings())["model"]
            with self.subTest(policy=policy):
                self.assertEqual(model.predict([[None], [0.0], [3.0], [float("nan")]]), expected)
                with self.assertRaises(ValueError):
                    model.predict([[1.0, 2.0]])

    def test_21_json_file_and_complexity_bounds(self):
        settings = config.get_settings()
        path = self.write(body())
        path.chmod(0o666)
        with self.assertRaises(ValueError):
            artifacts.load_ranker(settings)
        path.chmod(0o600)
        hardlink = path.with_name("hardlink.json")
        hardlink.hardlink_to(path)
        with self.assertRaises(ValueError):
            artifacts.load_ranker(settings)
        hardlink.unlink()  # Only this test's newly created temporary fixture.
        path.write_text('{"format":"x","format":"y"}')
        with self.assertRaises(ValueError):
            artifacts.load_ranker(settings)
        self.write(body())
        with patch.object(artifacts, "MAX_BYTES", 16), self.assertRaises(ValueError):
            artifacts.load_ranker(settings)
        for limit, maximum in (("MAX_TREES", 1), ("MAX_NODES", 2), ("MAX_DEPTH", 0)):
            value = body()
            if limit == "MAX_TREES":
                value["trees"].append({"value": 0.5})
            self.write(value)
            with self.subTest(limit=limit), patch.object(artifacts, limit, maximum), self.assertRaises(ValueError):
                artifacts.load_ranker(settings)

    def test_22_mocked_numeric_training_dump_roundtrip(self):
        split = {"split_feature": 0, "threshold": 2.0, "decision_type": "<=",
                 "default_left": True, "missing_type": "NaN",
                 "left_child": {"leaf_value": 1.0}, "right_child": {"leaf_value": -1.0}}
        dump = {"objective": "lambdarank", "num_class": 1, "num_tree_per_iteration": 1,
                "average_output": False, "max_feature_idx": 0,
                "feature_names": ["Column_0"], "tree_info": [{"tree_structure": split}]}
        booster = Mock()
        booster.dump_model.return_value = dump
        result = types.SimpleNamespace(model=types.SimpleNamespace(booster_=booster), features_used=["price"])
        artifacts.save_ranker(config.get_settings(), result)
        self.assertEqual(artifacts.load_ranker(config.get_settings())["model"].predict([[1.0], [3.0]]), [1.0, -1.0])
        split["decision_type"] = "=="
        with self.assertRaises(ValueError):
            artifacts.save_ranker(config.get_settings(), result)
        self.assertEqual(artifacts.load_ranker(config.get_settings())["model"].predict([[1.0]]), [1.0])


    def test_23_export_accepts_only_local_objective_and_tree_contract(self):
        base = {"objective": "lambdarank sigmoid:1", "num_class": 1,
                "num_tree_per_iteration": 1, "average_output": False,
                "max_feature_idx": 0, "feature_names": ["Column_0"],
                "tree_info": [{"tree_index": 0, "num_leaves": 1, "num_cat": 0,
                               "shrinkage": 1, "tree_structure": {"leaf_value": 0.5}}]}
        def result(dump):
            return types.SimpleNamespace(model=types.SimpleNamespace(booster_=Mock(
                dump_model=Mock(return_value=dump))), features_used=["price"])
        artifacts.save_ranker(config.get_settings(), result(base))
        self.assertEqual(artifacts.load_ranker(config.get_settings())["model"].predict([[2.0]]), [0.5])
        for change in ({"objective": "lambdarank sigmoid:2"},
                       {"objective": "lambdarank_extra"},
                       {"tree_info": [{"num_cat": 1, "tree_structure": {"leaf_value": 0.5}}]},
                       {"tree_info": [{"tree_structure": {"leaf_value": 0.5, "left_child": {"leaf_value": 3}}}]},
                       {"tree_info": [{"num_leaves": 2, "tree_structure": {"leaf_value": 0.5}}]}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                artifacts.save_ranker(config.get_settings(), result(base | change))
        self.assertEqual(artifacts.load_ranker(config.get_settings())["model"].predict([[2.0]]), [0.5])


    def test_24_predict_validates_entire_numeric_row_and_freezes_bundle(self):
        value = body() | {"features": ["price", "volume_24h_usd"]}
        model = artifacts.JsonRanker(value)
        for row in ([1.0, "bad"], [True, 2.0], [1.0, float("inf")], [1.0, 10 ** 400]):
            with self.subTest(row=str(row)), self.assertRaises(ValueError):
                model.predict([row])
        value["trees"][0]["left"]["value"] = 99.0
        self.assertEqual(model.predict([[1.0, None]]), [1.0])
        self.assertEqual(model.predict([[2.0, float("nan")], [2.0000000000000004, 1.0]]), [1.0, -1.0])

    def test_25_zero_missing_contract_is_explicitly_unavailable(self):
        value = body()
        value["trees"][0]["missing_type"] = "Zero"
        self.write(value)
        with self.assertRaises(ValueError):
            artifacts.load_ranker(config.get_settings())


    def test_26_storage_rejects_special_and_aliased_native_leaves(self):
        storage = storage_module.Storage()
        for filename, kind in (("fifo.parquet", "fifo"), ("alias.parquet", "link")):
            path = config.get_settings().raw_dir / filename
            if kind == "fifo":
                os.mkfifo(path, 0o600)
            else:
                target = self.project / "original"
                target.write_text("opaque")
                path.hardlink_to(target)
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                storage.list_raw_parquet()
            path.unlink()


    def test_27_raw_staging_hashes_actual_bytes_and_keeps_pulls_immutable(self):
        storage = storage_module.Storage()
        def frame(data):
            value = Mock(height=1, columns=[])
            value.write_parquet.side_effect = lambda path, **kwargs: Path(path).write_bytes(data)
            return value
        first = storage.write_raw_parquet("solana", SOL, frame(b"first opaque parquet"))
        second = storage.write_raw_parquet("solana", SOL, frame(b"second opaque parquet"))
        self.assertNotEqual(first, second)
        self.assertEqual(first.read_bytes(), b"first opaque parquet")
        self.assertEqual(second.read_bytes(), b"second opaque parquet")
        again = storage.write_raw_parquet("solana", "solana:" + SOL, frame(b"first opaque parquet"))
        self.assertEqual(first, again)
        self.assertEqual(len(storage.list_raw_parquet()), 2)


if __name__ == "__main__":
    assertion_calls = {}

    def counted(method):
        def invoke(self, *args, **kwargs):
            assertion_calls[method.__name__] = assertion_calls.get(method.__name__, 0) + 1
            return method(self, *args, **kwargs)
        return invoke

    for name in ("assertRaises", "assertEqual", "assertTrue", "assertFalse", "assertIsNotNone"):
        setattr(Boundaries, name, counted(getattr(unittest.TestCase, name)))
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(Boundaries)
    if len(sys.argv) > 1 and sys.argv[1] == "neighbors":
        suite = unittest.TestSuite(Boundaries(n) for n in ("test_02_canonical_neighbors", "test_08_raw_allowed_neighbor", "test_11_inert_scoring_neighbor", "test_15_mocked_training_export_neighbor"))
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    failing_ids = {test.id().split(" (")[0] for test, _ in result.failures + result.errors}
    failed_tests = len(failing_ids)
    report = {"qualification": "actual source helpers with inert dependency mocks; pytest/full native ML runtime blocked",
              "executedMethods": [name for name in dir(Boundaries) if name.startswith("test_")] if len(sys.argv) == 1 else None,
              "unittestAssertionCalls": {"total": sum(assertion_calls.values()), "byName": assertion_calls,
                                         "qualification": "unittest assertion invocations only; inert Mock assertions additional, not counted"},
              "testResults": [{"name": str(Path(__file__).resolve()), "passed": result.testsRun - failed_tests - len(result.skipped),
                               "failed": failed_tests, "failureAssertions": len(result.failures), "errorAssertions": len(result.errors),
                               "skipped": len(result.skipped), "total": result.testsRun}]}
    print(json.dumps(report, indent=2))
    if RESULT_PATH:
        Path(RESULT_PATH).write_text(json.dumps(report, indent=2) + "\n")
    raise SystemExit(0 if result.wasSuccessful() else 1)
