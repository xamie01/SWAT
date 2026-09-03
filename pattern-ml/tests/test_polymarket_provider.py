"""Point-in-time tests for the Polymarket snapshot provider.

The leakage boundary here is a URL parameter — ``endTs`` on price history,
``end`` on trades — which makes it directly assertable. These tests intercept
every outbound request and check that none of them ever asks for data at or
after the decision instant.

``httpx.MockTransport`` rather than respx: respx pins httpx below the version
the rest of the stack resolves to.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlparse

import httpx
import pytest

from pattern_ml.choice.providers.polymarket import (
    PolymarketMarket,
    PolymarketSnapshotProvider,
)

AT = datetime(2026, 3, 1, 14, 0, tzinfo=timezone.utc)
AT_EPOCH = int(AT.timestamp())


class RequestLog:
    """Records every request so tests can assert on the leakage boundary."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []

    def params(self, path_fragment: str) -> list[dict]:
        out = []
        for request in self.requests:
            if path_fragment in str(request.url.path):
                out.append(
                    {k: v[0] for k, v in parse_qs(urlparse(str(request.url)).query).items()}
                )
        return out


def make_provider(
    *,
    markets: list[dict] | None = None,
    history: list[dict] | None = None,
    trades: list[dict] | None = None,
) -> tuple[PolymarketSnapshotProvider, RequestLog]:
    log = RequestLog()

    default_history = history if history is not None else [
        {"t": AT_EPOCH - 3600, "p": 0.40},
        {"t": AT_EPOCH - 600, "p": 0.45},
        {"t": AT_EPOCH - 60, "p": 0.50},
    ]
    default_trades = trades if trades is not None else [
        {
            "timestamp": AT_EPOCH - 120,
            "size": 1000.0,
            "price": 0.5,
            "side": "BUY",
            "proxyWallet": "0xaaa",
        }
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        log.requests.append(request)
        path = request.url.path
        if "/markets" in path:
            offset = int(request.url.params.get("offset", 0))
            return httpx.Response(200, json=(markets or []) if offset == 0 else [])
        if "prices-history" in path:
            return httpx.Response(200, json={"history": default_history})
        if "/trades" in path:
            return httpx.Response(200, json=default_trades)
        return httpx.Response(404, json={})

    provider = PolymarketSnapshotProvider()
    provider._client = httpx.Client(transport=httpx.MockTransport(handler))
    return provider, log


def market_row(
    condition_id: str = "0xmarket",
    *,
    start: str = "2026-01-01T00:00:00Z",
    end: str = "2026-12-31T00:00:00Z",
    category: str = "Politics",
) -> dict:
    return {
        "conditionId": condition_id,
        "clobTokenIds": json.dumps([f"token-{condition_id}", f"token-{condition_id}-no"]),
        "question": "Will X happen?",
        "slug": "will-x-happen",
        "category": category,
        "startDate": start,
        "endDate": end,
    }


class TestNoLookahead:
    def test_price_history_never_requests_past_the_decision(self) -> None:
        """The decisive test: endTs must never exceed the decision instant."""
        provider, log = make_provider(markets=[market_row()])
        provider.candidates_at(AT)

        calls = log.params("prices-history")
        assert calls, "price history was never requested"
        for call in calls:
            assert int(call["endTs"]) <= AT_EPOCH, f"requested future data: {call}"

    def test_trade_volume_never_requests_past_the_decision(self) -> None:
        provider, log = make_provider(markets=[market_row()])
        provider.candidates_at(AT)

        calls = log.params("/trades")
        assert calls, "trades were never requested"
        for call in calls:
            assert int(call["end"]) <= AT_EPOCH, f"requested future data: {call}"

    def test_price_points_at_or_after_the_boundary_are_discarded(self) -> None:
        """Defence in depth: drop leaked points even if the API returns them."""
        provider, _ = make_provider(
            markets=[market_row()],
            history=[
                {"t": AT_EPOCH - 600, "p": 0.40},
                {"t": AT_EPOCH, "p": 0.99},        # exactly at the boundary
                {"t": AT_EPOCH + 3600, "p": 0.99},  # after it
            ],
        )
        row = provider.candidates_at(AT)[0]
        # 0.40 is the last legitimate observation; 0.99 must not surface.
        assert row["price"] == pytest.approx(0.40)

    def test_trades_at_or_after_the_boundary_are_not_counted(self) -> None:
        provider, _ = make_provider(
            markets=[market_row()],
            trades=[
                {"timestamp": AT_EPOCH - 60, "size": 100.0, "price": 0.5, "side": "BUY"},
                {"timestamp": AT_EPOCH + 60, "size": 1e9, "price": 0.5, "side": "BUY"},
            ],
        )
        row = provider.candidates_at(AT)[0]
        assert row["volume_24h_usd"] == pytest.approx(50.0)

    def test_gamma_dynamic_fields_are_never_read(self) -> None:
        """Gamma serves *current* volume; using it as-of a past instant leaks.

        A market whose current volume is enormous must not inherit that number
        when snapshotted at a past time — only traded volume up to `at` counts.
        """
        row = market_row()
        row["volume"] = 99_999_999.0
        row["liquidity"] = 88_888_888.0
        provider, _ = make_provider(markets=[row])

        candidate = provider.candidates_at(AT)[0]
        assert candidate["volume_24h_usd"] == pytest.approx(500.0)  # from trades
        assert candidate["liquidity_usd"] is None


class TestUniverseMembership:
    def test_markets_created_after_the_instant_are_excluded(self) -> None:
        """A market that did not exist yet could not have been on screen."""
        provider, _ = make_provider(
            markets=[market_row("0xfuture", start="2026-06-01T00:00:00Z")]
        )
        assert provider.candidates_at(AT) == []

    def test_markets_already_resolved_are_excluded(self) -> None:
        provider, _ = make_provider(
            markets=[market_row("0xold", end="2026-02-01T00:00:00Z")]
        )
        assert provider.candidates_at(AT) == []

    def test_a_market_live_at_the_instant_is_included(self) -> None:
        provider, _ = make_provider(markets=[market_row("0xlive")])
        candidates = provider.candidates_at(AT)
        assert len(candidates) == 1
        assert candidates[0]["market_id"] == "0xlive"

    def test_markets_with_no_price_history_are_dropped(self) -> None:
        """No observable price means it was not visibly trading."""
        provider, _ = make_provider(markets=[market_row()], history=[])
        assert provider.candidates_at(AT) == []

    def test_closed_markets_are_still_catalogued(self) -> None:
        """Since-resolved markets were live alternatives back then.

        Omitting them would shrink historical choice sets to only the markets
        still open today — survivorship bias in the universe itself.
        """
        provider, _ = make_provider(
            markets=[market_row("0xresolved", end="2026-04-01T00:00:00Z")]
        )
        catalogue = provider.load_catalogue()
        assert "0xresolved" in catalogue
        # Live at AT (March 1), resolved later (April 1).
        assert catalogue["0xresolved"].existed_at(AT)


class TestFeatures:
    def test_price_change_is_an_absolute_probability_move(self) -> None:
        """0.02 → 0.04 is +100% but only two points. Points are what traders read."""
        provider, _ = make_provider(
            markets=[market_row()],
            history=[
                {"t": AT_EPOCH - 7200, "p": 0.20},
                {"t": AT_EPOCH - 3600, "p": 0.30},
                {"t": AT_EPOCH - 60, "p": 0.50},
            ],
        )
        row = provider.candidates_at(AT)[0]
        assert row["price_change_1h"] == pytest.approx(0.20)  # 0.50 - 0.30

    def test_volume_is_bucketed_by_window(self) -> None:
        provider, _ = make_provider(
            markets=[market_row()],
            trades=[
                {"timestamp": AT_EPOCH - 60, "size": 100.0, "price": 0.5, "side": "BUY"},
                {"timestamp": AT_EPOCH - 1800, "size": 100.0, "price": 0.5, "side": "BUY"},
                {"timestamp": AT_EPOCH - 40000, "size": 100.0, "price": 0.5, "side": "BUY"},
            ],
        )
        row = provider.candidates_at(AT)[0]
        assert row["volume_5m_usd"] == pytest.approx(50.0)    # 1 trade
        assert row["volume_1h_usd"] == pytest.approx(100.0)   # 2 trades
        assert row["volume_24h_usd"] == pytest.approx(150.0)  # all 3

    def test_unavailable_fields_are_null_not_zero(self) -> None:
        """A zero liquidity is a claim; a null is an admission.

        The screen rejects nulls, so an unfillable field shrinks U_t rather
        than poisoning it with fabricated values.
        """
        provider, _ = make_provider(markets=[market_row()])
        row = provider.candidates_at(AT)[0]
        assert row["liquidity_usd"] is None
        assert row["spread_pct"] is None
        assert row["holder_count"] is None

    def test_age_is_measured_from_creation_to_the_instant(self) -> None:
        provider, _ = make_provider(
            markets=[market_row(start="2026-02-28T14:00:00Z")]
        )
        row = provider.candidates_at(AT)[0]
        assert row["age_seconds"] == pytest.approx(timedelta(days=1).total_seconds())

    def test_snapshot_provenance_is_stamped(self) -> None:
        provider, _ = make_provider(markets=[market_row()])
        row = provider.candidates_at(AT)[0]
        assert row["snapshot_source"] == "reconstructed"

    def test_features_at_returns_one_market_by_condition_id(self) -> None:
        provider, _ = make_provider(markets=[market_row("0xtarget")])
        row = provider.features_at("0xtarget", AT)
        assert row is not None
        assert row["market_id"] == "0xtarget"

    def test_features_at_returns_none_for_an_unknown_market(self) -> None:
        provider, _ = make_provider(markets=[market_row("0xknown")])
        assert provider.features_at("0xnope", AT) is None


class TestResilience:
    def test_a_failing_price_request_drops_the_candidate(self) -> None:
        """One bad market must not sink the whole snapshot."""

        def handler(request: httpx.Request) -> httpx.Response:
            if "/markets" in request.url.path:
                offset = int(request.url.params.get("offset", 0))
                return httpx.Response(200, json=[market_row()] if offset == 0 else [])
            return httpx.Response(500, json={"error": "boom"})

        provider = PolymarketSnapshotProvider()
        provider._client = httpx.Client(transport=httpx.MockTransport(handler))
        assert provider.candidates_at(AT) == []

    def test_clob_token_ids_parse_from_a_json_string(self) -> None:
        """Gamma returns this field as a JSON string in some responses."""
        provider, _ = make_provider(markets=[market_row("0xstr")])
        assert provider.load_catalogue()["0xstr"].token_id == "token-0xstr"

    def test_clob_token_ids_parse_from_a_real_list(self) -> None:
        row = market_row("0xlist")
        row["clobTokenIds"] = ["token-a", "token-b"]
        provider, _ = make_provider(markets=[row])
        assert provider.load_catalogue()["0xlist"].token_id == "token-a"

    def test_catalogue_is_loaded_once_and_reused(self) -> None:
        """Re-walking Gamma per decision would dominate cost."""
        provider, log = make_provider(markets=[market_row()])
        provider.candidates_at(AT)
        provider.candidates_at(AT + timedelta(hours=1))
        # One page of markets, plus one terminating empty page.
        assert len(log.params("/markets")) <= 2
