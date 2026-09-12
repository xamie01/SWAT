"""Solana sourcing via the Helius Enhanced Transactions API.

Why the Enhanced API and not raw RPC
------------------------------------
The main SWAT indexer walks ``getSignaturesForAddress`` then fetches each
signature with ``getTransaction`` — two round trips per transaction, with all
swap decoding done locally. At the 1-2M trade scale targeted here that is
hundreds of thousands of extra requests. The Enhanced Transactions endpoint
returns up to 100 *already-parsed* transactions per call with a populated
``events.swap``, roughly a 100x reduction in request count for the same
coverage.

Pricing
-------
A swap tells us token amounts, not USD. Rather than fetching a price for every
token at every timestamp (neither cheap nor reliably available for dead
memecoins), we anchor on the quote leg: nearly every KOL swap has SOL or a
stablecoin on one side. Stablecoin legs are USD directly; SOL legs are
converted with a historical daily SOL/USD series (``pattern_ml.prices``).
Swaps with neither leg keep a null ``size_usd`` — treated as missing, never as
zero, so they can't quietly distort sizing statistics.
"""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from typing import Any

import polars as pl

from ..config import Kol, get_settings
from .base import HttpSource, PullStats, SourceError

HELIUS_API = "https://api.helius.xyz/v0"

# The Enhanced Transactions endpoint caps `limit` at 100.
TX_PAGE_LIMIT = 100

# A safety rail: without it a misconfigured pull on a bot wallet could walk
# millions of transactions. Overridable per-pull.
DEFAULT_MAX_PAGES = 10_000


def _require_api_key() -> str:
    key = get_settings().helius_api_key
    if not key:
        raise SourceError(
            "HELIUS_API_KEY is not set. Add it to the local .env "
            "(or the repo-root .env, which is read as a fallback)."
        )
    return key


async def fetch_swaps(
    source: HttpSource,
    address: str,
    *,
    since: datetime | None = None,
    max_pages: int = DEFAULT_MAX_PAGES,
    stats: PullStats | None = None,
) -> list[dict[str, Any]]:
    """Read a wallet's swap history, newest first, walking back via ``before``.

    Returns raw enriched-transaction objects exactly as Helius returned them.
    """
    api_key = _require_api_key()
    url = f"{HELIUS_API}/addresses/{address}/transactions"

    rows: list[dict[str, Any]] = []
    before: str | None = None
    since_epoch = int(since.timestamp()) if since else None
    pages = 0

    while pages < max_pages:
        params: dict[str, Any] = {
            "api-key": api_key,
            "limit": TX_PAGE_LIMIT,
            "type": "SWAP",
        }
        if before:
            params["before"] = before

        payload = await source.get_json(url, params)
        if stats:
            stats.requests += 1

        if not isinstance(payload, list):
            raise SourceError(
                f"Helius returned a non-list transaction page for {address}"
            )
        if not payload:
            break

        pages += 1
        if stats:
            stats.pages += 1

        reached_start = False
        for tx in payload:
            if not isinstance(tx, dict):
                continue
            ts = tx.get("timestamp")
            if since_epoch is not None and isinstance(ts, (int, float)):
                if ts < since_epoch:
                    # Newest-first ordering means everything after this is older.
                    reached_start = True
                    break
            rows.append(tx)

        if stats:
            stats.rows = len(rows)

        if reached_start:
            break

        # Short page = end of history.
        if len(payload) < TX_PAGE_LIMIT:
            break

        last = payload[-1]
        last_sig = last.get("signature") if isinstance(last, dict) else None
        if not last_sig or last_sig == before:
            # Cursor failed to advance; stop rather than loop forever.
            if stats:
                stats.errors.append(f"{address}: pagination cursor stalled")
                stats.stopped_early = True
            break
        before = last_sig

    if pages >= max_pages and stats:
        stats.stopped_early = True
        stats.errors.append(
            f"{address}: hit the {max_pages}-page ceiling; history may be truncated"
        )

    return rows


async def pull_kol(kol: Kol, source: HttpSource) -> tuple[pl.DataFrame, PullStats]:
    """Pull one Solana KOL's swap history into a raw DataFrame."""
    stats = PullStats(kol_key=kol.key)
    try:
        rows = await fetch_swaps(source, kol.address, since=kol.since, stats=stats)
    except SourceError as exc:
        stats.errors.append(f"{kol.key}: {exc}")
        return pl.DataFrame(), stats

    if not rows:
        return pl.DataFrame(), stats

    fetched_at = datetime.now(timezone.utc).isoformat()
    # Helius rows carry deeply nested structures (events, tokenTransfers,
    # accountData, instructions) whose shapes vary enough between transactions
    # that Polars struct inference fights us. Keep the nested parts as JSON
    # strings in the raw file and decode them during normalization.
    #
    # `instructions` is kept specifically so the execution venue can be resolved
    # from program ids. Helius's own `source` label collapses every Jupiter
    # route to "JUPITER" and cannot distinguish a Pump.fun bonding curve from
    # PumpSwap — a distinction the candidate query depends on entirely.
    flattened = [
        {
            "signature": tx.get("signature"),
            "timestamp": tx.get("timestamp"),
            "slot": tx.get("slot"),
            "fee": tx.get("fee"),
            "source": tx.get("source"),
            "type": tx.get("type"),
            "description": tx.get("description"),
            "feePayer": tx.get("feePayer"),
            "events_json": json.dumps(tx.get("events") or {}),
            "token_transfers_json": json.dumps(tx.get("tokenTransfers") or []),
            "native_transfers_json": json.dumps(tx.get("nativeTransfers") or []),
            "instructions_json": json.dumps(tx.get("instructions") or []),
            "_kol_address": kol.address,
            "_kol_handle": kol.handle,
            "_fetched_at": fetched_at,
        }
        for tx in rows
    ]

    return pl.DataFrame(flattened, infer_schema_length=None, strict=False), stats


async def pull_all(
    kols: list[Kol], *, concurrency: int | None = None
) -> dict[str, tuple[pl.DataFrame, PullStats]]:
    """Pull every Solana KOL, bounded by the configured concurrency."""
    settings = get_settings()
    targets = [k for k in kols if k.chain == "solana"]
    if not targets:
        return {}

    semaphore = asyncio.Semaphore(concurrency or settings.source_concurrency)
    results: dict[str, tuple[pl.DataFrame, PullStats]] = {}

    async with HttpSource(max_rps=settings.solana_max_rps) as source:

        async def worker(kol: Kol) -> None:
            async with semaphore:
                results[kol.key] = await pull_kol(kol, source)

        await asyncio.gather(*(worker(k) for k in targets))

    return results
