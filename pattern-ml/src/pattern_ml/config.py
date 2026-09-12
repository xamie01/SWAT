"""Configuration and KOL roster loading.

Everything pattern_ml reads or writes lives under this package's own directory.
The one exception is *reading* the repo-root ``.env`` as a fallback for API
keys, so a Helius key doesn't have to be duplicated. Nothing is ever written
outside the project directory.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import datetime
from functools import lru_cache
from pathlib import Path

import yaml
from dotenv import load_dotenv

# src/pattern_ml/config.py -> pattern-ml/
PACKAGE_ROOT = Path(__file__).resolve().parent
PROJECT_ROOT = PACKAGE_ROOT.parent.parent
REPO_ROOT = PROJECT_ROOT.parent

Chain = str  # "solana" | "polymarket"
CHAINS: tuple[str, ...] = ("solana", "polymarket")


def _load_env() -> None:
    """Load the local .env first, then fall back to the repo-root .env.

    ``load_dotenv`` does not override already-set keys, so the local file wins
    and the repo-root file only fills gaps.
    """
    load_dotenv(PROJECT_ROOT / ".env")
    load_dotenv(REPO_ROOT / ".env")


def _env_float(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _env_int(name: str, default: int) -> int:
    return int(_env_float(name, default))


@dataclass(frozen=True)
class Kol:
    """One tracked trader on one chain."""

    address: str
    chain: Chain
    handle: str | None = None
    tags: tuple[str, ...] = ()
    note: str | None = None
    since: datetime | None = None

    @property
    def label(self) -> str:
        """Human-readable identity for reports."""
        if self.handle:
            return self.handle
        return f"{self.address[:6]}…{self.address[-4:]}"

    @property
    def key(self) -> str:
        """Stable unique id across chains."""
        return f"{self.chain}:{self.address}"


@dataclass(frozen=True)
class Settings:
    helius_api_key: str | None
    bitquery_token: str | None
    polymarket_data_api: str
    data_dir: Path
    db_path: Path
    solana_max_rps: float
    polymarket_max_rps: float
    bitquery_max_rps: float
    source_concurrency: int

    @property
    def raw_dir(self) -> Path:
        return self.data_dir / "raw"

    @property
    def checkpoint_dir(self) -> Path:
        return self.data_dir / "checkpoints"

    @property
    def artifacts_dir(self) -> Path:
        return PROJECT_ROOT / "artifacts"

    @property
    def reports_dir(self) -> Path:
        return PROJECT_ROOT / "reports"

    def ensure_dirs(self) -> None:
        for path in (
            self.data_dir,
            self.raw_dir,
            self.checkpoint_dir,
            self.artifacts_dir,
            self.reports_dir,
        ):
            path.mkdir(parents=True, exist_ok=True)


def _resolve(path_str: str) -> Path:
    path = Path(path_str)
    return path if path.is_absolute() else PROJECT_ROOT / path


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    _load_env()
    return Settings(
        helius_api_key=os.getenv("HELIUS_API_KEY") or None,
        # Bitquery reconstructs the Solana opportunity set. Accepts either name
        # so an existing BITQUERY_API_KEY in the repo-root .env still works.
        bitquery_token=(
            os.getenv("BITQUERY_TOKEN") or os.getenv("BITQUERY_API_KEY") or None
        ),
        polymarket_data_api=(
            os.getenv("POLYMARKET_DATA_API") or "https://data-api.polymarket.com"
        ).rstrip("/"),
        data_dir=_resolve(os.getenv("PATTERN_ML_DATA_DIR") or "data"),
        db_path=_resolve(os.getenv("PATTERN_ML_DB") or "data/warehouse.duckdb"),
        solana_max_rps=_env_float("SOLANA_MAX_RPS", 8.0),
        polymarket_max_rps=_env_float("POLYMARKET_MAX_RPS", 15.0),
        # Deliberately low: Bitquery bills points per minute, and a long
        # reconstruction cut off halfway leaves a half-written training set.
        bitquery_max_rps=_env_float("BITQUERY_MAX_RPS", 2.0),
        source_concurrency=_env_int("SOURCE_CONCURRENCY", 4),
    )


class KolRosterError(RuntimeError):
    """The KOL roster is missing or malformed."""


def _coerce_since(value: object) -> datetime | None:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value
    if isinstance(value, str):
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    raise KolRosterError(f"Unparseable `since` value: {value!r}")


def _normalize_address(address: object, chain: Chain) -> str:
    if not isinstance(address, str) or not address.strip():
        raise KolRosterError(f"A {chain} entry is missing a non-empty `address`")
    addr = address.strip()
    # Tolerate chain-prefixed addresses pasted over from the main SWAT DB.
    for prefix in ("solana:", "polygon:", "polymarket:", "robinhood-chain:"):
        if addr.lower().startswith(prefix):
            addr = addr[len(prefix) :]
            break
    if chain == "polymarket":
        # EVM addresses are case-insensitive; lowercase so joins can't miss.
        if not addr.lower().startswith("0x") or len(addr) != 42:
            raise KolRosterError(
                f"Polymarket address must be a 42-char 0x… EVM address, got {addr!r}"
            )
        return addr.lower()
    # Solana base58 is case-SENSITIVE — never fold case here.
    if addr.lower().startswith("0x"):
        raise KolRosterError(
            f"{addr!r} looks like an EVM address but is listed under `solana:`"
        )
    return addr


def load_kols(path: Path | None = None) -> list[Kol]:
    """Read the curated KOL roster.

    Returns every tracked trader across all chains, in file order.
    """
    roster_path = path or (PROJECT_ROOT / "config" / "kols.yaml")
    if not roster_path.exists():
        example = PROJECT_ROOT / "config" / "kols.example.yaml"
        raise KolRosterError(
            f"No KOL roster at {roster_path}.\n"
            f"Create one with:  cp {example} {roster_path}\n"
            "then add the wallet addresses you want to track."
        )

    data = yaml.safe_load(roster_path.read_text()) or {}
    if not isinstance(data, dict):
        raise KolRosterError(f"{roster_path} must be a YAML mapping")

    defaults = data.get("defaults") or {}
    default_since = _coerce_since(defaults.get("since"))

    kols: list[Kol] = []
    seen: set[str] = set()
    for chain in CHAINS:
        entries = data.get(chain) or []
        if not isinstance(entries, list):
            raise KolRosterError(f"`{chain}` in {roster_path} must be a list")
        for entry in entries:
            if not isinstance(entry, dict):
                raise KolRosterError(
                    f"Each `{chain}` entry must be a mapping with an `address`"
                )
            address = _normalize_address(entry.get("address"), chain)
            kol = Kol(
                address=address,
                chain=chain,
                handle=(entry.get("handle") or None),
                tags=tuple(entry.get("tags") or ()),
                note=(entry.get("note") or None),
                since=_coerce_since(entry.get("since")) or default_since,
            )
            if kol.key in seen:
                raise KolRosterError(f"Duplicate address in roster: {kol.key}")
            seen.add(kol.key)
            kols.append(kol)

    if not kols:
        raise KolRosterError(
            f"{roster_path} has no KOLs yet. Add at least one address under "
            "`solana:` or `polymarket:`."
        )
    return kols
