"""PF-SEC-10 regressions. Local temp fixtures only; no executable artifacts."""
from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from pattern_ml import config
from pattern_ml.config import KolRosterError, _normalize_address, _resolve
from pattern_ml.storage import Storage

SOL = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1"


@pytest.mark.parametrize("address", ["../escape", "/tmp/escape", "a/b", "a\\b", "1" * 31, "1" * 33, "0" * 44])
def test_roster_rejects_invalid_solana_before_pull(address: str) -> None:
    with pytest.raises(KolRosterError):
        _normalize_address(address, "solana")


def test_evm_requires_hex() -> None:
    with pytest.raises(KolRosterError):
        _normalize_address("0x" + "g" * 40, "polymarket")


@pytest.mark.parametrize("value", ["../escape", "data/../../escape", "/tmp/escape"])
def test_config_rejects_external_storage(value: str) -> None:
    with pytest.raises(ValueError):
        _resolve(value)


def test_config_rejects_symlink_before_mkdir(tmp_path: Path) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    (config.PROJECT_ROOT / "data").symlink_to(outside, target_is_directory=True)
    with pytest.raises(ValueError):
        _resolve("data/file.parquet")


@pytest.mark.parametrize("chain,address", [("../escape", SOL), ("solana", "../escape"), ("solana", "/tmp/escape")])
def test_raw_public_write_rejects_components_before_frame_access(chain: str, address: str) -> None:
    frame = Mock()
    with Storage() as storage, pytest.raises(ValueError):
        storage.write_raw_parquet(chain, address, frame)
    frame.write_parquet.assert_not_called()


def test_raw_public_write_rejects_symlink_partition(tmp_path: Path) -> None:
    with Storage() as storage:
        outside = tmp_path / "outside"
        outside.mkdir()
        partition = config.get_settings().raw_dir / "solana"
        partition.mkdir()
        (partition / SOL).symlink_to(outside, target_is_directory=True)
        frame = Mock()
        with pytest.raises(ValueError):
            storage.write_raw_parquet("solana", SOL, frame)
        frame.write_parquet.assert_not_called()
        assert not list(outside.iterdir())


def test_raw_public_write_stays_local() -> None:
    frame = Mock(height=1, columns=[])
    with Storage() as storage:
        path = storage.write_raw_parquet("solana", SOL, frame)
        assert path.is_relative_to(config.PROJECT_ROOT)
        frame.write_parquet.assert_called_once_with(path, compression="zstd")


def test_raw_list_rejects_symlink_file(tmp_path: Path) -> None:
    with Storage() as storage:
        outside = tmp_path / "outside.parquet"
        outside.write_text("opaque fixture, not parquet")
        target = config.get_settings().raw_dir / "fixture.parquet"
        target.symlink_to(outside)
        with pytest.raises(ValueError):
            storage.list_raw_parquet()


def test_database_boundary_before_native_connect(tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        Storage(db_path=tmp_path / "outside.duckdb")


def bundle() -> dict:
    return {
        "format": "pattern-ml-ranker-json-v1",
        "producer": "pattern_ml.choice.rank",
        "features": ["price"],
        "trees": [{"feature": 0, "threshold": 2.0, "default_left": True,
                   "missing_type": "NaN", "left": {"value": 1.0}, "right": {"value": -1.0}}],
    }


def write_bundle(body: dict) -> Path:
    from pattern_ml.choice.package25_artifacts import ARTIFACT_NAME

    path = config.get_settings().artifact_path(ARTIFACT_NAME)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(body))
    return path


def test_inert_json_scoring_and_feature_order() -> None:
    from pattern_ml.choice.package25_artifacts import load_ranker

    write_bundle(bundle())
    loaded = load_ranker(config.get_settings())
    assert loaded["features"] == ["price"]
    assert loaded["model"].predict([[1.0], [3.0], [float("nan")]]) == [1.0, -1.0, 1.0]


@pytest.mark.parametrize("change", [
    {"format": "pickle"}, {"producer": "unverifiable"}, {"features": ["chosen"]},
    {"features": ["price", "price"]}, {"trees": []}, {"extra": "unsupported"},
    {"trees": [{"value": float("inf")}]},
    {"trees": [{"feature": 9, "threshold": 1, "default_left": True, "missing_type": "NaN",
                "left": {"value": 1}, "right": {"value": 0}}]},
])
def test_unverifiable_json_rejected(change: dict) -> None:
    from pattern_ml.choice.package25_artifacts import load_ranker

    write_bundle(bundle() | change)
    with pytest.raises(ValueError):
        load_ranker(config.get_settings())


def test_legacy_opaque_artifact_never_loaded() -> None:
    from pattern_ml.choice.package25_artifacts import load_ranker

    path = config.get_settings().artifact_path("ranker.pkl")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"opaque legacy fixture; not serialized Python")
    with pytest.raises(ValueError, match="rank"):
        load_ranker(config.get_settings())


def test_model_symlink_rejected_before_json_read(tmp_path: Path) -> None:
    from pattern_ml.choice.package25_artifacts import ARTIFACT_NAME, load_ranker

    outside = tmp_path / "outside.json"
    outside.write_text(json.dumps(bundle()))
    directory = config.get_settings().artifacts_dir
    directory.mkdir()
    (directory / ARTIFACT_NAME).symlink_to(outside)
    with pytest.raises(ValueError):
        load_ranker(config.get_settings())


def test_model_writer_rejects_symlink_before_export(tmp_path: Path) -> None:
    from pattern_ml.choice.package25_artifacts import ARTIFACT_NAME, save_ranker

    outside = tmp_path / "outside.json"
    outside.write_text("untouched")
    directory = config.get_settings().artifacts_dir
    directory.mkdir()
    (directory / ARTIFACT_NAME).symlink_to(outside)
    result = SimpleNamespace(model=Mock(), features_used=["price"])
    with pytest.raises(ValueError):
        save_ranker(config.get_settings(), result)
    result.model.booster_.dump_model.assert_not_called()
    assert outside.read_text() == "untouched"


def test_ranker_export_roundtrip_uses_only_data() -> None:
    from pattern_ml.choice.package25_artifacts import load_ranker, save_ranker

    dump = {"objective": "lambdarank", "num_class": 1, "num_tree_per_iteration": 1,
            "average_output": False, "max_feature_idx": 0,
            "tree_info": [{"tree_structure": {"leaf_value": 0.5}}]}
    booster = Mock()
    booster.dump_model.return_value = dump
    result = SimpleNamespace(model=SimpleNamespace(booster_=booster), features_used=["price"])
    save_ranker(config.get_settings(), result)
    assert load_ranker(config.get_settings())["model"].predict([[1]]) == [0.5]
