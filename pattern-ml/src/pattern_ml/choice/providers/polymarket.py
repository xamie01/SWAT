"""Point-in-time market snapshots for Polymarket.

Why this venue is tractable and Solana is not
---------------------------------------------
Two properties make historical reconstruction genuinely possible here:

1. The live universe is hundreds of markets, not a hundred thousand tokens, so
   the opportunity set is close to enumerable rather than approximated.
2. The CLOB price-history endpoint accepts absolute ``startTs``/``endTs`` with
   minute ``fidelity``, so a candidate's state at any past minute can be read
   directly. Solana has no free equivalent.

The one hazard, and how it is handled
-------------------------------------
Gamma's ``/markets`` returns **current** state: today's volume, today's
liquidity, whether it has since resolved. Using those fields as-of a past
timestamp would be textbook lookahead bias — the model would learn which
markets ended up busy, which is unknowable at decision time.

So Gamma is used only for facts that cannot change after creation:

* ``condition_id``, ``question``, ``slug``
* category / tags
* ``created_at``, ``end_date``

Everything dynamic — price, volume, spread, momentum — is derived from price
history windows that **end at the decision instant**. A market that had not
been created by ``at``, or that had already resolved, is excluded outright: it
could not have been on screen.

Cost note
---------
One price-history call per candidate per decision. With ~50 candidates and a
few thousand decisions that is six figures of requests, which is why
``SnapshotCache`` keys by minute and why ``max_candidates`` on the screen is
enforced *before* features are fetched, not after.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx

from ..snapshot import SOURCE_RECONSTRUCTED

GAMMA_API = "https://gamma-api.polymarket.com"
CLOB_API = "https://clob.polymarket.com"
DATA_API = "https://data-api.polymarket.com"

# Gamma pages at 100; the active universe is small enough to walk fully.
MARKETS_PAGE_LIMIT = 100

# Minute resolution. Finer would multiply cost for detail the screen cannot
# resolve, and matches what the endpoint reliably serves over long windows.
PRICE_FIDELITY_MINUTES = 1

# Lookback windows for momentum features, all ending at the decision instant.
WINDOW_5M = timedelta(minutes=5)
WINDOW_1H = timedelta(hours=1)
WINDOW_24H = timedelta(hours=24)


def _epoch(ts: datetime) -> int:
    return int(ts.astimezone(timezone.utc).timestamp())


def _parse_iso(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _f(value: Any) -> float | None:
    """Coerce API numerics, which arrive as both strings and numbers."""
    if value is None or value == "":
        return None
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if out == out else None  # drop NaN


def _first_token_id(market: dict) -> str | None:
    """The YES token id, which is what price history is keyed by.

    ``clobTokenIds`` arrives as either a JSON-encoded string or a real list
    depending on endpoint and era, so both are handled.
    """
    raw = market.get("clobTokenIds")
    if isinstance(raw, str):
        import json

        try:
            raw = json.loads(raw)
        except ValueError:
            return None
    if isinstance(raw, list) and raw:
        return str(raw[0])
    return None


@dataclass
class PolymarketMarket:
    """Immutable facts about a market — safe to read from current Gamma state."""

    condition_id: str
    token_id: str | None
    question: str | None
    slug: str | None
    category: str | None
    created_at: datetime | None
    end_date: datetime | None

    def existed_at(self, at: datetime) -> bool:
        """Was this market tradeable at ``at``?

        Excludes markets created later (could not be on screen) and markets
        already resolved (no longer on screen). Both would be phantom
        alternatives the trader never actually faced.
        """
        if self.created_at and self.created_at > at:
            return False
        if self.end_date and self.end_date <= at:
            return False
        return True


@dataclass
class PolymarketSnapshotProvider:
    """Reconstructs the Polymarket opportunity set at a past instant."""

    chain: str = "polymarket"
    source: str = SOURCE_RECONSTRUCTED
    timeout: float = 30.0
    max_rps: float = 15.0
    # Filled lazily on first use and reused across decisions — the market
    # catalogue is stable, and re-walking it per decision would dominate cost.
    _catalogue: dict[str, PolymarketMarket] = field(default_factory=dict, repr=False)
    _client: httpx.Client | None = field(default=None, repr=False)

    def __post_init__(self) -> None:
        if self._client is None:
            self._client = httpx.Client(
                timeout=httpx.Timeout(self.timeout), follow_redirects=True
            )

    # -- lifecycle ----------------------------------------------------------

    def close(self) -> None:
        if self._client is not None:
            self._client.close()
            self._client = None

    def __enter__(self) -> "PolymarketSnapshotProvider":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    @property
    def client(self) -> httpx.Client:
        if self._client is None:
            self._client = httpx.Client(
                timeout=httpx.Timeout(self.timeout), follow_redirects=True
            )
        return self._client

    # -- catalogue ----------------------------------------------------------

    def load_catalogue(self, *, max_markets: int = 5_000) -> dict[str, PolymarketMarket]:
        """Walk Gamma once for the immutable facts about every market.

        Deliberately reads *closed* markets too: a market that has resolved
        since was still a live alternative back at the decision instant, and
        omitting those would shrink historical choice sets to only the markets
        that happen to still be open today — a subtle survivorship bias in the
        universe itself.
        """
        if self._catalogue:
            return self._catalogue

        catalogue: dict[str, PolymarketMarket] = {}
        offset = 0
        while offset < max_markets:
            params = {
                "limit": MARKETS_PAGE_LIMIT,
                "offset": offset,
                # No `active`/`closed` filter, for the reason above.
                "order": "startDate",
                "ascending": "false",
            }
            try:
                response = self.client.get(f"{GAMMA_API}/markets", params=params)
                response.raise_for_status()
                page = response.json()
            except (httpx.HTTPError, ValueError):
                break

            rows = page if isinstance(page, list) else page.get("data") or []
            if not rows:
                break

            for row in rows:
                if not isinstance(row, dict):
                    continue
                condition_id = row.get("conditionId")
                if not condition_id:
                    continue
                catalogue[condition_id] = PolymarketMarket(
                    condition_id=condition_id,
                    token_id=_first_token_id(row),
                    question=row.get("question"),
                    slug=row.get("slug"),
                    category=row.get("category"),
                    created_at=_parse_iso(row.get("startDate"))
                    or _parse_iso(row.get("createdAt")),
                    end_date=_parse_iso(row.get("endDate")),
                )

            if len(rows) < MARKETS_PAGE_LIMIT:
                break
            offset += MARKETS_PAGE_LIMIT

        self._catalogue = catalogue
        return catalogue

    # -- price history ------------------------------------------------------

    def _price_history(
        self, token_id: str, start: datetime, end: datetime
    ) -> list[dict[str, float]]:
        """Price points in ``[start, end]``.

        ``endTs`` is the leakage boundary for this entire module. It must never
        exceed the decision instant, and every caller passes ``at`` directly.
        """
        params = {
            "market": token_id,
            "startTs": _epoch(start),
            "endTs": _epoch(end),
            "fidelity": PRICE_FIDELITY_MINUTES,
        }
        try:
            response = self.client.get(f"{CLOB_API}/prices-history", params=params)
            response.raise_for_status()
            payload = response.json()
        except (httpx.HTTPError, ValueError):
            return []

        history = payload.get("history") if isinstance(payload, dict) else payload
        if not isinstance(history, list):
            return []

        points: list[dict[str, float]] = []
        for entry in history:
            if not isinstance(entry, dict):
                continue
            ts = _f(entry.get("t"))
            price = _f(entry.get("p"))
            if ts is None or price is None:
                continue
            # Defence in depth: drop anything at or after the boundary even if
            # the API returns it. A single leaked point is a leaked feature.
            if ts >= _epoch(end):
                continue
            points.append({"t": ts, "p": price})
        return sorted(points, key=lambda p: p["t"])

    # -- feature derivation -------------------------------------------------

    def _features_from_history(
        self, points: list[dict[str, float]], at: datetime
    ) -> dict[str, float | None]:
        """Momentum and activity features from a price series ending at ``at``.

        Polymarket's public history gives price, not size, so true traded
        volume is not derivable here. ``trades_5m`` counts *price observations*,
        which is a proxy for activity — a market printing many distinct prices
        is being traded. It is explicitly not a dollar volume, and the volume
        fields stay ``None`` rather than being filled with a fabrication.
        """
        if not points:
            return {
                "price": None,
                "price_change_5m": None,
                "price_change_1h": None,
                "trades_5m": None,
                "volume_5m_usd": None,
                "volume_1h_usd": None,
                "volume_24h_usd": None,
            }

        latest = points[-1]["p"]
        cutoff_5m = _epoch(at - WINDOW_5M)
        cutoff_1h = _epoch(at - WINDOW_1H)

        def price_at_or_before(cutoff: int) -> float | None:
            earlier = [p["p"] for p in points if p["t"] <= cutoff]
            return earlier[-1] if earlier else None

        price_5m_ago = price_at_or_before(cutoff_5m)
        price_1h_ago = price_at_or_before(cutoff_1h)

        return {
            "price": latest,
            # Absolute probability change, not percentage: a move from 0.02 to
            # 0.04 is +100% but only two points of probability, and the point
            # difference is what a trader reads.
            "price_change_5m": (latest - price_5m_ago) if price_5m_ago is not None else None,
            "price_change_1h": (latest - price_1h_ago) if price_1h_ago is not None else None,
            "trades_5m": float(sum(1 for p in points if p["t"] > cutoff_5m)),
            "volume_5m_usd": None,
            "volume_1h_usd": None,
            "volume_24h_usd": None,
        }

    # -- traded volume ------------------------------------------------------

    def _volume_windows(
        self, condition_id: str, at: datetime
    ) -> dict[str, float | None]:
        """Real traded volume in the 5m / 1h / 24h windows ending at ``at``.

        Derived from the public Data API's ``/trades``, filtered to the market
        and bounded by ``end=at``. This is the honest source: Gamma's ``volume``
        field is *current* cumulative volume, and using it as-of a past instant
        would tell the model which markets ended up busy — unknowable at
        decision time and a guaranteed leak.

        One request covers all three windows: fetch 24h of fills once and
        bucket locally, rather than three calls per candidate.

        ``limit`` is 10000 — the documented maximum for ``/trades``, which is
        20x the ``/activity`` cap. At that size a single request covers the full
        24h of fills for all but the very busiest markets, so the volume figure
        is accurate rather than the floor a 500-row page would have produced.
        """
        params = {
            "market": condition_id,
            "limit": 10_000,
            "takerOnly": "false",  # spec default is true; maker fills are volume too
            # Spec: "rows newer than `end` are excluded". This is the leakage
            # boundary. Market-scoped requests keep a ~3-year floor, so `start`
            # can only narrow the window here — never widen it past `end`.
            "start": _epoch(at - WINDOW_24H),
            "end": _epoch(at),
        }
        try:
            response = self.client.get(f"{DATA_API}/trades", params=params)
            response.raise_for_status()
            payload = response.json()
        except (httpx.HTTPError, ValueError):
            return {"volume_5m_usd": None, "volume_1h_usd": None, "volume_24h_usd": None}

        rows = payload if isinstance(payload, list) else payload.get("items") or []
        if not isinstance(rows, list):
            return {"volume_5m_usd": None, "volume_1h_usd": None, "volume_24h_usd": None}

        boundary = _epoch(at)
        cutoff_5m = _epoch(at - WINDOW_5M)
        cutoff_1h = _epoch(at - WINDOW_1H)
        totals = {"volume_5m_usd": 0.0, "volume_1h_usd": 0.0, "volume_24h_usd": 0.0}
        buyers: set[str] = set()
        buys = sells = 0

        for row in rows:
            if not isinstance(row, dict):
                continue
            ts = _f(row.get("timestamp"))
            size = _f(row.get("size"))
            price = _f(row.get("price"))
            if ts is None or size is None or price is None:
                continue
            # The API is asked for end=at, but never trust a boundary you did
            # not enforce yourself.
            if ts >= boundary:
                continue

            notional = size * price
            totals["volume_24h_usd"] += notional
            if ts > cutoff_1h:
                totals["volume_1h_usd"] += notional
            if ts > cutoff_5m:
                totals["volume_5m_usd"] += notional
                wallet = row.get("proxyWallet")
                side = (row.get("side") or "").upper()
                if side == "BUY":
                    buys += 1
                    if wallet:
                        buyers.add(str(wallet))
                elif side == "SELL":
                    sells += 1

        # At limit=10000 a truncated 24h window is possible only for the very
        # busiest markets. Recorded as-is: it preserves the ordering the screen
        # uses, and paging every candidate would multiply cost several fold for
        # a number used only to rank attention.
        result: dict[str, float | None] = dict(totals)
        result["unique_buyers_5m"] = float(len(buyers)) if buyers else 0.0
        result["buy_sell_ratio_5m"] = (buys / sells) if sells else (float(buys) if buys else None)
        return result

    # -- provider protocol --------------------------------------------------

    def candidates_at(
        self, at: datetime, *, limit: int = 200, venue: str | None = None
    ) -> list[dict]:
        """The opportunity set at ``at``.

        ``venue`` is accepted for protocol compatibility and ignored: Polymarket
        has one order book, so there is no second board a trader could have been
        looking at instead.

        Note the cost shape: this fetches price history per candidate, so
        ``limit`` should stay close to the screen's ``max_candidates`` rather
        than being set generously.
        """
        catalogue = self.load_catalogue()
        live = [m for m in catalogue.values() if m.existed_at(at) and m.token_id]

        candidates: list[dict] = []
        for market in live[:limit]:
            row = self._candidate_row(market, at)
            if row is not None:
                candidates.append(row)
        return candidates

    def features_at(
        self, market_id: str, at: datetime, *, venue: str | None = None
    ) -> dict | None:
        """Point-in-time features for one market, by condition id."""
        catalogue = self.load_catalogue()
        market = catalogue.get(market_id)
        if market is None or not market.token_id:
            return None
        return self._candidate_row(market, at)

    def _candidate_row(self, market: PolymarketMarket, at: datetime) -> dict | None:
        assert market.token_id is not None
        points = self._price_history(market.token_id, at - WINDOW_24H, at)
        if not points:
            # No observable price means it was not visibly trading. Returning a
            # row of nulls would add a candidate the screen then rejects anyway.
            return None

        features = self._features_from_history(points, at)
        volumes = self._volume_windows(market.condition_id, at)
        age = (at - market.created_at).total_seconds() if market.created_at else None

        # Spread needs an order-book snapshot, which has no historical endpoint.
        # Left null: PolymarketScreen rejects nulls, so a spread-gated screen is
        # only usable live. Use `max_spread_pct=None`-equivalent screens for
        # historical assembly, or supply a provider that fills it.
        return {
            "market_id": market.condition_id,
            "market_label": market.question,
            "outcome": "Yes",  # history is keyed on the YES token
            "category": market.category,
            "age_seconds": age,
            "liquidity_usd": None,
            "spread_pct": None,
            "holder_count": None,
            "top10_holder_pct": None,
            "snapshot_source": self.source,
            "snapshot_at": at.isoformat(),
            **features,
            # Volume windows overwrite the null placeholders in `features`.
            **volumes,
        }
