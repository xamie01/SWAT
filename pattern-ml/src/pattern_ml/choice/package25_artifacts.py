"""Inert local ranker artifacts; never pickle or native model deserialization.

Only scalar numeric <= trees from our LightGBM lambdarank training seam are
supported. Unsupported categorical/linear/averaged models fail closed. The
producer/schema and same-user, non-writable regular-file checks establish a
local operator boundary, not signed provenance or financial/model validity.
Native LightGBM parity still requires an available reviewed runtime.
"""
from __future__ import annotations

import copy
import json
import math
import numbers
import os
from pathlib import Path
import stat
from typing import Any

from ..config import Settings
from .schema import FEATURE_COLUMNS

ARTIFACT_NAME = "ranker.json"
FORMAT = "pattern-ml-ranker-json-v1"
PRODUCER = "pattern_ml.choice.rank"
MAX_BYTES = 8 * 1024 * 1024
MAX_TREES = 1024
MAX_NODES = 50000
MAX_DEPTH = 64


def _number(value: Any) -> float:
    if type(value) not in (int, float):
        raise ValueError("Ranker numbers must be finite scalars")
    try:
        number = float(value)
    except OverflowError as exc:
        raise ValueError("Ranker numbers must be bounded finite scalars") from exc
    if not math.isfinite(number):
        raise ValueError("Ranker numbers must be finite scalars")
    return number


def _validate(bundle: Any) -> dict:
    if not isinstance(bundle, dict) or set(bundle) != {"format", "producer", "features", "trees"}:
        raise ValueError("Unsupported ranker artifact schema")
    if bundle["format"] != FORMAT or bundle["producer"] != PRODUCER:
        raise ValueError("Unverifiable ranker format/producer; retrain with pattern-ml rank")
    features = bundle["features"]
    if (not isinstance(features, list) or not features
            or any(not isinstance(f, str) or f not in FEATURE_COLUMNS for f in features)
            or len(set(features)) != len(features)):
        raise ValueError("Ranker features must be unique declared numeric features")
    trees = bundle["trees"]
    if not isinstance(trees, list) or not 1 <= len(trees) <= MAX_TREES:
        raise ValueError("Ranker tree count is out of bounds")
    count = 0

    def node(value: Any, depth: int) -> None:
        nonlocal count
        count += 1
        if count > MAX_NODES or depth > MAX_DEPTH or not isinstance(value, dict):
            raise ValueError("Ranker tree complexity is out of bounds")
        if set(value) == {"value"}:
            value["value"] = _number(value["value"])
            return
        if set(value) != {"feature", "threshold", "default_left", "missing_type", "left", "right"}:
            raise ValueError("Unsupported ranker tree node")
        if type(value["feature"]) is not int or not 0 <= value["feature"] < len(features):
            raise ValueError("Ranker split feature is out of bounds")
        value["threshold"] = _number(value["threshold"])
        if type(value["default_left"]) is not bool or value["missing_type"] not in ("None", "NaN"):
            raise ValueError("Unsupported ranker missing-value policy (Zero parity is unavailable)")
        node(value["left"], depth + 1)
        node(value["right"], depth + 1)

    for tree in trees:
        node(tree, 0)
    return bundle


class JsonRanker:
    """Data-only numeric tree evaluation through score_candidates.predict."""

    def __init__(self, bundle: dict) -> None:
        self._bundle = _validate(copy.deepcopy(bundle))

    def predict(self, matrix: Any) -> list[float]:
        scores = []
        for row in matrix:
            if len(row) != len(self._bundle["features"]):
                raise ValueError("Ranker matrix does not match feature order")
            values = []
            for item in row:
                if item is None:
                    values.append(math.nan)
                    continue
                if isinstance(item, bool) or not isinstance(item, numbers.Real):
                    raise ValueError("Ranker inputs must be real numeric scalars or missing")
                try:
                    value = float(item)
                except (OverflowError, ValueError) as exc:
                    raise ValueError("Ranker input is not a bounded scalar") from exc
                if math.isinf(value):
                    raise ValueError("Infinite ranker inputs are not supported")
                values.append(value)
            score = 0.0
            for tree in self._bundle["trees"]:
                node = tree
                while "value" not in node:
                    value = values[node["feature"]]
                    missing = math.isnan(value)
                    if node["missing_type"] == "None" and missing:
                        value, missing = 0.0, False
                    left = node["default_left"] if missing else value <= node["threshold"]
                    node = node["left"] if left else node["right"]
                score += node["value"]
            if not math.isfinite(score):
                raise ValueError("Non-finite ranker output")
            scores.append(score)
        return scores


def _local_file(info: os.stat_result) -> None:
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
            or info.st_nlink != 1 or info.st_mode & (stat.S_IWGRP | stat.S_IWOTH)
            or info.st_size > MAX_BYTES):
        raise ValueError("Ranker must be a bounded, same-user, non-writable regular file")


def _pairs(pairs: list[tuple[str, Any]]) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate ranker JSON key")
        result[key] = value
    return result


def load_ranker(settings: Settings) -> dict:
    path = settings.artifact_path(ARTIFACT_NAME)
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as handle:
            _local_file(os.fstat(handle.fileno()))
            data = handle.read(MAX_BYTES + 1)
        if len(data) > MAX_BYTES:
            raise ValueError("Ranker artifact is too large")
        bundle = _validate(json.loads(data, object_pairs_hook=_pairs))
    except (OSError, UnicodeError, json.JSONDecodeError, RecursionError) as exc:
        raise ValueError("No valid local JSON ranker; run pattern-ml rank (legacy pickle is refused)") from exc
    return {"features": bundle["features"], "model": JsonRanker(bundle)}


def _export(result: Any) -> dict:
    # dump_model is called ONLY on the in-memory result of trusted local
    # training. No Booster(model_file/model_str) or arbitrary artifact loader.
    features = _validate({"format": FORMAT, "producer": PRODUCER,
                          "features": result.features_used, "trees": [{"value": 0.0}]})["features"]
    dump = result.model.booster_.dump_model()
    objective = dump.get("objective") if isinstance(dump, dict) else None
    # LightGBM's objective serializer includes its default sigmoid parameter.
    # These are the only contracts produced by _make_ranker; no prefix match
    # that might admit another objective or arbitrary parameter semantics.
    if (not isinstance(dump, dict) or objective not in ("lambdarank", "lambdarank sigmoid:1")
            or any(type(dump.get(key)) is not int for key in
                   ("num_class", "num_tree_per_iteration", "max_feature_idx"))
            or dump["num_class"] != 1 or dump["num_tree_per_iteration"] != 1
            or dump.get("average_output") is not False
            or dump["max_feature_idx"] != len(features) - 1):
        raise ValueError("Only locally trained scalar lambdarank models can be exported")
    # train_ranker fits a numpy matrix, so LightGBM normally supplies Column_i.
    # Named dumps must preserve the very same order, never silently reorder.
    if ("feature_names" in dump and dump["feature_names"] not in
            (features, [f"Column_{i}" for i in range(len(features))])):
        raise ValueError("Ranker dump feature order does not match local training")
    count = 0

    def convert(node: dict, depth: int = 0) -> dict:
        nonlocal count
        count += 1
        if count > MAX_NODES or depth > MAX_DEPTH or not isinstance(node, dict):
            raise ValueError("Ranker tree complexity is out of bounds")
        if "leaf_value" in node:
            # Numeric leaf dump keys, including the single-leaf root variant.
            # Unknown semantics (linear leaves, children, etc.) are not erased.
            if set(node) - {"leaf_index", "leaf_value", "leaf_weight", "leaf_count"}:
                raise ValueError("Unsupported numeric leaf metadata")
            return {"value": _number(node["leaf_value"])}
        if set(node) - {"split_index", "split_feature", "split_gain", "threshold",
                        "decision_type", "default_left", "missing_type",
                        "internal_value", "internal_weight", "internal_count",
                        "left_child", "right_child"}:
            raise ValueError("Unsupported numeric split metadata")
        if node.get("decision_type") != "<=":
            raise ValueError("Categorical/non-numeric splits are not supported")
        return {"feature": node["split_feature"], "threshold": node["threshold"],
                "default_left": node["default_left"], "missing_type": node["missing_type"],
                "left": convert(node["left_child"], depth + 1),
                "right": convert(node["right_child"], depth + 1)}

    def convert_tree(tree: dict, index: int) -> dict:
        if (not isinstance(tree, dict) or set(tree) - {
                "tree_index", "num_leaves", "num_cat", "shrinkage", "tree_structure"}
                or ("tree_index" in tree and (type(tree["tree_index"]) is not int or tree["tree_index"] != index))
                or ("num_cat" in tree and (type(tree["num_cat"]) is not int or tree["num_cat"] != 0))):
            raise ValueError("Unsupported local tree metadata")
        converted = convert(tree["tree_structure"])
        def leaves(node: dict) -> int:
            return 1 if "value" in node else leaves(node["left"]) + leaves(node["right"])
        if "num_leaves" in tree and (type(tree["num_leaves"]) is not int or tree["num_leaves"] != leaves(converted)):
            raise ValueError("Ranker leaf count does not match tree")
        # dump_model leaf values already include shrinkage: never multiply again.
        if "shrinkage" in tree and _number(tree["shrinkage"]) <= 0:
            raise ValueError("Unsupported tree shrinkage")
        return converted

    trees = dump.get("tree_info")
    if not isinstance(trees, list) or not 1 <= len(trees) <= MAX_TREES:
        raise ValueError("Ranker tree count is out of bounds")
    try:
        bundle = {"format": FORMAT, "producer": PRODUCER, "features": result.features_used,
                  "trees": [convert_tree(tree, index) for index, tree in enumerate(trees)]}
    except (KeyError, TypeError, AttributeError) as exc:
        raise ValueError("Unsupported local LightGBM tree dump") from exc
    return _validate(bundle)


def save_ranker(settings: Settings, result: Any) -> Path:
    path = settings.artifact_path(ARTIFACT_NAME)
    if path.exists():
        _local_file(path.lstat())
    bundle = _export(result)
    data = json.dumps(bundle, allow_nan=False, separators=(",", ":")).encode()
    if len(data) > MAX_BYTES:
        raise ValueError("Ranker artifact is too large")
    settings.artifacts_dir.mkdir(parents=True, exist_ok=True)
    tmp = settings.artifact_path(ARTIFACT_NAME + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        settings.artifact_path(ARTIFACT_NAME)
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)
    return path
