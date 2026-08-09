"""Historical SOL/USD daily closes, for valuing SOL-quoted swaps.

Most Solana KOL swaps are quoted in SOL rather than a stablecoin. Without a
rate, ``size_usd`` is null for those trades, which in turn nulls every sizing
feature and guts the Solana half of the analysis. One daily series fixes it.

Daily granularity is a deliberate choice. Intraday SOL moves are real but small
next to the thing being measured: whether a position was 0.5x or 10x the
trader's typical size. Fetching per-minute rates for millions of trades would
cost enormously more and change almost no feature value.

The series is cached to Parquet after the first fetch, so re-indexing is
offline and free.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import polars as pl

from .config import get_settings

COINGECKO_URL = "https://api.coingecko.com/api/v3/coins/solana/market_chart"

# CoinGecko's free tier caps historical range; "max" is attempted first and
# falls back to a year, which is reliably available without a key.
_RANGE_ATTEMPTS = ("max", "365")

CACHE_FILENAME = "sol_usd_daily.parquet"


def _cache_path() -> Path:
    return get_settings().data_dir / CACHE_FILENAME


def _load_cache() -> pl.DataFrame | None:
    path = _cache_path()
    if not path.exists():
        return None
    try:
        return pl.read_parquet(path)
    except Exception:
        # A truncated cache (killed mid-write) should be refetched, not fatal.
        return None


def _fetch(days: str, timeout: float = 30.0) -> pl.DataFrame | None:
    params = {"vs_currency": "usd", "days": days, "interval": "daily"}
    try:
        response = httpx.get(COINGECKO_URL, params=params, timeout=timeout)
        response.raise_for_status()
        payload = response.json()
    except (httpx.HTTPError, ValueError):
        return None

    prices = payload.get("prices") if isinstance(payload, dict) else None
    if not isinstance(prices, list) or not prices:
        return None

    rows: list[dict[str, object]] = []
    for entry in prices:
        if not isinstance(entry, (list, tuple)) or len(entry) < 2:
            continue
        millis, price = entry[0], entry[1]
        if not isinstance(millis, (int, float)) or not isinstance(price, (int, float)):
            continue
        day = datetime.fromtimestamp(millis / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
        rows.append({"day": day, "usd": float(price)})

    if not rows:
        return None
    # A day can appear twice at range boundaries; keep the last observation.
    return pl.DataFrame(rows).unique(subset=["day"], keep="last").sort("day")


def load_sol_usd(*, refresh: bool = False) -> dict[str, float]:
    """Return a ``{"YYYY-MM-DD": usd}`` map of SOL closes.

    Returns an empty map if the series cannot be fetched. That is a degraded
    mode, not a failure: SOL-quoted trades keep a null ``size_usd`` and the
    models treat them as missing. Callers should surface the emptiness rather
    than silently proceeding, because feature coverage is much worse without it.
    """
    if not refresh:
        cached = _load_cache()
        if cached is not None and not cached.is_empty():
            return dict(zip(cached["day"].to_list(), cached["usd"].to_list()))

    frame = None
    for days in _RANGE_ATTEMPTS:
        frame = _fetch(days)
        if frame is not None and not frame.is_empty():
            break

    if frame is None or frame.is_empty():
        return {}

    path = _cache_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    frame.write_parquet(path)
    return dict(zip(frame["day"].to_list(), frame["usd"].to_list()))


def coverage(sol_usd: dict[str, float], first: datetime, last: datetime) -> float:
    """Fraction of days in ``[first, last]`` that have a rate.

    Surfaced by the CLI so a partial series is visible rather than quietly
    halving the usable Solana feature set.
    """
    if not sol_usd or last < first:
        return 0.0
    total = (last.date() - first.date()).days + 1
    if total <= 0:
        return 0.0
    present = sum(
        1
        for offset in range(total)
        if (first + timedelta(days=offset)).strftime("%Y-%m-%d") in sol_usd
    )
    return present / total
