"""Run archival and human-readable reporting.

Two problems this solves.

**Runs overwrite each other.** ``artifacts/`` holds only the latest mine, so
March's claims are gone by April — and comparing what a pattern *claimed*
against what it later *did* is the only test that isn't retrospective. Every
run is therefore snapshotted under ``reports/<run_id>/``.

**Parquet is not readable.** The artefacts are columnar binary: fast, compact,
and impossible to skim. Each run also gets a Markdown summary you can open,
diff, or paste into a message.

The run id is a UTC timestamp, so directory listing sorts chronologically.
"""

from __future__ import annotations

import json
import shutil
from datetime import datetime, timezone
from pathlib import Path

import polars as pl

from .config import get_settings

# Copied into each snapshot. Everything a later comparison might need.
SNAPSHOT_FILES = (
    "sequence_patterns.parquet",
    "clusters.parquet",
    "cluster_assignments.parquet",
    "feature_importance.parquet",
    "model_summary.json",
    "features.parquet",
    "equity_curve.parquet",
)

# `model.pkl` is deliberately excluded by default — a booster is megabytes and
# snapshotting one per nightly run fills a disk for no analytical gain.
LARGE_FILES = ("model.pkl",)


def new_run_id(now: datetime | None = None) -> str:
    return (now or datetime.now(timezone.utc)).strftime("%Y%m%dT%H%M%SZ")


def snapshot_run(
    run_id: str | None = None, *, include_model: bool = False
) -> Path | None:
    """Copy the current artefacts into ``reports/<run_id>/``.

    Returns the snapshot directory, or ``None`` if there was nothing to archive.
    """
    settings = get_settings()
    run_id = run_id or new_run_id()
    destination = settings.reports_dir / run_id
    destination.mkdir(parents=True, exist_ok=True)

    names = SNAPSHOT_FILES + (LARGE_FILES if include_model else ())
    copied = 0
    for name in names:
        source = settings.artifacts_dir / name
        if source.exists():
            shutil.copy2(source, destination / name)
            copied += 1

    if copied == 0:
        destination.rmdir()
        return None
    return destination


def list_runs() -> list[Path]:
    """Archived runs, oldest first."""
    reports = get_settings().reports_dir
    if not reports.exists():
        return []
    return sorted(p for p in reports.iterdir() if p.is_dir())


def _fmt_pct(value: object) -> str:
    if value is None or not isinstance(value, (int, float)):
        return "—"
    return f"{value:.1%}"


def _patterns_section(directory: Path) -> list[str]:
    path = directory / "sequence_patterns.parquet"
    if not path.exists():
        return ["_No sequential patterns were mined._"]

    frame = pl.read_parquet(path)
    if frame.is_empty():
        return ["_No patterns had enough support to test._"]

    survivors = frame.filter(pl.col("survives_fdr"))
    lines = [
        f"- Candidates tested: **{frame.height}**",
        f"- Survived correction + confidence gate: **{survivors.height}**",
        "",
    ]

    if survivors.is_empty():
        lines += [
            "**No pattern survived.**",
            "",
            "This is a normal, informative result: nothing here beats the base "
            "rate by more than multiple-testing noise explains. Do not trade "
            "anything from this run.",
            "",
            "Strongest non-surviving candidates, for reference only:",
            "",
        ]
        shown = frame.sort("lift", descending=True).head(5)
    else:
        lines += ["**Surviving patterns:**", ""]
        shown = survivors.sort("lift", descending=True).head(20)

    lines += [
        "| Pattern | N | Win rate | Baseline | Lift | CI low | p |",
        "|---|---:|---:|---:|---:|---:|---:|",
    ]
    for row in shown.iter_rows(named=True):
        lines.append(
            f"| `{row['pattern']}` | {row['support']} | "
            f"{_fmt_pct(row['win_rate'])} | {_fmt_pct(row['baseline'])} | "
            f"{_fmt_pct(row['lift'])} | {_fmt_pct(row['ci_low'])} | "
            f"{row['p_value']:.4f} |"
        )
    return lines


def _archetypes_section(directory: Path) -> list[str]:
    path = directory / "clusters.parquet"
    if not path.exists():
        return ["_No clustering was run._"]

    frame = pl.read_parquet(path)
    if "is_noise" in frame.columns:
        frame = frame.filter(~pl.col("is_noise"))
    if frame.is_empty():
        return ["_No archetypes were found._"]

    lines = [
        "| Cluster | N | Win rate | Baseline | Lift | CI low | Holds? |",
        "|---:|---:|---:|---:|---:|---:|:---:|",
    ]
    for row in frame.sort("lift", descending=True).head(15).iter_rows(named=True):
        lines.append(
            f"| {row['cluster']} | {row['n']} | {_fmt_pct(row['win_rate'])} | "
            f"{_fmt_pct(row['baseline'])} | {_fmt_pct(row['lift'])} | "
            f"{_fmt_pct(row['ci_low'])} | "
            f"{'yes' if row['beats_baseline'] else 'no'} |"
        )
    return lines


def _model_section(directory: Path) -> list[str]:
    path = directory / "model_summary.json"
    if not path.exists():
        return ["_No model was trained._"]

    summary = json.loads(path.read_text())
    auc = summary.get("mean_auc")
    lines = [
        f"- Walk-forward AUC: **{auc:.3f}**" if auc else "- Walk-forward AUC: —",
        f"- Base rate: {_fmt_pct(summary.get('base_rate'))}",
        f"- Labelled positions: {summary.get('n_samples', 0):,}",
    ]
    if auc is not None and auc < 0.55:
        lines += [
            "",
            "AUC is near chance. On this roster these features do not predict "
            "outcomes — a real finding, not a failure.",
        ]

    importance = directory / "feature_importance.parquet"
    if importance.exists():
        frame = pl.read_parquet(importance)
        if not frame.is_empty():
            lines += ["", "**Most informative features (out-of-sample):**", ""]
            for row in frame.head(8).iter_rows(named=True):
                lines.append(f"- `{row['feature']}` — {row['importance']:+.4f}")
    return lines


def write_report(directory: Path | None = None, run_id: str | None = None) -> Path:
    """Render a Markdown summary of one run's artefacts.

    Written into the run directory as ``REPORT.md`` so the snapshot is
    self-describing.
    """
    settings = get_settings()
    directory = directory or settings.artifacts_dir
    generated = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    lines = [
        f"# Pattern report — {run_id or directory.name}",
        "",
        f"Generated {generated}",
        "",
        "## How to read this",
        "",
        "A pattern is only actionable when **all** of these hold:",
        "",
        "1. `N` is large enough that the win rate means something",
        "2. It survived multiple-testing correction (`survives_fdr`)",
        "3. `CI low` — the *bottom* of the plausible range — clears the baseline",
        "4. It stayed profitable in `pattern-ml validate`, after slippage and fees",
        "5. It beat random selection from the same roster",
        "",
        "A high win rate alone means nothing. Test enough patterns and some "
        "will look excellent by chance; gates 2 and 3 exist to catch exactly that.",
        "",
        "## Sequential patterns",
        "",
        *_patterns_section(directory),
        "",
        "## Archetypes",
        "",
        *_archetypes_section(directory),
        "",
        "## Supervised model",
        "",
        *_model_section(directory),
        "",
        "---",
        "",
        "Not investment advice. Every number here is measured on historical "
        "data; none of it has been tested forward on trades that had not yet "
        "happened when the pattern was found.",
        "",
    ]

    path = directory / "REPORT.md"
    path.write_text("\n".join(lines))
    return path
