"""Market snapshots: what was on screen at a given instant.

This module is the hard part of the whole design, and the honest place to say
why.

The reconstruction problem
--------------------------
Scoring live candidates is easy — DexScreener and Pump.fun will tell you what
is trending *right now*. Training is the problem: neither will tell you what was
trending at 14:02 UTC on some past Tuesday. "Query the indexer at ``t_event``"
works in production and quietly does not work for building the training set.

Three ways out, and they trade off badly:

1. **Reconstruct from raw swaps** (Bitquery / Dune / Flipside). Aggregate every
   DEX swap into per-token, per-minute bars yourself, then apply the screen at
   any past minute. Faithful and vendor-independent; by far the most work.
2. **Per-candidate OHLCV** (Birdeye / GeckoTerminal). Cheaper, but you need the
   candidate universe *before* you can query it, and the liquidity/holder
   fields often have no historical endpoint at all.
3. **Forward collection.** Snapshot U_t on a schedule starting now. Zero
   leakage risk by construction, zero reconstruction work — and useless for
   months, because positives accrue only as fast as the KOLs trade.

The binding constraint is positives, not candidates. Twenty KOLs making ~50
buys a month is ~1,000 decisions a month, and learning-to-rank wants thousands
of groups. So reconstruction is not optional if you want results this quarter.

Forward collection should nonetheless run from day one. It is the only
ground truth that is provably leakage-free, which makes it the yardstick for
whether the reconstructed universe is trustworthy: train on reconstructed,
then check the ranking still holds on forward-collected groups.

Fields a provider cannot fill must be ``None``, never zero. A zero liquidity is
a claim; a null is an admission. ``SolanaScreen.passes`` rejects nulls, so an
unfillable field shrinks U_t rather than poisoning it.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Protocol, runtime_checkable

from ..config import get_settings

# Provenance values for `snapshot_source`. Mixing these in one training set
# silently mixes two different universes, so every row carries its origin.
SOURCE_LIVE = "live"
SOURCE_RECONSTRUCTED = "reconstructed"
SOURCE_SYNTHETIC = "synthetic"


@runtime_checkable
class MarketSnapshotProvider(Protocol):
    """Returns the candidate universe as it stood at a point in time.

    Implementations must honour one rule absolutely: **no field may incorporate
    data from at or after ``at``**. Not the 24h volume measured at end of day,
    not the liquidity as it is now. If a value cannot be obtained as-of ``at``,
    return ``None`` for it.

    A provider that leaks even ten seconds of the future produces a model that
    looks excellent in validation and fails in production, with nothing
    upstream to indicate why.
    """

    chain: str
    source: str

    def candidates_at(self, at: datetime, *, limit: int = 200) -> list[dict]:
        """Every plausibly-visible asset at ``at``, pre-screen.

        Returns dicts keyed by the feature names in
        ``choice.schema.CANDIDATE_SCHEMA`` (``market_id`` required).
        """
        ...

    def features_at(self, market_id: str, at: datetime) -> dict | None:
        """Point-in-time features for one asset.

        Needed when the chosen asset failed the screen and must be re-inserted
        into its own choice set — a group with no positive is untrainable.
        """
        ...


class SnapshotCache:
    """On-disk cache of snapshots, keyed by (chain, minute).

    Reconstruction is expensive and rate-limited, and several KOLs trading in
    the same minute must all see the *same* U_t — otherwise the model can learn
    which provider call produced a row. Caching to the minute enforces that and
    makes re-runs free.

    Minute granularity is a deliberate rounding: it is the resolution most
    OHLCV sources offer anyway, and sub-minute precision would multiply cost
    for detail the screen cannot resolve.
    """

    def __init__(self, root: Path | None = None) -> None:
        settings = get_settings()
        self._root = root or (settings.data_dir / "snapshots")
        self._root.mkdir(parents=True, exist_ok=True)

    def _path(self, chain: str, at: datetime) -> Path:
        minute = at.astimezone(timezone.utc).strftime("%Y%m%dT%H%M")
        # Shard by day so a directory never holds a million files.
        day = minute[:8]
        directory = self._root / chain / day
        directory.mkdir(parents=True, exist_ok=True)
        return directory / f"{minute}.json"

    def get(self, chain: str, at: datetime) -> list[dict] | None:
        path = self._path(chain, at)
        if not path.exists():
            return None
        try:
            payload = json.loads(path.read_text())
        except (OSError, ValueError):
            # A half-written cache entry should be refetched, not crash a run.
            return None
        return payload if isinstance(payload, list) else None

    def put(self, chain: str, at: datetime, candidates: list[dict]) -> None:
        path = self._path(chain, at)
        # Write-then-rename so a crash mid-write cannot leave a truncated file
        # that a later run would read as authoritative.
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(candidates, default=str))
        tmp.replace(path)

    def stats(self) -> dict[str, int]:
        counts: dict[str, int] = {}
        for chain_dir in self._root.iterdir() if self._root.exists() else []:
            if chain_dir.is_dir():
                counts[chain_dir.name] = sum(1 for _ in chain_dir.rglob("*.json"))
        return counts


class CachingProvider:
    """Wraps a provider so repeated calls for the same minute hit disk.

    Also the enforcement point for same-minute consistency: two KOLs trading at
    14:02:07 and 14:02:41 get an identical U_t, because they were looking at the
    same board.
    """

    def __init__(self, inner: MarketSnapshotProvider, cache: SnapshotCache | None = None):
        self._inner = inner
        self._cache = cache or SnapshotCache()
        self.chain = inner.chain
        self.source = inner.source

    def candidates_at(self, at: datetime, *, limit: int = 200) -> list[dict]:
        cached = self._cache.get(self.chain, at)
        if cached is not None:
            return cached[:limit]
        fetched = self._inner.candidates_at(at, limit=limit)
        self._cache.put(self.chain, at, fetched)
        return fetched

    def features_at(self, market_id: str, at: datetime) -> dict | None:
        return self._inner.features_at(market_id, at)


class ForwardCollector:
    """Snapshots U_t on a schedule, building leakage-proof ground truth.

    Runs as a cron job. Every snapshot is taken *before* anyone knows which
    asset a KOL will pick, so a choice set assembled from these files cannot
    contain lookahead bias by construction — the future had not happened yet.

    Slow to accumulate and worth starting immediately: it is the only dataset
    that can adjudicate whether a reconstructed universe was faithful.
    """

    def __init__(self, provider: MarketSnapshotProvider, cache: SnapshotCache | None = None):
        self._provider = provider
        self._cache = cache or SnapshotCache()

    def collect(self, *, limit: int = 200) -> tuple[datetime, int]:
        """Take one snapshot of the current universe. Returns (when, how many)."""
        now = datetime.now(timezone.utc)
        candidates = self._provider.candidates_at(now, limit=limit)
        for candidate in candidates:
            candidate["snapshot_source"] = SOURCE_LIVE
            candidate["snapshot_at"] = now.isoformat()
        self._cache.put(self._provider.chain, now, candidates)
        return now, len(candidates)
