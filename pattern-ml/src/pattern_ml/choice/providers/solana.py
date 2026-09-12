"""Point-in-time market snapshots for Solana, reconstructed via Bitquery.

The reconstruction, in one paragraph
------------------------------------
A KOL's swap is first resolved to the program that held the market (see
``pattern_ml.venues``). That program decides which question to ask about the
ten minutes before the trade:

* **Bonding curve** (Pump.fun, Moonshot, LaunchLab) — which curves were live and
  how far along were they? A trader watching a launchpad board is choosing among
  curves by completion, not by dollar volume.
* **AMM / CLMM** (Raydium, Meteora, Orca, PumpSwap) — which tokens had real
  volume on that protocol in the window? A trader on a trending board is
  choosing among names that were moving.
* **Aggregator only** (a Jupiter route into a pool the registry does not know) —
  fall back to the union of all AMM programs. Losing venue precision is better
  than dropping the decision.

Cost, versus the Polymarket path
--------------------------------
Polymarket costs two HTTP requests *per candidate per decision*. Here the
aggregation happens server-side: two queries per **decision** return fifty
candidates with volume, trade count, unique buyers and price already computed.
That is the difference between a run that is merely expensive and one that is
not worth starting.

What is *not* filled, and why that is deliberate
------------------------------------------------
``age_seconds`` is real only when a token's first trade falls *inside* the
query window. Outside it the value is censored — "older than ten minutes" —
and censored is recorded as ``None``, never as the window length. A censored
age silently clamped to the window would be a feature that means one thing in
training and another at serve time.

``liquidity_usd`` needs pool-state rows, which cost an extra query per program
per decision. Off by default (``fetch_liquidity=True`` enables it). Bonding
curves get it for free, because curve state *is* the pool state.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

from ...schema import SOLANA_QUOTE_MINTS
from ...sources.bitquery import BitqueryClient, BitqueryError
from ...venues import (
    BY_VENUE,
    KIND_AMM,
    KIND_BONDING_CURVE,
    KIND_CLMM,
    PROGRAMS,
    venue_kind,
)
from ..snapshot import SOURCE_RECONSTRUCTED

# The spec's window: what was active on this protocol in the ten minutes before
# the trade. Long enough that a quiet minute does not empty the board, short
# enough that it still describes the screen at that moment.
DISCOVERY_WINDOW = timedelta(minutes=10)

# Feature windows. Both end at the decision instant.
WINDOW_5M = timedelta(minutes=5)
WINDOW_1H = timedelta(hours=1)

# Pump.fun curve arithmetic. A curve starts full and drains as people buy, so a
# *lower* remaining balance means a *more* complete curve. These two constants
# are the documented Bitquery values for launch and graduation; everything else
# (completion percentage, filter bands) is derived from them so a correction
# only has to be made once.
PUMP_CURVE_INITIAL_TOKENS = 793_100_000.0
PUMP_CURVE_GRADUATION_REMAINING = 206_900_000.0

# Every program that holds a market itself, as opposed to routing to one.
AMM_PROGRAM_ADDRESSES: tuple[str, ...] = tuple(
    p.address for p in PROGRAMS if p.kind in (KIND_AMM, KIND_CLMM)
)


def _f(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if out == out else None  # drop NaN


def _parse_time(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def curve_completion(remaining: float | None) -> float | None:
    """How far a bonding curve has progressed, as a fraction in [0, 1].

    0.0 is a fresh launch, 1.0 is graduation to an AMM. This is the bonding-curve
    analogue of "how hot is this" — a board watcher reads completion, not volume,
    because a curve at 90% is minutes from migrating.
    """
    if remaining is None:
        return None
    span = PUMP_CURVE_INITIAL_TOKENS - PUMP_CURVE_GRADUATION_REMAINING
    if span <= 0:
        return None
    progressed = (PUMP_CURVE_INITIAL_TOKENS - remaining) / span
    return max(0.0, min(1.0, progressed))


def remaining_for_completion(completion: float) -> float:
    """Inverse of :func:`curve_completion` — the balance at a given progress."""
    span = PUMP_CURVE_INITIAL_TOKENS - PUMP_CURVE_GRADUATION_REMAINING
    return PUMP_CURVE_INITIAL_TOKENS - (completion * span)


def _age_seconds(
    first_seen: datetime | None, window_start: datetime, at: datetime
) -> float | None:
    """Token age, or ``None`` when the window censored it.

    If the earliest trade Bitquery reports sits at (or before) the window edge,
    the token was already trading before we started looking and its true age is
    unknown. Returning the window length instead would invent a young token out
    of an old one — the single most damaging thing this module could do, since
    novelty is exactly what a launchpad trader selects on.
    """
    if first_seen is None:
        return None
    if first_seen <= window_start:
        return None
    return max(0.0, (at - first_seen).total_seconds())


@dataclass
class SolanaSnapshotProvider:
    """Reconstructs the Solana opportunity set at a past instant.

    ``venue`` is passed per call rather than fixed on the provider: one KOL's
    history spans launchpads and AMMs, and each decision must be scored against
    the board the trader was actually on.
    """

    chain: str = "solana"
    source: str = SOURCE_RECONSTRUCTED
    discovery_window: timedelta = DISCOVERY_WINDOW
    # Minimum curve progress to count as "on the board". A curve at 3% is not
    # competing for attention with one about to migrate.
    min_curve_completion: float = 0.70
    # Pool-state rows for liquidity cost one extra query per program per
    # decision. Off by default; see the module docstring.
    fetch_liquidity: bool = False
    candidate_limit: int = 50
    _client: BitqueryClient | None = field(default=None, repr=False)

    def __post_init__(self) -> None:
        if self._client is None:
            from ...config import get_settings

            self._client = BitqueryClient(max_rps=get_settings().bitquery_max_rps)

    # -- lifecycle ----------------------------------------------------------

    def close(self) -> None:
        if self._client is not None:
            self._client.close()
            self._client = None

    def __enter__(self) -> "SolanaSnapshotProvider":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    @property
    def client(self) -> BitqueryClient:
        if self._client is None:
            from ...config import get_settings

            self._client = BitqueryClient(max_rps=get_settings().bitquery_max_rps)
        return self._client

    # -- provider protocol --------------------------------------------------

    def candidates_at(
        self, at: datetime, *, limit: int = 200, venue: str | None = None
    ) -> list[dict]:
        """The opportunity set at ``at``, routed by venue.

        Never queries past ``at``: every window below is ``[at - w, at]``.
        """
        kind = venue_kind(venue) if venue else None
        cap = min(limit, self.candidate_limit)

        try:
            if kind == KIND_BONDING_CURVE:
                rows = self._bonding_curve_candidates(at, venue, cap)
            else:
                rows = self._amm_candidates(at, venue, cap)
        except BitqueryError:
            # One failed snapshot drops one decision. Raising would abandon a
            # run that may already have assembled thousands of usable groups.
            return []
        return rows[:cap]

    def features_at(
        self, market_id: str, at: datetime, *, venue: str | None = None
    ) -> dict | None:
        """Point-in-time features for one mint — the re-insertion path.

        Called when a KOL's chosen token failed the screen, so the group still
        gets its positive. Uses the 1h window rather than the discovery window:
        a token that failed the screen is by definition thin, and the shorter
        window would often return nothing at all.
        """
        try:
            row = self.client.token_window(
                since=at - WINDOW_1H, till=at, mint=market_id
            )
        except BitqueryError:
            return None
        if not row:
            return None
        return self._trade_row_to_candidate(row, at, window_start=at - WINDOW_1H)

    # -- AMM path -----------------------------------------------------------

    def _programs_for(self, venue: str | None) -> list[str]:
        """Which program addresses to query for a venue.

        An unknown or aggregator-only venue widens to every AMM: the trade was
        routed somewhere we could not name, and a broad universe is a better
        approximation of the board than no universe at all.
        """
        if venue:
            program = BY_VENUE.get(venue)
            if program is not None and not program.is_aggregator:
                return [program.address]
        return list(AMM_PROGRAM_ADDRESSES)

    def _amm_candidates(
        self, at: datetime, venue: str | None, limit: int
    ) -> list[dict]:
        programs = self._programs_for(venue)
        window_start = at - self.discovery_window

        # Query 1 — the board itself, ranked by volume over the discovery window.
        discovery = self.client.top_by_volume(
            since=window_start, till=at, programs=programs, limit=limit
        )
        if not discovery:
            return []

        # Query 2 — the same programs over an hour, for slower-moving context.
        # Deliberately a wider limit so tokens ranked highly over 10 minutes are
        # still present in the hourly ranking; anything that misses stays null.
        try:
            hourly = self.client.top_by_volume(
                since=at - WINDOW_1H, till=at, programs=programs, limit=limit * 4
            )
        except BitqueryError:
            hourly = []
        hourly_volume = {
            mint: _f(row.get("volume_usd"))
            for row in hourly
            if (mint := _mint_of_trade(row))
        }

        liquidity = self._liquidity_by_mint(at, programs) if self.fetch_liquidity else {}

        candidates: list[dict] = []
        for row in discovery:
            candidate = self._trade_row_to_candidate(row, at, window_start=window_start)
            if candidate is None:
                continue
            mint = candidate["market_id"]
            candidate["volume_1h_usd"] = hourly_volume.get(mint)
            if liquidity:
                candidate["liquidity_usd"] = liquidity.get(mint)
            candidates.append(candidate)
        return candidates

    def _trade_row_to_candidate(
        self, row: dict, at: datetime, *, window_start: datetime
    ) -> dict | None:
        """One ``DEXTradeByTokens`` row → one candidate."""
        trade = row.get("Trade")
        if not isinstance(trade, dict):
            return None
        currency = trade.get("Currency")
        if not isinstance(currency, dict):
            return None
        mint = currency.get("MintAddress")
        if not mint:
            return None
        # Both sides of every swap appear in this aggregation, so SOL and the
        # stablecoins come back as "tokens". They are the unit of account, not
        # opportunities, and would otherwise top every board by volume.
        if mint in SOLANA_QUOTE_MINTS:
            return None

        dex = trade.get("Dex") if isinstance(trade.get("Dex"), dict) else {}
        price_last = _f(row.get("price_last"))
        price_first = _f(row.get("price_first"))
        first_seen = _parse_time(row.get("first_seen"))

        return {
            "market_id": str(mint),
            "market_label": currency.get("Symbol") or currency.get("Name"),
            "outcome": None,
            "venue": dex.get("ProtocolName"),
            "category": None,
            "age_seconds": _age_seconds(first_seen, window_start, at),
            "price": price_last,
            # Percentage move: unlike a Polymarket probability, a token price
            # has no natural scale, so only the relative change is comparable
            # across candidates.
            "price_change_5m": (
                (price_last - price_first) / price_first
                if price_last is not None and price_first
                else None
            ),
            "price_change_1h": None,
            "volume_5m_usd": _f(row.get("volume_usd")),
            "volume_1h_usd": None,
            "volume_24h_usd": None,
            "trades_5m": _f(row.get("trades")),
            "unique_buyers_5m": _f(row.get("buyers")),
            "buy_sell_ratio_5m": None,
            "liquidity_usd": None,
            "curve_completion": None,
            "holder_count": None,
            "top10_holder_pct": None,
            "spread_pct": None,
            "snapshot_source": self.source,
            "snapshot_at": at.isoformat(),
        }

    def _liquidity_by_mint(
        self, at: datetime, programs: list[str]
    ) -> dict[str, float]:
        """Pool-side liquidity, one query per program. Opt-in; see the docstring."""
        out: dict[str, float] = {}
        for program in programs:
            try:
                pools = self.client.pool_creations(
                    since=at - self.discovery_window,
                    till=at,
                    program=program,
                    limit=self.candidate_limit * 2,
                )
            except BitqueryError:
                continue
            for row in pools:
                pool = row.get("Pool")
                if not isinstance(pool, dict):
                    continue
                mint = _mint_of_pool(pool)
                quote = pool.get("Quote") if isinstance(pool.get("Quote"), dict) else {}
                value = _f(quote.get("PostAmountInUSD"))
                if mint and value is not None:
                    # Latest state in the window wins.
                    out[mint] = value
        return out

    # -- bonding-curve path -------------------------------------------------

    def _bonding_curve_candidates(
        self, at: datetime, venue: str | None, limit: int
    ) -> list[dict]:
        program = BY_VENUE.get(venue or "pump-bonding-curve")
        if program is None:
            return []

        window_start = at - self.discovery_window
        rows = self.client.bonding_curves(
            since=window_start,
            till=at,
            program=program.address,
            # A *more* complete curve has a *lower* remaining balance, so the
            # completion floor becomes the upper bound on remaining tokens.
            min_remaining=PUMP_CURVE_GRADUATION_REMAINING,
            max_remaining=remaining_for_completion(self.min_curve_completion),
            limit=limit * 2,  # deduped below, so over-fetch a little
        )

        # A curve emits a row per state change; keep only the last one before
        # `at`, which is what the board would have shown.
        latest: dict[str, tuple[datetime, dict]] = {}
        for row in rows:
            observed = _parse_time((row.get("Block") or {}).get("Time"))
            if observed is None or observed > at:
                continue
            pool = row.get("Pool")
            if not isinstance(pool, dict):
                continue
            mint = _mint_of_pool(pool)
            if not mint:
                continue
            existing = latest.get(mint)
            if existing is None or observed > existing[0]:
                latest[mint] = (observed, pool)

        candidates: list[dict] = []
        for mint, (observed, pool) in latest.items():
            base = pool.get("Base") if isinstance(pool.get("Base"), dict) else {}
            quote = pool.get("Quote") if isinstance(pool.get("Quote"), dict) else {}
            market = pool.get("Market") if isinstance(pool.get("Market"), dict) else {}
            currency = (
                market.get("BaseCurrency")
                if isinstance(market.get("BaseCurrency"), dict)
                else {}
            )
            completion = curve_completion(_f(base.get("PostAmount")))

            candidates.append(
                {
                    "market_id": mint,
                    "market_label": currency.get("Symbol") or currency.get("Name"),
                    "outcome": None,
                    "venue": program.venue,
                    "category": None,
                    # Curve state is a snapshot, not a window, so there is no
                    # first-trade timestamp to age it from.
                    "age_seconds": None,
                    "price": _f(quote.get("PriceInUSD")),
                    "price_change_5m": None,
                    "price_change_1h": None,
                    "volume_5m_usd": None,
                    "volume_1h_usd": None,
                    "volume_24h_usd": None,
                    "trades_5m": None,
                    "unique_buyers_5m": None,
                    "buy_sell_ratio_5m": None,
                    # SOL sitting in the curve: the closest thing to liquidity
                    # a pre-migration token has, and free with this query.
                    "liquidity_usd": _f(quote.get("PostAmountInUSD")),
                    "curve_completion": completion,
                    "holder_count": None,
                    "top10_holder_pct": None,
                    "spread_pct": None,
                    "snapshot_source": self.source,
                    "snapshot_at": at.isoformat(),
                }
            )

        candidates.sort(key=lambda c: c.get("curve_completion") or 0.0, reverse=True)
        return candidates


# ---------------------------------------------------------------------------
# Row helpers
# ---------------------------------------------------------------------------


def _mint_of_trade(row: dict) -> str | None:
    trade = row.get("Trade")
    if not isinstance(trade, dict):
        return None
    currency = trade.get("Currency")
    if not isinstance(currency, dict):
        return None
    mint = currency.get("MintAddress")
    return str(mint) if mint else None


def _mint_of_pool(pool: dict) -> str | None:
    market = pool.get("Market")
    if not isinstance(market, dict):
        return None
    base = market.get("BaseCurrency")
    if not isinstance(base, dict):
        return None
    mint = base.get("MintAddress")
    return str(mint) if mint else None
