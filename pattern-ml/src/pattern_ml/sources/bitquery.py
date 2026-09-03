"""Bitquery Solana GraphQL: historical protocol events at an arbitrary instant.

Why Bitquery and not an OHLCV vendor
------------------------------------
Reconstructing what was on a Solana trader's screen needs two things no price
API provides: the *set* of tokens active on a specific protocol in a specific
ten-minute window, and per-token aggregates over that window. Bitquery indexes
raw DEX trades and pool state with a time filter on every query, which answers
both in one request — candidates and their features together.

That is a real structural advantage over the Polymarket path, which costs two
requests per candidate. Here one aggregated query returns fifty candidates with
volume, trade count, unique buyers and first/last price already computed.

The honest caveat
-----------------
Every query string below is a best reconstruction of Bitquery's Solana schema
written without network access. Field names on their EAP endpoint have moved
between versions. **Run ``pattern-ml solana-probe`` before any real run**: it
executes each query with a one-row limit and reports which ones the schema
accepts, so a mismatch surfaces in one command rather than as a silently empty
choice set after forty thousand requests.

If long-past windows come back empty but recent ones work, the archive dataset
is not being reached — add ``(dataset: archive)`` after ``Solana`` in the
queries. It is left off by default because a wrong enum name fails the whole
query, while the default dataset at least returns something.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx

from ..config import get_settings

# Solana lives on the EAP endpoint, not the main /graphql one.
BITQUERY_EAP_URL = "https://streaming.bitquery.io/eap"


class BitqueryError(RuntimeError):
    """A Bitquery request failed, or the schema rejected the query."""


def _iso(ts: datetime) -> str:
    """Bitquery wants ISO-8601 UTC without a timezone suffix on DateTime args."""
    return ts.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------------------
# Queries
# ---------------------------------------------------------------------------
# Kept as module constants so a schema correction is a one-line edit in one
# place, and so `probe()` can iterate them without duplicating the strings.

Q_TOP_BY_VOLUME = """
query TopByVolume($since: DateTime!, $till: DateTime!, $programs: [String!]!, $limit: Int!) {
  Solana {
    DEXTradeByTokens(
      where: {
        Block: {Time: {since: $since, till: $till}}
        Trade: {Dex: {ProgramAddress: {in: $programs}}}
        Transaction: {Result: {Success: true}}
      }
      orderBy: {descendingByField: "volume_usd"}
      limit: {count: $limit}
    ) {
      Trade {
        Currency { MintAddress Symbol Name Decimals }
        Dex { ProgramAddress ProtocolName }
      }
      volume_usd: sum(of: Trade_Side_AmountInUSD)
      trades: count
      buyers: count(distinct: Transaction_Signer)
      price_last: maximum(of: Block_Time, get: Trade_PriceInUSD)
      price_first: minimum(of: Block_Time, get: Trade_PriceInUSD)
      first_seen: minimum(of: Block_Time)
    }
  }
}
"""

Q_TOKEN_WINDOW = """
query TokenWindow($since: DateTime!, $till: DateTime!, $mint: String!) {
  Solana {
    DEXTradeByTokens(
      where: {
        Block: {Time: {since: $since, till: $till}}
        Trade: {Currency: {MintAddress: {is: $mint}}}
        Transaction: {Result: {Success: true}}
      }
      limit: {count: 1}
    ) {
      Trade {
        Currency { MintAddress Symbol Name Decimals }
        Dex { ProgramAddress ProtocolName }
      }
      volume_usd: sum(of: Trade_Side_AmountInUSD)
      trades: count
      buyers: count(distinct: Transaction_Signer)
      price_last: maximum(of: Block_Time, get: Trade_PriceInUSD)
      price_first: minimum(of: Block_Time, get: Trade_PriceInUSD)
      first_seen: minimum(of: Block_Time)
    }
  }
}
"""

Q_BONDING_CURVES = """
query BondingCurves(
  $since: DateTime!
  $till: DateTime!
  $program: String!
  $minRemaining: String!
  $maxRemaining: String!
  $limit: Int!
) {
  Solana {
    DEXPools(
      where: {
        Block: {Time: {since: $since, till: $till}}
        Pool: {
          Dex: {ProgramAddress: {is: $program}}
          Base: {PostAmount: {gt: $minRemaining, lt: $maxRemaining}}
        }
        Transaction: {Result: {Success: true}}
      }
      orderBy: {descending: Block_Time}
      limit: {count: $limit}
    ) {
      Block { Time }
      Pool {
        Market { MarketAddress BaseCurrency { MintAddress Name Symbol Decimals } }
        Base { PostAmount }
        Quote { PostAmount PostAmountInUSD PriceInUSD }
        Dex { ProgramAddress ProtocolName }
      }
    }
  }
}
"""

Q_POOL_CREATIONS = """
query PoolCreations(
  $since: DateTime!
  $till: DateTime!
  $program: String!
  $limit: Int!
) {
  Solana {
    DEXPools(
      where: {
        Block: {Time: {since: $since, till: $till}}
        Pool: {Dex: {ProgramAddress: {is: $program}}}
        Transaction: {Result: {Success: true}}
      }
      orderBy: {ascending: Block_Time}
      limit: {count: $limit}
    ) {
      Block { Time }
      Pool {
        Market { MarketAddress BaseCurrency { MintAddress Name Symbol Decimals } }
        Base { PostAmount }
        Quote { PostAmount PostAmountInUSD PriceInUSD }
        Dex { ProgramAddress ProtocolName }
      }
    }
  }
}
"""

QUERIES: dict[str, str] = {
    "top_by_volume": Q_TOP_BY_VOLUME,
    "token_window": Q_TOKEN_WINDOW,
    "bonding_curves": Q_BONDING_CURVES,
    "pool_creations": Q_POOL_CREATIONS,
}

# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------


@dataclass
class BitqueryClient:
    """Synchronous GraphQL client.

    Synchronous on purpose: it is called from inside the snapshot provider,
    which is itself driven by a plain loop over decisions in ``assemble``.
    Making it async would push concurrency into a layer whose ordering
    guarantees — one universe per minute, cached — are what keep the choice
    sets consistent.
    """

    token: str | None = None
    url: str = BITQUERY_EAP_URL
    timeout: float = 60.0
    max_rps: float = 2.0
    max_retries: int = 3
    # Multiplier on every backoff sleep. Set to 0 in tests so retry paths run
    # instantly; nothing else should change it.
    backoff_scale: float = 1.0
    _client: httpx.Client | None = field(default=None, repr=False)
    _last_call: float = field(default=0.0, repr=False)

    def __post_init__(self) -> None:
        if self.token is None:
            self.token = get_settings().bitquery_token
        if self._client is None:
            self._client = httpx.Client(timeout=httpx.Timeout(self.timeout))

    # -- lifecycle ----------------------------------------------------------

    def close(self) -> None:
        if self._client is not None:
            self._client.close()
            self._client = None

    def __enter__(self) -> "BitqueryClient":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    @property
    def client(self) -> httpx.Client:
        if self._client is None:
            self._client = httpx.Client(timeout=httpx.Timeout(self.timeout))
        return self._client

    def _throttle(self) -> None:
        """Bitquery's free tier is points-per-minute, not requests-per-second.

        A fixed minimum gap is cruder than a token bucket but is the behaviour
        that matters here: a reconstruction run is a long sequence of large
        queries, and pacing them is what keeps a multi-hour job from being
        cut off partway with half a training set written.
        """
        if self.max_rps <= 0:
            return
        gap = 1.0 / self.max_rps
        elapsed = time.monotonic() - self._last_call
        if elapsed < gap:
            time.sleep(gap - elapsed)
        self._last_call = time.monotonic()

    def _backoff(self, seconds: float) -> None:
        if self.backoff_scale > 0:
            time.sleep(seconds * self.backoff_scale)

    # -- execution ----------------------------------------------------------

    def run(self, query: str, variables: dict[str, Any]) -> dict:
        """Execute one query. Raises ``BitqueryError`` on anything unusable.

        GraphQL returns HTTP 200 for schema errors, so the ``errors`` key is
        checked explicitly — without that, a renamed field would look like an
        empty result and quietly produce choice sets with no alternatives.
        """
        if not self.token:
            raise BitqueryError(
                "BITQUERY_TOKEN is not set. Add it to pattern-ml/.env — "
                "Solana reconstruction cannot run without it."
            )

        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.token}",
        }
        payload = {"query": query, "variables": variables}

        last_error: str | None = None
        for attempt in range(self.max_retries):
            self._throttle()
            try:
                response = self.client.post(self.url, json=payload, headers=headers)
            except httpx.HTTPError as exc:
                last_error = f"transport error: {exc}"
                self._backoff(2**attempt)
                continue

            if response.status_code == 429:
                # Rate limited. Honour the header when given one; the backoff
                # is otherwise exponential from a deliberately slow base,
                # because points refill per minute rather than per second.
                retry_after = response.headers.get("retry-after")
                delay = float(retry_after) if retry_after else 15.0 * (attempt + 1)
                self._backoff(delay)
                last_error = "rate limited"
                continue

            if response.status_code in (401, 403):
                raise BitqueryError(
                    f"Bitquery rejected the token ({response.status_code}). "
                    "Check BITQUERY_TOKEN is an OAuth access token, not the "
                    "legacy X-API-KEY."
                )

            if response.status_code >= 500:
                last_error = f"server error {response.status_code}"
                self._backoff(2**attempt)
                continue

            if response.status_code >= 400:
                # A 4xx is a bug in the query, not a transient failure.
                # Retrying would only hide it.
                raise BitqueryError(
                    f"Bitquery returned {response.status_code}: {response.text[:400]}"
                )

            try:
                body = response.json()
            except ValueError as exc:
                raise BitqueryError(f"Bitquery returned non-JSON: {exc}") from exc

            errors = body.get("errors")
            if errors:
                message = "; ".join(
                    str(e.get("message", e)) for e in errors if isinstance(e, dict)
                ) or str(errors)
                raise BitqueryError(f"GraphQL error: {message[:400]}")

            data = body.get("data")
            if not isinstance(data, dict):
                raise BitqueryError("Bitquery response had no `data` object")
            return data

        raise BitqueryError(
            f"Bitquery request failed after {self.max_retries} attempts: {last_error}"
        )

    # -- typed helpers ------------------------------------------------------

    def top_by_volume(
        self,
        *,
        since: datetime,
        till: datetime,
        programs: list[str],
        limit: int = 50,
    ) -> list[dict]:
        """Tokens ranked by traded volume on the given programs in a window.

        ``till`` is the leakage boundary. Every caller passes the decision
        instant, and nothing in this module ever widens it.
        """
        data = self.run(
            Q_TOP_BY_VOLUME,
            {
                "since": _iso(since),
                "till": _iso(till),
                "programs": programs,
                "limit": limit,
            },
        )
        return _rows(data, "DEXTradeByTokens")

    def token_window(
        self, *, since: datetime, till: datetime, mint: str
    ) -> dict | None:
        """Aggregates for one mint over a window — the re-insertion path.

        Used when a KOL's chosen token failed the screen and has to be put back
        into its own choice set so the group has a positive.
        """
        data = self.run(
            Q_TOKEN_WINDOW,
            {"since": _iso(since), "till": _iso(till), "mint": mint},
        )
        rows = _rows(data, "DEXTradeByTokens")
        return rows[0] if rows else None

    def bonding_curves(
        self,
        *,
        since: datetime,
        till: datetime,
        program: str,
        min_remaining: float,
        max_remaining: float,
        limit: int = 50,
    ) -> list[dict]:
        """Bonding curves whose remaining token balance sits in a band.

        The band is how "percent complete" is expressed on-chain: a curve starts
        full and drains as people buy, so a *lower* remaining balance means a
        *more* complete curve.
        """
        data = self.run(
            Q_BONDING_CURVES,
            {
                "since": _iso(since),
                "till": _iso(till),
                "program": program,
                # Bitquery compares these as strings; passing floats has been a
                # source of silent empty results.
                "minRemaining": f"{min_remaining:.0f}",
                "maxRemaining": f"{max_remaining:.0f}",
                "limit": limit,
            },
        )
        return _rows(data, "DEXPools")

    def pool_creations(
        self,
        *,
        since: datetime,
        till: datetime,
        program: str,
        limit: int = 50,
    ) -> list[dict]:
        """Pool state changes on one program in a window, oldest first."""
        data = self.run(
            Q_POOL_CREATIONS,
            {
                "since": _iso(since),
                "till": _iso(till),
                "program": program,
                "limit": limit,
            },
        )
        return _rows(data, "DEXPools")

    # -- schema validation --------------------------------------------------

    def probe(self, *, at: datetime | None = None) -> list[dict]:
        """Run every query once with a one-row limit and report what worked.

        This is the answer to the fact that these query strings could not be
        validated offline. Run it first on the server: a failure here names the
        field the schema rejected, which is a two-minute fix, whereas the same
        mismatch discovered mid-run looks like "the KOLs had no alternatives".
        """
        from ..venues import BY_VENUE

        till = (at or datetime.now(timezone.utc)).replace(microsecond=0)
        since = till - timedelta(hours=1)
        pump = BY_VENUE["pump-bonding-curve"].address
        raydium = BY_VENUE["raydium-amm-v4"].address

        results: list[dict] = []

        def check(name: str, call) -> list[dict]:
            try:
                rows = call()
            except BitqueryError as exc:
                results.append(
                    {"query": name, "ok": False, "rows": 0, "detail": str(exc)}
                )
                return []
            results.append(
                {
                    "query": name,
                    "ok": True,
                    "rows": len(rows),
                    "detail": "" if rows else "accepted but returned no rows",
                }
            )
            return rows

        trades = check(
            "top_by_volume",
            lambda: self.top_by_volume(
                since=since, till=till, programs=[raydium], limit=1
            ),
        )
        check(
            "bonding_curves",
            lambda: self.bonding_curves(
                since=since,
                till=till,
                program=pump,
                min_remaining=206_900_000,
                max_remaining=793_100_000,
                limit=1,
            ),
        )
        check(
            "pool_creations",
            lambda: self.pool_creations(
                since=since, till=till, program=raydium, limit=1
            ),
        )

        # token_window needs a real mint, so it reuses whatever the volume query
        # surfaced rather than a hardcoded address that may since have died.
        mint = _mint_of(trades[0]) if trades else None
        if mint:
            check(
                "token_window",
                lambda: [
                    row
                    for row in [self.token_window(since=since, till=till, mint=mint)]
                    if row
                ],
            )
        else:
            results.append(
                {
                    "query": "token_window",
                    "ok": False,
                    "rows": 0,
                    "detail": "skipped — top_by_volume surfaced no mint to test with",
                }
            )
        return results


# ---------------------------------------------------------------------------
# Response shaping
# ---------------------------------------------------------------------------


def _rows(data: dict, key: str) -> list[dict]:
    """Pull one result list out of a ``{"Solana": {...}}`` envelope."""
    solana = data.get("Solana")
    if not isinstance(solana, dict):
        return []
    rows = solana.get(key)
    return [row for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []


def _mint_of(row: dict) -> str | None:
    """Mint address from either a DEXTradeByTokens or a DEXPools row."""
    trade = row.get("Trade")
    if isinstance(trade, dict):
        currency = trade.get("Currency")
        if isinstance(currency, dict) and currency.get("MintAddress"):
            return str(currency["MintAddress"])
    pool = row.get("Pool")
    if isinstance(pool, dict):
        market = pool.get("Market")
        if isinstance(market, dict):
            base = market.get("BaseCurrency")
            if isinstance(base, dict) and base.get("MintAddress"):
                return str(base["MintAddress"])
    return None
