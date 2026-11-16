"""Shared test fixtures.

The critical job here is isolation. ``get_settings()`` is ``lru_cache``d and
resolves paths from the environment, so without this a test that touches
``Storage`` would happily read and write the developer's real warehouse — and,
worse, would pass while doing it.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest

from pattern_ml import config
from pattern_ml.config import get_settings


@pytest.fixture(autouse=True)
def isolated_settings(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Point every path-producing setting at a per-test temp directory."""
    project = tmp_path / "project"
    project.mkdir()
    monkeypatch.setattr(config, "PROJECT_ROOT", project)
    monkeypatch.setattr(config, "_load_env", lambda: None)
    monkeypatch.setenv("PATTERN_ML_DATA_DIR", str(project / "data"))
    monkeypatch.setenv("PATTERN_ML_DB", str(project / "data" / "test.duckdb"))
    # Never let a real key leak into a test run and fire a live request.
    # `config` reads the repo-root .env as a fallback, so a key present there
    # would otherwise reach the provider tests.
    monkeypatch.delenv("HELIUS_API_KEY", raising=False)
    monkeypatch.delenv("BITQUERY_TOKEN", raising=False)
    monkeypatch.delenv("BITQUERY_API_KEY", raising=False)

    # The settings cache would otherwise hand back paths from a previous test.
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture
def roster_file(tmp_path: Path) -> Path:
    """A minimal, valid KOL roster."""
    path = tmp_path / "kols.yaml"
    path.write_text(
        "solana:\n"
        "  - address: 5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1\n"
        "    handle: sol-kol\n"
        "polymarket:\n"
        '  - address: "0x1111111111111111111111111111111111111111"\n'
        "    handle: pm-kol\n"
    )
    return path
