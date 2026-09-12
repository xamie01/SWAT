"""Point-in-time tests for the Solana snapshot provider.

The leakage boundary here is the ``till`` variable on every Bitquery query.
These tests capture the variables of every outbound query and assert that none
ever asks for data after the decision instant.

The second thing under test is venue routing: a bonding-curve buy and an AMM
buy at the same instant must produce different universes, because the traders
were looking at different boards.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from pattern_ml.choice.providers.solana import (
    PUMP_CURVE_GRADUATION_REMAINING,
    PUMP_CURVE_INITIAL_TOKENS,
    SolanaSnapshotProvider,
    curve_completion,
)
from pattern_ml.sources.bitquery import BitqueryError
from pattern_ml.venues import BY_VENUE

AT = datetime(2026, 3, 1, 14, 0, tzinfo=timezone.utc)
PUMP = BY_VENUE["pump-bonding-curve"].address
RAYDIUM = BY_VENUE["raydium-amm-v4"].address
WSOL = "So11111111111111111111111111111111111111112"


class FakeBitquery:
    """Records every call, returns canned rows."""

    def __init__(self, *, trades=None, pools=None, fail: bool = False) -> None:
        self.calls: list[dict] = []
        self._trades = trades if trades is not None else [trade_row("MINT111")]
        self._pools = pools if pools is not None else [pool_row("MINT222")]
        self._fail = fail

    def _record(self, name: str, **kwargs) -> None:
        self.calls.append({"query": name, **kwargs})

    def top_by_volume(self, *, since, till, programs, limit):
        self._record("top_by_volume", since=since, till=till, programs=programs)
        if self._fail:
            raise BitqueryError("boom")
        return self._trades

    def token_window(self, *, since, till, mint):
        self._record("token_window", since=since, till=till, mint=mint)
        if self._fail:
            raise BitqueryError("boom")
        return self._trades[0] if self._trades else None

    def bonding_curves(self, *, since, till, program, min_remaining, max_remaining, limit):
        self._record(
            "bonding_curves",
            since=since,
            till=till,
            program=program,
            min_remaining=min_remaining,
            max_remaining=max_remaining,
        )
        if self._fail:
            raise BitqueryError("boom")
        return self._pools

    def pool_creations(self, *, since, till, program, limit):
        self._record("pool_creations", since=since, till=till, program=program)
        if self._fail:
            raise BitqueryError("boom")
        return self._pools

    def close(self) -> None:
        pass


def trade_row(
    mint: str,
    *,
    volume: float = 50_000.0,
    trades: int = 120,
    buyers: int = 40,
    price_first: float = 0.001,
    price_last: float = 0.002,
    first_seen: str | None = None,
) -> dict:
    return {
        "Trade": {
            "Currency": {"MintAddress": mint, "Symbol": "TKN", "Decimals": 6},
            "Dex": {"ProgramAddress": RAYDIUM, "ProtocolName": "raydium"},
        },
        "volume_usd": volume,
        "trades": trades,
        "buyers": buyers,
        "price_first": price_first,
        "price_last": price_last,
        "first_seen": first_seen or "2026-03-01T13:55:00Z",
    }


def pool_row(
    mint: str,
    *,
    remaining: float = 250_000_000.0,
    quote_usd: float = 60_000.0,
    time: str = "2026-03-01T13:58:00Z",
) -> dict:
    return {
        "Block": {"Time": time},
        "Pool": {
            "Market": {
                "MarketAddress": f"pool-{mint}",
                "BaseCurrency": {"MintAddress": mint, "Symbol": "CURVE"},
            },
            "Base": {"PostAmount": remaining},
            "Quote": {"PostAmount": 300.0, "PostAmountInUSD": quote_usd, "PriceInUSD": 0.0004},
            "Dex": {"ProgramAddress": PUMP, "ProtocolName": "pump"},
        },
    }


def make_provider(**kwargs) -> tuple[SolanaSnapshotProvider, FakeBitquery]:
    client = FakeBitquery(**{k: v for k, v in kwargs.items() if k in {"trades", "pools", "fail"}})
    provider = SolanaSnapshotProvider(
        _client=client,
        **{k: v for k, v in kwargs.items() if k not in {"trades", "pools", "fail"}},
    )
    return provider, client


class TestNoLookahead:
    def test_no_query_ever_asks_past_the_decision_instant(self) -> None:
        """The decisive test."""
        provider, client = make_provider(fetch_liquidity=True)
        provider.candidates_at(AT, venue="raydium-amm-v4")
        provider.candidates_at(AT, venue="pump-bonding-curve")
        provider.features_at("MINT111", AT)

        assert client.calls, "no queries were issued"
        for call in client.calls:
            assert call["till"] <= AT, f"queried the future: {call}"
            assert call["since"] < call["till"], f"empty window: {call}"

    def test_the_discovery_window_ends_exactly_at_the_decision(self) -> None:
        provider, client = make_provider()
        provider.candidates_at(AT, venue="raydium-amm-v4")
        discovery = next(c for c in client.calls if c["query"] == "top_by_volume")
        assert discovery["till"] == AT
        assert discovery["since"] == AT - timedelta(minutes=10)

    def test_curve_rows_observed_after_the_instant_are_discarded(self) -> None:
        """Defence in depth: drop leaked rows even if the API returns them."""
        provider, _ = make_provider(
            pools=[
                pool_row("EARLY", remaining=250_000_000.0, time="2026-03-01T13:58:00Z"),
                pool_row("LATE", remaining=210_000_000.0, time="2026-03-01T14:05:00Z"),
            ]
        )
        ids = {c["market_id"] for c in provider.candidates_at(AT, venue="pump-bonding-curve")}
        assert ids == {"EARLY"}


class TestVenueRouting:
    def test_a_bonding_curve_venue_queries_curves_not_volume(self) -> None:
        provider, client = make_provider()
        provider.candidates_at(AT, venue="pump-bonding-curve")
        assert {c["query"] for c in client.calls} == {"bonding_curves"}

    def test_an_amm_venue_queries_volume_not_curves(self) -> None:
        provider, client = make_provider()
        provider.candidates_at(AT, venue="raydium-amm-v4")
        assert "bonding_curves" not in {c["query"] for c in client.calls}

    def test_a_known_amm_is_queried_alone(self) -> None:
        """Negatives should come from the board the trader was actually on."""
        provider, client = make_provider()
        provider.candidates_at(AT, venue="raydium-amm-v4")
        call = next(c for c in client.calls if c["query"] == "top_by_volume")
        assert call["programs"] == [RAYDIUM]

    def test_an_aggregator_only_venue_widens_to_every_amm(self) -> None:
        """Routed into a pool we cannot name.

        A broad universe is a weaker approximation of the board than a precise
        one, but it is far better than dropping the decision entirely.
        """
        provider, client = make_provider()
        provider.candidates_at(AT, venue="jupiter-v6")
        call = next(c for c in client.calls if c["query"] == "top_by_volume")
        assert len(call["programs"]) > 1
        assert RAYDIUM in call["programs"]

    def test_an_unknown_venue_also_widens(self) -> None:
        provider, client = make_provider()
        provider.candidates_at(AT, venue="some-dex-we-never-mapped")
        call = next(c for c in client.calls if c["query"] == "top_by_volume")
        assert RAYDIUM in call["programs"]


class TestFeatures:
    def test_quote_assets_are_excluded_from_the_universe(self) -> None:
        """SOL and USDC appear in every swap aggregation.

        They are the unit of account, not opportunities, and would otherwise top
        every board by volume — teaching the model that the best trade is the
        one everyone is trading *against*.
        """
        provider, _ = make_provider(trades=[trade_row(WSOL), trade_row("REAL111")])
        ids = {c["market_id"] for c in provider.candidates_at(AT, venue="raydium-amm-v4")}
        assert ids == {"REAL111"}

    def test_age_is_null_when_the_window_censored_it(self) -> None:
        """A token trading before the window has an unknown age, not a young one.

        Clamping it to the window length would manufacture novelty out of an old
        token — the single most damaging error available here, since novelty is
        exactly what a launchpad trader selects on.
        """
        provider, _ = make_provider(
            trades=[trade_row("OLD", first_seen="2026-03-01T13:50:00Z")]
        )
        row = provider.candidates_at(AT, venue="raydium-amm-v4")[0]
        assert row["age_seconds"] is None

    def test_age_is_real_when_the_token_launched_inside_the_window(self) -> None:
        provider, _ = make_provider(
            trades=[trade_row("NEW", first_seen="2026-03-01T13:57:00Z")]
        )
        row = provider.candidates_at(AT, venue="raydium-amm-v4")[0]
        assert row["age_seconds"] == pytest.approx(180.0)

    def test_price_change_is_relative_for_tokens(self) -> None:
        """Unlike a Polymarket probability, a token price has no natural scale."""
        provider, _ = make_provider(
            trades=[trade_row("M", price_first=0.001, price_last=0.002)]
        )
        row = provider.candidates_at(AT, venue="raydium-amm-v4")[0]
        assert row["price_change_5m"] == pytest.approx(1.0)  # +100%

    def test_liquidity_is_not_fetched_unless_asked(self) -> None:
        """It costs an extra query per program per decision."""
        provider, client = make_provider(fetch_liquidity=False)
        provider.candidates_at(AT, venue="raydium-amm-v4")
        assert "pool_creations" not in {c["query"] for c in client.calls}

    def test_unfillable_fields_are_null_not_zero(self) -> None:
        provider, _ = make_provider()
        row = provider.candidates_at(AT, venue="raydium-amm-v4")[0]
        assert row["holder_count"] is None
        assert row["spread_pct"] is None
        assert row["liquidity_usd"] is None
        # Not a curve, so it has no curve progress.
        assert row["curve_completion"] is None

    def test_snapshot_provenance_is_stamped(self) -> None:
        provider, _ = make_provider()
        row = provider.candidates_at(AT, venue="raydium-amm-v4")[0]
        assert row["snapshot_source"] == "reconstructed"


class TestBondingCurves:
    def test_completion_runs_from_launch_to_graduation(self) -> None:
        assert curve_completion(PUMP_CURVE_INITIAL_TOKENS) == pytest.approx(0.0)
        assert curve_completion(PUMP_CURVE_GRADUATION_REMAINING) == pytest.approx(1.0)

    def test_a_lower_remaining_balance_means_a_more_complete_curve(self) -> None:
        """The direction is easy to get backwards; a curve drains as people buy."""
        assert curve_completion(300_000_000.0) > curve_completion(700_000_000.0)

    def test_completion_is_clamped_to_the_unit_interval(self) -> None:
        assert curve_completion(PUMP_CURVE_INITIAL_TOKENS + 1e9) == 0.0
        assert curve_completion(0.0) == 1.0
        assert curve_completion(None) is None

    def test_the_completion_floor_becomes_the_remaining_ceiling(self) -> None:
        """Inverted bounds would silently return zero curves."""
        provider, client = make_provider(min_curve_completion=0.70)
        provider.candidates_at(AT, venue="pump-bonding-curve")
        call = next(c for c in client.calls if c["query"] == "bonding_curves")
        assert call["min_remaining"] < call["max_remaining"]
        assert curve_completion(call["max_remaining"]) == pytest.approx(0.70)

    def test_only_the_last_state_before_the_instant_is_kept(self) -> None:
        """A curve emits a row per buy; the board showed the latest one."""
        provider, _ = make_provider(
            pools=[
                pool_row("SAME", remaining=400_000_000.0, time="2026-03-01T13:50:00Z"),
                pool_row("SAME", remaining=250_000_000.0, time="2026-03-01T13:59:00Z"),
            ]
        )
        rows = provider.candidates_at(AT, venue="pump-bonding-curve")
        assert len(rows) == 1
        assert rows[0]["curve_completion"] == pytest.approx(
            curve_completion(250_000_000.0)
        )

    def test_curves_are_ordered_by_completion(self) -> None:
        """Attention on a launchpad board goes to what is about to migrate."""
        provider, _ = make_provider(
            pools=[
                pool_row("BEHIND", remaining=500_000_000.0),
                pool_row("AHEAD", remaining=220_000_000.0),
            ]
        )
        rows = provider.candidates_at(AT, venue="pump-bonding-curve")
        assert [r["market_id"] for r in rows] == ["AHEAD", "BEHIND"]

    def test_curve_liquidity_comes_free_with_the_state_query(self) -> None:
        provider, _ = make_provider(pools=[pool_row("C", quote_usd=61_000.0)])
        row = provider.candidates_at(AT, venue="pump-bonding-curve")[0]
        assert row["liquidity_usd"] == pytest.approx(61_000.0)


class TestResilience:
    def test_a_failed_query_drops_one_decision_not_the_run(self) -> None:
        """A run may already have assembled thousands of usable groups."""
        provider, _ = make_provider(fail=True)
        assert provider.candidates_at(AT, venue="raydium-amm-v4") == []
        assert provider.features_at("MINT111", AT) is None

    def test_an_empty_board_yields_no_candidates(self) -> None:
        provider, _ = make_provider(trades=[])
        assert provider.candidates_at(AT, venue="raydium-amm-v4") == []

    def test_malformed_rows_are_skipped(self) -> None:
        provider, _ = make_provider(
            trades=[{"Trade": None}, {}, trade_row("GOOD")]
        )
        rows = provider.candidates_at(AT, venue="raydium-amm-v4")
        assert [r["market_id"] for r in rows] == ["GOOD"]

    def test_features_at_uses_the_wider_hour_window(self) -> None:
        """A token that failed the screen is thin; ten minutes often has nothing."""
        provider, client = make_provider()
        provider.features_at("MINT111", AT)
        call = next(c for c in client.calls if c["query"] == "token_window")
        assert call["since"] == AT - timedelta(hours=1)
        assert call["till"] == AT
