"""Polymarket sourcing via the public Data API.

Why ``/activity`` and not ``/trades``
------------------------------------
``/trades`` returns only fills. On Polymarket a *winning* position is usually
closed by redeeming shares at resolution, not by selling them — that emits a
``REDEEM`` activity row and no trade. Sourcing trades alone would leave every
winning position looking permanently open and would systematically bias the
PnL labels toward losers. ``/activity`` carries TRADE, REDEEM, MERGE, SPLIT
and CONVERSION in one stream, so the position ledger actually balances.

Two further defaults on the Data API that bite if left alone:

* ``takerOnly`` defaults to **true** on ``/trades`` — maker fills vanish. The
  activity feed has no such filter, which is another reason to prefer it.
* ``excludeDepositsWithdrawals`` defaults to **true**, which is what we want:
  bankroll movements are not trades.

Paging
------
Offsets are capped server-side (the cap has been tightened over time — the
changelog cut it to 1000, the reference documents higher). Rather than betting
on one number we page in ``start``-anchored windows: walk ascending until the
offset budget is spent, then re-anchor ``start`` on the newest row seen and
reset the offset. Rows repeated at a window boundary cost nothing because the
trade id is a content hash and the warehouse dedupes on it.

Ascending order is deliberate: with ``sortDirection=ASC`` and a positive
``start`` the feed reads from the beginning of the account's history rather
than the default ~3-year window, which is what full-history mining needs.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Any

import polars as pl

from ..config import Kol, get_settings
from .base import HttpSource, PullStats, SourceError

# The Data API clamps `limit`; 500 is the documented maximum.
ACTIVITY_PAGE_LIMIT = 500

# Conservative offset budget. The documented cap has moved between 1000 and
# 5000; staying at 1000 costs only a few extra window re-anchors and can never
# trip the 400 that a too-deep offset returns.
ACTIVITY_MAX_OFFSET = 1_000

# Everything that moves share quantity or cash for a position. Deposits and
# withdrawals are excluded separately (they are bankroll, not position, flow).
ACTIVITY_TYPES = ("TRADE", "REDEEM", "MERGE", "SPLIT", "CONVERSION")

# Gamma serves market metadata and, crucially, final outcome prices — needed to
# value a residual position in a market that resolved against the KOL.
GAMMA_API = "https://gamma-api.polymarket.com"


def _extract_rows(payload: Any) -> list[dict[str, Any]]:
    """The Data API has returned both a bare array and an envelope over time."""
    if isinstance(payload, list):
        return [row for row in payload if isinstance(row, dict)]
    if isinstance(payload, dict):
        for key in ("items", "data", "activity"):
            value = payload.get(key)
            if isinstance(value, list):
                return [row for row in value if isinstance(row, dict)]
    raise SourceError(
        f"Unexpected Polymarket activity payload shape: {type(payload).__name__}"
    )


def _row_timestamp(row: dict[str, Any]) -> int | None:
    value = row.get("timestamp")
    if isinstance(value, str):
        value = int(value) if value.isdigit() else None
    if isinstance(value, (int, float)) and value > 0:
        return int(value)
    return None


async def fetch_activity(
    source: HttpSource,
    address: str,
    *,
    since: datetime | None = None,
    page_limit: int = ACTIVITY_PAGE_LIMIT,
    max_offset: int = ACTIVITY_MAX_OFFSET,
    stats: PullStats | None = None,
) -> list[dict[str, Any]]:
    """Read a KOL's full Polymarket activity history.

    Returns raw API rows, unmodified — normalization happens later so the raw
    dump on disk stays a faithful record of what the API said.
    """
    settings = get_settings()
    url = f"{settings.polymarket_data_api}/activity"

    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    offset = 0
    # `start=1` (any positive epoch) opts out of the default ~3-year window and
    # reads true full history. 0 or omitted would silently truncate old KOLs.
    window_start = int(since.timestamp()) if since else 1
    windows = 1

    while True:
        params: dict[str, Any] = {
            "user": address,
            "limit": page_limit,
            "offset": offset,
            "sortDirection": "ASC",
            "sortBy": "TIMESTAMP",
            "start": window_start,
            "type": ",".join(ACTIVITY_TYPES),
            "excludeDepositsWithdrawals": "true",
        }

        payload = await source.get_json(url, params)
        if stats:
            stats.requests += 1
        page = _extract_rows(payload)
        if not page:
            break
        if stats:
            stats.pages += 1

        newest_in_page: int | None = None
        fresh = 0
        for row in page:
            # Identity for boundary dedupe: tx hash + asset + type + timestamp.
            # A single tx can contain several fills on different assets.
            ident = "|".join(
                str(row.get(key, ""))
                for key in (
                    "transactionHash",
                    "asset",
                    "type",
                    "timestamp",
                    "side",
                    "size",
                )
            )
            if ident in seen:
                continue
            seen.add(ident)
            rows.append(row)
            fresh += 1
            ts = _row_timestamp(row)
            if ts is not None and (newest_in_page is None or ts > newest_in_page):
                newest_in_page = ts

        if stats:
            stats.rows += fresh

        # A short page means this window is exhausted.
        if len(page) < page_limit:
            break

        offset += page_limit
        if offset + page_limit <= max_offset:
            continue

        # Offset budget spent — re-anchor the window on the newest row seen.
        if newest_in_page is None:
            # No usable timestamps; we cannot advance the window safely, and
            # continuing would loop forever re-reading the same rows.
            if stats:
                stats.errors.append(
                    f"{address}: window could not advance (no timestamps); "
                    "history may be truncated"
                )
                stats.stopped_early = True
            break
        if newest_in_page <= window_start and offset > max_offset:
            # Window did not advance at all — more than `max_offset` rows share
            # one timestamp. Nudge forward to guarantee progress; we lose only
            # rows in that same second, which the dedupe key would drop anyway.
            window_start = newest_in_page + 1
        else:
            window_start = newest_in_page
        offset = 0
        windows += 1

    if stats:
        stats.windows = windows
    return rows


async def fetch_market_metadata(
    source: HttpSource, condition_ids: list[str]
) -> list[dict[str, Any]]:
    """Fetch market metadata + final outcome prices for the given markets.

    This is what makes a losing Polymarket position measurable. A loser is
    never redeemed and never sold — it just expires worthless. Without the
    resolved outcome price we would carry it as an open position forever and
    never label it a loss.
    """
    if not condition_ids:
        return []

    out: list[dict[str, Any]] = []
    batch_size = 20
    for i in range(0, len(condition_ids), batch_size):
        batch = condition_ids[i : i + batch_size]
        params: dict[str, Any] = {"condition_ids": batch, "limit": batch_size}
        try:
            payload = await source.get_json(f"{GAMMA_API}/markets", params)
        except SourceError:
            # Metadata is enrichment, not the trade record itself. A market we
            # can't resolve stays unlabelled rather than sinking the whole pull.
            continue
        if isinstance(payload, list):
            out.extend(row for row in payload if isinstance(row, dict))
        elif isinstance(payload, dict) and isinstance(payload.get("data"), list):
            out.extend(row for row in payload["data"] if isinstance(row, dict))
    return out


async def pull_kol(kol: Kol, source: HttpSource) -> tuple[pl.DataFrame, PullStats]:
    """Pull one Polymarket KOL's full history into a raw DataFrame."""
    stats = PullStats(kol_key=kol.key)
    try:
        rows = await fetch_activity(source, kol.address, since=kol.since, stats=stats)
    except SourceError as exc:
        stats.errors.append(f"{kol.key}: {exc}")
        return pl.DataFrame(), stats

    if not rows:
        return pl.DataFrame(), stats

    # Stamp provenance before the raw file is written.
    fetched_at = datetime.now(timezone.utc).isoformat()
    for row in rows:
        row["_kol_address"] = kol.address
        row["_kol_handle"] = kol.handle
        row["_fetched_at"] = fetched_at

    # infer_schema_length=None: activity rows have wildly varied optional
    # fields, and a short inference window mis-types columns that are null in
    # the first few hundred rows.
    return pl.DataFrame(rows, infer_schema_length=None, strict=False), stats


async def pull_all(
    kols: list[Kol], *, concurrency: int | None = None
) -> dict[str, tuple[pl.DataFrame, PullStats]]:
    """Pull every Polymarket KOL, bounded by the configured concurrency."""
    settings = get_settings()
    targets = [k for k in kols if k.chain == "polymarket"]
    if not targets:
        return {}

    semaphore = asyncio.Semaphore(concurrency or settings.source_concurrency)
    results: dict[str, tuple[pl.DataFrame, PullStats]] = {}

    async with HttpSource(max_rps=settings.polymarket_max_rps) as source:

        async def worker(kol: Kol) -> None:
            async with semaphore:
                results[kol.key] = await pull_kol(kol, source)

        await asyncio.gather(*(worker(k) for k in targets))

    return results
