"""Dependency-free SOURCE contracts, not Python/model runtime acceptance.

Run this explicit file with python -I -S through the shared locked runner.
It reads/compiles source only: no project imports or executable artifacts.
"""
from pathlib import Path
import ast
import json
import sys

ROOT = Path(__file__).resolve().parents[1]
MODE = sys.argv[1]
FILES = [
    ROOT / "src/pattern_ml/config.py",
    ROOT / "src/pattern_ml/storage.py",
    ROOT / "src/pattern_ml/cli.py",
    ROOT / "src/pattern_ml/choice/package25_artifacts.py",
    ROOT / "src/pattern_ml/choice/rank.py",
    ROOT / "tests/conftest.py",
    ROOT / "tests/test_package25_ml_security.py",
    ROOT / "tests/native/test_package25_native_parity.py",
]


def source(name):
    return (ROOT / "src/pattern_ml" / name).read_text()


def calls(text):
    return [ast.unparse(n.func) for n in ast.walk(ast.parse(text)) if isinstance(n, ast.Call)]


def functions(text):
    return {n.name: ast.get_source_segment(text, n) for n in ast.walk(ast.parse(text))
            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))}


def check_no_executable_deserialization():
    text = source("cli.py")
    assert not any(n in calls(text) for n in ("pickle.load", "pickle.dump", "joblib.load"))


def check_public_rank_score_wiring():
    funcs = functions(source("cli.py"))
    assert "save_ranker" in calls(funcs["rank"])
    assert "load_ranker" in calls(funcs["score"])
    assert funcs["score"].index("load_ranker(") < funcs["score"].index("PolymarketSnapshotProvider")


def check_config_boundary():
    funcs = functions(source("config.py"))
    assert "confined_path" in calls(funcs["_resolve"])
    assert "confined_path" in calls(funcs["ensure_dirs"])
    assert "confined_path" in calls(funcs["artifact_path"])
    assert "is_symlink" in funcs["confined_path"] and ".." in funcs["confined_path"]


def check_public_raw_boundary():
    funcs = functions(source("storage.py"))
    text = funcs["write_raw_parquet"]
    assert text.index("_normalize_address(") < text.index("mkdir(") < text.index("write_parquet(")
    assert text.count("confined_path(") >= 2
    assert "confined_path" in calls(funcs["conn"])
    assert "confined_path" in calls(funcs["list_raw_parquet"])


def check_address_parsing():
    text = functions(source("config.py"))["_normalize_address"]
    assert "fullmatch" in text and "bit_length" in text and "32" in text


def check_inert_bounded_schema():
    text = source("choice/package25_artifacts.py")
    assert "json.loads" in calls(text)
    assert not any(n in calls(text) for n in ("eval", "exec", "pickle.load", "Booster"))
    assert "MAX_BYTES" in text and "MAX_NODES" in text and "MAX_DEPTH" in text
    assert "FEATURE_COLUMNS" in text and "producer" in text and "lambdarank" in text
    assert "O_NOFOLLOW" in text and "fstat" in text and "S_IWOTH" in text


def check_test_isolation():
    text = (ROOT / "tests/conftest.py").read_text()
    assert '"_load_env"' in text and '"PROJECT_ROOT"' in text


def check_fixture_seams():
    text = (ROOT / "tests/test_package25_ml_security.py").read_text()
    for call in ("storage.write_raw_parquet", "storage.list_raw_parquet", "Storage", "load_ranker", "save_ranker"):
        assert call in calls(text)
    assert not any(n in calls(text) for n in ("pickle.loads", "pickle.load", "subprocess.run"))


def check_stable_ties():
    funcs = functions(source("choice/rank.py"))
    for name in ("_reciprocal_rank", "_ndcg"):
        sorts = [n for n in ast.walk(ast.parse(funcs[name]))
                 if isinstance(n, ast.Call) and ast.unparse(n.func) == "np.argsort"]
        assert sorts and all(any(k.arg == "kind" and ast.literal_eval(k.value) == "stable"
                                 for k in n.keywords) for n in sorts)
    sorts = [n for n in ast.walk(ast.parse(funcs["score_candidates"]))
             if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == "sort"]
    assert len(sorts) == 1 and any(k.arg == "maintain_order" and ast.literal_eval(k.value) is True
                                 for k in sorts[0].keywords)


def check_native_parity_gate_is_real_and_isolated():
    text = (ROOT / "tests/native/test_package25_native_parity.py").read_text()
    funcs = functions(text)
    assert funcs["native"].index("PATTERN_ML_NATIVE_PARITY") < funcs["native"].index("importorskip(")
    assert "--confcutdir" in text and '"pattern_ml" in sys.modules' in funcs["native"]
    assert all(f'"{name}"' in funcs["native"] for name in ("lightgbm", "numpy", "polars"))
    assert "train_ranker" in funcs["test_native_train_ranker_public_export_and_group_seam"]
    assert "_group_sizes" in calls(text) or "native.rank._group_sizes" in calls(text)
    for call in ("artifacts.save_ranker", "artifacts.load_ranker", "np.testing.assert_array_equal",
                 "native.rank.score_candidates", "model.fit"):
        assert call in calls(text)
    assert "np.nextafter" in calls(text) and "per_tree" in text and "with_none" in text
    assert not any(n in calls(text) for n in ("Mock", "patch", "pickle.load", "joblib.load", "subprocess.run"))
    imports = [n for n in ast.walk(ast.parse(text)) if isinstance(n, (ast.Import, ast.ImportFrom))]
    assert not any(isinstance(n, ast.ImportFrom) and n.module and n.module.startswith("pattern_ml") for n in imports)
    assert "storage.py" not in funcs["native"] and "providers" not in funcs["native"]


checks = [check_no_executable_deserialization, check_public_rank_score_wiring,
          check_config_boundary, check_public_raw_boundary, check_address_parsing,
          check_inert_bounded_schema, check_test_isolation, check_fixture_seams,
          check_stable_ties, check_native_parity_gate_is_real_and_isolated]
if MODE == "neighbors":
    FILES = [ROOT / "tests" / f for f in ("test_config.py", "test_rank.py", "test_normalize.py", "test_positions.py")]
    checks = []
results = []
for path in FILES:
    if not path.exists():
        continue
    text = path.read_text()
    compile(text, str(path), "exec", dont_inherit=True)
    results.append({"file": str(path), "syntax": "passed"})
failures = []
for check in checks:
    try:
        check()
    except (AssertionError, FileNotFoundError, KeyError, ValueError) as exc:
        failures.append({"check": check.__name__, "error": str(exc) or "source contract absent"})
report = {"mode": MODE, "qualification": "SOURCE AST/static only; pytest/model runtime blocked",
          "files": results, "staticAssertions": {"passed": len(checks) - len(failures), "failed": len(failures), "skipped": 0},
          "failures": failures}
print(json.dumps(report, indent=2))
raise SystemExit(1 if failures else 0)
