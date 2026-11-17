"""Opt-in genuine LightGBM parity, never a mocked native pass.

UNEXECUTED until a separately reviewed native runtime is approved. Run only this
file, with PYTEST_DISABLE_PLUGIN_AUTOLOAD=1, synthetic/cleared credentials and
PATTERN_ML_NATIVE_PARITY=1, using pytest --confcutdir=<this native directory>.
The confcutdir is mandatory: the parent conftest imports package __init__/DB.
No package initialization, provider, warehouse, dotenv file read or model-file
loader is needed. Missing native dependencies produce skips, not parity passes.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import importlib.util
import json
import os
from pathlib import Path
import sys
import types

import pytest

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def native(tmp_path, monkeypatch):
    if os.environ.get("PATTERN_ML_NATIVE_PARITY") != "1":
        pytest.skip("Native parity unavailable: separately approved runtime/opt-in required")
    if "pattern_ml" in sys.modules:
        pytest.fail("Native parity must run in isolation with --confcutdir=tests/native")
    np = pytest.importorskip("numpy", reason="Native parity unavailable: numpy absent")
    pl = pytest.importorskip("polars", reason="Native parity unavailable: polars absent")
    lgb = pytest.importorskip("lightgbm", reason="Native parity unavailable: LightGBM absent")
    pytest.importorskip("yaml", reason="Config dependency unavailable")
    pytest.importorskip("dotenv", reason="Config dependency unavailable")
    # Namespace-only shells avoid both package __init__ files. Every source
    # helper and ML dependency below is real, not a mocked native implementation.
    for name in ("pattern_ml", "pattern_ml.choice"):
        package = types.ModuleType(name)
        package.__path__ = []
        monkeypatch.setitem(sys.modules, name, package)

    def load(name, relative):
        spec = importlib.util.spec_from_file_location(name, ROOT / "src/pattern_ml" / relative)
        module = importlib.util.module_from_spec(spec)
        monkeypatch.setitem(sys.modules, name, module)
        spec.loader.exec_module(module)
        return module

    config = load("pattern_ml.config", "config.py")
    monkeypatch.setattr(config, "_load_env", lambda: None)
    project = tmp_path / "project"
    project.mkdir(mode=0o700)
    monkeypatch.setattr(config, "PROJECT_ROOT", project)
    monkeypatch.setenv("PATTERN_ML_DATA_DIR", "data")
    monkeypatch.setenv("PATTERN_ML_DB", "data/never-opened.duckdb")
    for key in ("HELIUS_API_KEY", "BITQUERY_TOKEN", "BITQUERY_API_KEY"):
        monkeypatch.delenv(key, raising=False)
    schema = load("pattern_ml.choice.schema", "choice/schema.py")
    rank = load("pattern_ml.choice.rank", "choice/rank.py")
    artifacts = load("pattern_ml.choice.package25_artifacts", "choice/package25_artifacts.py")
    config.get_settings.cache_clear()
    try:
        yield types.SimpleNamespace(np=np, pl=pl, lgb=lgb, config=config,
                                    schema=schema, rank=rank, artifacts=artifacts)
    finally:
        config.get_settings.cache_clear()


def grouped_fixture(native):
    """512 synthetic candidates, contiguous temporal groups; no live history."""
    rows = []
    base = datetime(2026, 1, 1, tzinfo=timezone.utc)
    for group in range(64):
        for candidate in range(8):
            price = float(candidate - 3)
            liquidity = float((candidate * 3 + group) % 8)
            if (candidate + group) % 9 == 0:
                price = None
            if (2 * candidate + group) % 11 == 0:
                liquidity = None
            quality = (price if price is not None else -4.0) + 0.4 * (liquidity or 0.0)
            rows.append({"group_id": f"g{group:03d}",
                         "decided_at": base + timedelta(hours=group),
                         "market_id": f"synthetic-{group}-{candidate}",
                         "snapshot_source": "synthetic", "price": price,
                         "liquidity_usd": liquidity,
                         "relevance": 2 if quality > 2 else 1 if quality > 0 else 0})
    # Deliberately reverse frame columns: selecting declared features is required.
    return native.pl.DataFrame(rows).select(
        "market_id", "snapshot_source", "liquidity_usd", "relevance", "price", "group_id", "decided_at")


def split_nodes(tree):
    if "value" in tree:
        return []
    return [tree] + split_nodes(tree["left"]) + split_nodes(tree["right"])


def probes_for(bundle, np):
    """Reach real splits through ancestor constraints, then probe float edges."""
    width = len(bundle["features"])
    rows = [[0.0] * width, [np.nan] * width]
    nodes = [node for tree in bundle["trees"] for node in split_nodes(tree)]
    assert nodes, "Fixture must actually train nonconstant numeric trees"

    def visit(node, bounds):
        if "value" in node:
            return
        row = []
        for lower, upper in bounds:
            # lower is exclusive and upper inclusive, just like numeric <= trees.
            value = 0.0
            if value <= lower:
                value = np.nextafter(lower, np.inf)
            if value > upper:
                value = upper
            assert lower < value <= upper
            row.append(value)
        feature, threshold = node["feature"], node["threshold"]
        lower, upper = bounds[feature]
        assert lower < threshold <= upper, "Threshold witness must reach its real node"
        for value in (np.nextafter(threshold, -np.inf), threshold,
                      np.nextafter(threshold, np.inf), 0.0, np.nan):
            probe = row[:]
            probe[feature] = value
            rows.append(probe)
        left, right = bounds[:], bounds[:]
        left[feature] = (lower, min(upper, threshold))
        right[feature] = (max(lower, threshold), upper)
        visit(node["left"], left)
        visit(node["right"], right)

    for tree in bundle["trees"]:
        visit(tree, [(-np.inf, np.inf)] * width)
    # Repeated boosting thresholds need no repeated matrix rows. Bound the
    # interpreter work while still visiting every exported split above.
    unique = {}
    for row in rows:
        key = tuple(None if np.isnan(value) else float(value) for value in row)
        unique.setdefault(key, row)
    rows = list(unique.values())
    rows.extend([rows[0][:], rows[0][:]])
    return np.asarray(rows, dtype=np.float64), nodes


def assert_roundtrip(native, trained):
    np, artifacts = native.np, native.artifacts
    settings = native.config.get_settings()
    path = artifacts.save_ranker(settings, trained)
    bundle = json.loads(path.read_text())
    loaded = artifacts.load_ranker(settings)
    assert loaded["features"] == trained.features_used == ["price", "liquidity_usd"]
    assert not path.with_name("ranker.pkl").exists()
    matrix, nodes = probes_for(bundle, np)
    expected = trained.model.predict(matrix, raw_score=True)
    actual = np.asarray(loaded["model"].predict(matrix))
    # One thread and identical double leaf sums: equality, not a loose tolerance.
    np.testing.assert_array_equal(actual, expected)
    assert actual[0] == actual[-1] == actual[-2]
    with_none = [[None if np.isnan(value) else float(value) for value in row] for row in matrix]
    np.testing.assert_array_equal(loaded["model"].predict(with_none), expected)

    assert len(bundle["trees"]) > 1, "Parity must exercise additive tree sums"
    per_tree = []
    for index, tree in enumerate(bundle["trees"]):
        one = artifacts.JsonRanker(bundle | {"trees": [tree]})
        native_tree = trained.model.booster_.predict(
            matrix, raw_score=True, start_iteration=index, num_iteration=1)
        np.testing.assert_array_equal(one.predict(matrix), native_tree)
        per_tree.append(native_tree)
    summed = np.zeros(len(matrix), dtype=np.float64)
    for values in per_tree:
        summed += values
    np.testing.assert_array_equal(actual, summed)

    # Public scoring must select saved feature order and preserve exact ties.
    frame = native.pl.DataFrame({"market_id": [f"probe-{i}" for i in range(len(matrix))],
                                 "liquidity_usd": matrix[:, 1], "price": matrix[:, 0]})
    inert_result = types.SimpleNamespace(model=loaded["model"], features_used=loaded["features"])
    ranked = native.rank.score_candidates(inert_result, frame)
    order = np.argsort(-expected, kind="stable")
    assert ranked["market_id"].to_list() == [f"probe-{i}" for i in order]
    np.testing.assert_array_equal(ranked["score"].to_numpy(), expected[order])
    return nodes


@pytest.mark.parametrize("use_missing,policy", [(True, "NaN"), (False, "None")])
def test_native_numeric_export_exact_threshold_missing_order_sums_and_ties(native, use_missing, policy):
    frame = grouped_fixture(native)
    features = ["price", "liquidity_usd"]
    # Real local constructor/objective, reduced deterministic synthetic budget.
    model = native.rank._make_ranker(17)
    model.set_params(n_estimators=8, num_leaves=7, min_child_samples=1,
                     subsample=1.0, subsample_freq=0, colsample_bytree=1.0,
                     use_missing=use_missing, deterministic=True, force_col_wise=True)
    model.fit(frame.select(features).to_numpy(), frame["relevance"].to_numpy(),
              group=native.rank._group_sizes(frame))
    nodes = assert_roundtrip(native, types.SimpleNamespace(model=model, features_used=features))
    assert policy in {node["missing_type"] for node in nodes}, "Missing-policy branch was not exercised"


def test_native_train_ranker_public_export_and_group_seam(native):
    frame = grouped_fixture(native)
    group_order = frame["group_id"].unique(maintain_order=True).to_list()
    assert native.rank._group_sizes(frame) == [8] * 64
    for train, test in native.rank._split_groups(group_order, 1):
        assert not set(train) & set(test)
        assert max(group_order.index(g) for g in train) < min(group_order.index(g) for g in test)
    trained = native.rank.train_ranker(frame, n_splits=1, seed=17, min_groups=1)
    assert trained.n_groups == 64 and len(trained.folds) == 1
    assert_roundtrip(native, trained)


def test_native_single_leaf_constant_synthetic_ranker(native):
    np, artifacts = native.np, native.artifacts
    # No synthetic feature can split, so the native root is a genuine leaf.
    matrix = np.zeros((32, 2), dtype=np.float64)
    labels = np.tile(np.asarray([2, 1, 0, 0]), 8)
    model = native.rank._make_ranker(17)
    model.set_params(n_estimators=2, subsample=1.0, subsample_freq=0,
                     colsample_bytree=1.0, deterministic=True, force_col_wise=True)
    model.fit(matrix, labels, group=[4] * 8)
    trained = types.SimpleNamespace(model=model, features_used=["price", "liquidity_usd"])
    settings = native.config.get_settings()
    path = artifacts.save_ranker(settings, trained)
    bundle = json.loads(path.read_text())
    assert bundle["trees"] and all(set(tree) == {"value"} for tree in bundle["trees"])
    probes = np.asarray([[0.0, 0.0], [-1.0, 1.0], [np.nan, np.nan]])
    np.testing.assert_array_equal(artifacts.load_ranker(settings)["model"].predict(probes),
                                  model.predict(probes, raw_score=True))


def test_native_equal_score_metrics_follow_first_candidate(native):
    scores = native.np.zeros(64)
    relevance = native.np.zeros(64)
    relevance[1] = native.schema.REL_CHOSEN
    assert native.rank._hit_at_1(scores, relevance) == 0.0
    assert native.rank._reciprocal_rank(scores, relevance) == 0.5
    assert native.rank._ndcg(scores, relevance) == pytest.approx(1.0 / native.np.log2(3.0))
