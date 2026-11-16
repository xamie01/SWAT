"""Local storage: a DuckDB warehouse plus immutable Parquet staging.

Nothing here touches the main SWAT Postgres. Every byte lives under
``data/``, so this tool can be developed, reset, or shipped as a microservice
without any risk to the wider project's database.

Two tiers on purpose:

* **Parquet, ``data/raw/``** — exactly what each API returned, never rewritten.
  Re-normalizing 2M trades after a rule change is then a local, free operation
  instead of another multi-hour rate-limited pull.
* **DuckDB, ``data/warehouse.duckdb``** — normalized, queryable, indexed. This
  is what the feature and model layers read.
"""

from __future__ import annotations

import hashlib
import os
from pathlib import Path
import stat
import tempfile
from typing import Any

import duckdb
import polars as pl

from .config import CHAINS, KolRosterError, _normalize_address, confined_path, get_settings
from .schema import CANONICAL_TRADE_SCHEMA, POSITION_SCHEMA, conform, empty_frame


class Storage:
    """The pattern_ml warehouse. Cheap to construct; opens lazily."""

    def __init__(self, db_path: Path | None = None) -> None:
        settings = get_settings()
        self._db_path = confined_path(db_path or settings.db_path)
        self._conn: duckdb.DuckDBPyConnection | None = None
        settings.ensure_dirs()

    # -- connection ----------------------------------------------------------

    @property
    def conn(self) -> duckdb.DuckDBPyConnection:
        if self._conn is None:
            self._conn = duckdb.connect(str(confined_path(self._db_path)))
            self._init_schema()
        return self._conn

    def close(self) -> None:
        if self._conn is not None:
            self._conn.close()
            self._conn = None

    def __enter__(self) -> "Storage":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def _init_schema(self) -> None:
        conn = self._conn
        assert conn is not None
        conn.execute(
            f"CREATE TABLE IF NOT EXISTS trades ("
            f"{_schema_ddl(CANONICAL_TRADE_SCHEMA)}, PRIMARY KEY (trade_id))"
        )
        conn.execute(
            f"CREATE TABLE IF NOT EXISTS positions ("
            f"{_schema_ddl(POSITION_SCHEMA)}, PRIMARY KEY (position_id))"
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS source_checkpoints (
                key VARCHAR PRIMARY KEY,
                last_ts TIMESTAMP,
                last_ref VARCHAR,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        # DuckDB maintains zone maps automatically; these indexes exist for the
        # highly selective point lookups (one KOL, one market) the CLI does.
        conn.execute("CREATE INDEX IF NOT EXISTS idx_trades_kol ON trades(kol_address)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_trades_market ON trades(market_id)")
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_positions_kol ON positions(kol_address)"
        )

    # -- raw Parquet staging -------------------------------------------------

    def write_raw_parquet(self, chain: str, kol_address: str, df: pl.DataFrame) -> Path:
        """Persist one KOL's raw pull. Content-addressed, so re-pulling the
        same history overwrites nothing and creates no duplicate file."""
        if chain not in CHAINS:
            raise ValueError("Unsupported raw storage chain")
        try:
            address = _normalize_address(kol_address, chain)
        except KolRosterError as exc:
            raise ValueError("Invalid raw storage address") from exc
        settings = get_settings()
        partition = confined_path(settings.raw_dir / chain / address, root=settings.raw_dir)
        partition.mkdir(parents=True, exist_ok=True)

        fd, filename = tempfile.mkstemp(prefix=".raw-", suffix=".tmp", dir=partition)
        os.close(fd)
        tmp = confined_path(Path(filename), root=settings.raw_dir)
        try:
            df.write_parquet(tmp, compression="zstd")
            tmp = confined_path(tmp, root=settings.raw_dir)
            digest = _raw_digest(tmp)
            path = confined_path(partition / f"{digest}.parquet", root=settings.raw_dir)
            if path.exists():
                if not path.is_file() or _raw_digest(path) != digest:
                    raise ValueError("Raw staging content does not match its fingerprint")
            else:
                # Exclusive publication, never overwrite an existing pull. Native
                # writers still require a trusted non-concurrent same-user root.
                os.link(tmp, path, follow_symlinks=False)
            return path
        finally:
            tmp.unlink(missing_ok=True)

    def list_raw_parquet(self, chain: str | None = None) -> list[Path]:
        settings = get_settings()
        if chain is not None and chain not in CHAINS:
            raise ValueError("Unsupported raw storage chain")
        root = confined_path(settings.raw_dir / chain if chain else settings.raw_dir)
        # Validate entries, not just filenames: directory symlinks must not be
        # silently skipped or traversed by an implementation-specific glob.
        for entry in root.rglob("*") if root.exists() else []:
            confined_path(entry, root=settings.raw_dir)
        paths = sorted(confined_path(path, root=settings.raw_dir)
                       for path in root.rglob("*.parquet")) if root.exists() else []
        if any(not path.is_file() for path in paths):
            raise ValueError("Raw Parquet entries must be regular files")
        return paths

    # -- trades --------------------------------------------------------------

    def insert_trades(self, df: pl.DataFrame) -> int:
        """Insert normalized trades, ignoring ones already stored.

        Returns the number of genuinely new rows.
        """
        if df.is_empty():
            return 0
        conformed = conform(df, CANONICAL_TRADE_SCHEMA)
        before = self.count_trades()
        # Register explicitly rather than leaning on DuckDB's replacement scan
        # of local Python names — that breaks as soon as this is called from a
        # different frame (a thread, a comprehension).
        self.conn.register("_incoming_trades", conformed.to_arrow())
        try:
            self.conn.execute(
                "INSERT INTO trades SELECT * FROM _incoming_trades "
                "ON CONFLICT (trade_id) DO NOTHING"
            )
        finally:
            self.conn.unregister("_incoming_trades")
        # DuckDB has no `changes()`; diff the count.
        return self.count_trades() - before

    def get_trades(
        self,
        *,
        kol_address: str | None = None,
        chain: str | None = None,
        market_id: str | None = None,
        limit: int | None = None,
    ) -> pl.DataFrame:
        clauses, params = _filters(
            kol_address=kol_address, chain=chain, market_id=market_id
        )
        sql = f"SELECT * FROM trades{clauses} ORDER BY ts"
        if limit:
            sql += f" LIMIT {int(limit)}"
        return self.conn.execute(sql, params).pl()

    def count_trades(
        self, *, kol_address: str | None = None, chain: str | None = None
    ) -> int:
        clauses, params = _filters(kol_address=kol_address, chain=chain)
        row = self.conn.execute(
            f"SELECT COUNT(*) FROM trades{clauses}", params
        ).fetchone()
        return int(row[0]) if row else 0

    # -- positions -----------------------------------------------------------

    def rebuild_positions(self) -> int:
        """Recompute every position from the trade table.

        A full rebuild rather than an incremental update: position boundaries
        depend on the whole inventory history of a (kol, market), so a late
        backfill of old trades can legitimately reshape positions that were
        already written.
        """
        # Local import keeps the module graph acyclic.
        from .index.positions import build_positions

        trades = self.get_trades()
        positions = build_positions(trades)

        self.conn.execute("DELETE FROM positions")
        if positions.is_empty():
            return 0

        self.conn.register("_incoming_positions", positions.to_arrow())
        try:
            self.conn.execute("INSERT INTO positions SELECT * FROM _incoming_positions")
        finally:
            self.conn.unregister("_incoming_positions")
        return positions.height

    def get_positions(
        self,
        *,
        kol_address: str | None = None,
        chain: str | None = None,
        closed_only: bool = False,
        labelled_only: bool = False,
    ) -> pl.DataFrame:
        clauses, params = _filters(kol_address=kol_address, chain=chain)
        extra: list[str] = []
        if closed_only:
            extra.append("is_closed")
        if labelled_only:
            extra.append("is_win IS NOT NULL")
        if extra:
            joiner = " AND " if clauses else " WHERE "
            clauses = f"{clauses}{joiner}{' AND '.join(extra)}"
        return self.conn.execute(
            f"SELECT * FROM positions{clauses} ORDER BY opened_at", params
        ).pl()

    # -- generic -------------------------------------------------------------

    def sql(self, query: str, params: list[Any] | None = None) -> pl.DataFrame:
        """Escape hatch for ad-hoc analysis against the warehouse."""
        return self.conn.execute(query, params or []).pl()

    def get_checkpoint(self, key: str) -> tuple[Any, str] | None:
        row = self.conn.execute(
            "SELECT last_ts, last_ref FROM source_checkpoints WHERE key = ?", [key]
        ).fetchone()
        return (row[0], row[1]) if row else None

    def set_checkpoint(self, key: str, last_ts: Any, last_ref: str | None) -> None:
        self.conn.execute(
            """
            INSERT INTO source_checkpoints (key, last_ts, last_ref, updated_at)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT (key) DO UPDATE SET
                last_ts = EXCLUDED.last_ts,
                last_ref = EXCLUDED.last_ref,
                updated_at = CURRENT_TIMESTAMP
            """,
            [key, last_ts, last_ref],
        )


def _raw_digest(path: Path) -> str:
    digest = hashlib.sha256()
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode):
            raise ValueError("Raw staging must be a regular file")
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
        os.fsync(handle.fileno())
    return digest.hexdigest()


def _filters(**kwargs: str | None) -> tuple[str, list[Any]]:
    """Build a parameterized WHERE clause.

    Parameterized rather than interpolated: addresses and market ids are
    attacker-influenced strings from an external API, and a market title with
    an apostrophe would break a naive f-string query outright.
    """
    column_for = {
        "kol_address": "kol_address",
        "chain": "chain",
        "market_id": "market_id",
    }
    clauses: list[str] = []
    params: list[Any] = []
    for key, value in kwargs.items():
        if value is None:
            continue
        clauses.append(f"{column_for[key]} = ?")
        params.append(value)
    return (f" WHERE {' AND '.join(clauses)}" if clauses else "", params)


def _schema_ddl(schema: dict[str, pl.DataType]) -> str:
    return ", ".join(f"{name} {_duckdb_type(dtype)}" for name, dtype in schema.items())


def _duckdb_type(dtype: pl.DataType) -> str:
    if dtype == pl.Utf8:
        return "VARCHAR"
    if dtype == pl.Float64:
        return "DOUBLE"
    if dtype == pl.Int32:
        return "INTEGER"
    if dtype == pl.Int64:
        return "BIGINT"
    if dtype == pl.Boolean:
        return "BOOLEAN"
    if isinstance(dtype, pl.Datetime):
        return "TIMESTAMP WITH TIME ZONE"
    raise ValueError(f"No DuckDB mapping for Polars dtype {dtype}")


def get_storage() -> Storage:
    return Storage()


__all__ = ["Storage", "get_storage", "empty_frame"]
