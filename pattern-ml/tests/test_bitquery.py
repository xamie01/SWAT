"""Tests for the Bitquery client's error handling and pacing.

The behaviour worth pinning is the failure taxonomy. GraphQL returns HTTP 200
for schema errors, so a renamed field looks exactly like a quiet market unless
the ``errors`` key is checked explicitly — and a silently empty result at scale
reads as "these KOLs had no alternatives" rather than "the query is wrong".
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import httpx
import pytest

from pattern_ml.sources.bitquery import (
    BitqueryClient,
    BitqueryError,
    _iso,
    _mint_of,
)

AT = datetime(2026, 3, 1, 14, 0, tzinfo=timezone.utc)


def make_client(handler, **kwargs) -> BitqueryClient:
    # backoff_scale=0 so retry paths run instantly instead of sleeping seconds.
    client = BitqueryClient(token="test-token", max_rps=0, backoff_scale=0, **kwargs)
    client._client = httpx.Client(transport=httpx.MockTransport(handler))
    return client


def ok(payload: dict):
    return lambda request: httpx.Response(200, json=payload)


class TestErrorTaxonomy:
    def test_a_graphql_error_raises_rather_than_returning_empty(self) -> None:
        """The decisive test: HTTP 200 with an `errors` key is still a failure.

        Treating this as an empty result is how a schema drift turns into a
        training set with no negatives and no indication anything went wrong.
        """
        client = make_client(
            ok({"errors": [{"message": "Cannot query field 'volume_usd'"}]})
        )
        with pytest.raises(BitqueryError, match="volume_usd"):
            client.top_by_volume(since=AT - timedelta(minutes=10), till=AT,
                                 programs=["P"], limit=1)

    def test_a_4xx_is_not_retried(self) -> None:
        """A malformed query is a bug; retrying only hides it."""
        calls = []

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(request)
            return httpx.Response(400, json={"error": "bad query"})

        client = make_client(handler)
        with pytest.raises(BitqueryError, match="400"):
            client.pool_creations(since=AT - timedelta(minutes=10), till=AT,
                                  program="P", limit=1)
        assert len(calls) == 1

    def test_a_bad_token_says_so_plainly(self) -> None:
        client = make_client(lambda r: httpx.Response(401, json={}))
        with pytest.raises(BitqueryError, match="token"):
            client.top_by_volume(since=AT - timedelta(minutes=10), till=AT,
                                 programs=["P"], limit=1)

    def test_a_5xx_is_retried_then_gives_up(self) -> None:
        calls = []

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(request)
            return httpx.Response(503, json={})

        client = make_client(handler, max_retries=2)
        with pytest.raises(BitqueryError):
            client.top_by_volume(since=AT - timedelta(minutes=10), till=AT,
                                 programs=["P"], limit=1)
        assert len(calls) == 2

    def test_a_missing_token_fails_before_any_request(self) -> None:
        # `isolated_settings` clears BITQUERY_TOKEN from the environment, so
        # __post_init__ cannot backfill one from the repo-root .env.
        client = BitqueryClient(token=None, max_rps=0, backoff_scale=0)
        assert client.token is None, "a real token leaked into the test environment"
        client._client = httpx.Client(
            transport=httpx.MockTransport(
                lambda r: pytest.fail("a request was made without a token")
            )
        )
        with pytest.raises(BitqueryError, match="BITQUERY_TOKEN"):
            client.top_by_volume(since=AT - timedelta(minutes=10), till=AT,
                                 programs=["P"], limit=1)

    def test_a_response_without_data_is_an_error(self) -> None:
        client = make_client(ok({"extensions": {}}))
        with pytest.raises(BitqueryError, match="data"):
            client.top_by_volume(since=AT - timedelta(minutes=10), till=AT,
                                 programs=["P"], limit=1)


class TestRequestShape:
    def test_the_time_bounds_are_sent_as_utc_iso(self) -> None:
        captured: list[dict] = []

        def handler(request: httpx.Request) -> httpx.Response:
            import json

            captured.append(json.loads(request.content)["variables"])
            return httpx.Response(200, json={"data": {"Solana": {"DEXTradeByTokens": []}}})

        client = make_client(handler)
        client.top_by_volume(
            since=AT - timedelta(minutes=10), till=AT, programs=["P"], limit=5
        )
        assert captured[0]["till"] == "2026-03-01T14:00:00Z"
        assert captured[0]["since"] == "2026-03-01T13:50:00Z"

    def test_a_naive_datetime_is_treated_as_utc_not_local(self) -> None:
        """A local-time slip would shift the leakage boundary by hours."""
        naive = datetime(2026, 3, 1, 14, 0)
        assert _iso(naive.replace(tzinfo=timezone.utc)) == "2026-03-01T14:00:00Z"

    def test_curve_bounds_are_sent_as_strings(self) -> None:
        """Bitquery compares these as strings; floats silently return nothing."""
        captured: list[dict] = []

        def handler(request: httpx.Request) -> httpx.Response:
            import json

            captured.append(json.loads(request.content)["variables"])
            return httpx.Response(200, json={"data": {"Solana": {"DEXPools": []}}})

        client = make_client(handler)
        client.bonding_curves(
            since=AT - timedelta(minutes=10),
            till=AT,
            program="P",
            min_remaining=206_900_000.0,
            max_remaining=380_000_000.0,
            limit=5,
        )
        assert isinstance(captured[0]["minRemaining"], str)
        assert "." not in captured[0]["minRemaining"]


class TestResponseShaping:
    def test_rows_are_unwrapped_from_the_solana_envelope(self) -> None:
        client = make_client(
            ok({"data": {"Solana": {"DEXTradeByTokens": [{"volume_usd": 1.0}]}}})
        )
        rows = client.top_by_volume(
            since=AT - timedelta(minutes=10), till=AT, programs=["P"], limit=1
        )
        assert rows == [{"volume_usd": 1.0}]

    def test_an_unexpected_envelope_yields_no_rows_rather_than_crashing(self) -> None:
        client = make_client(ok({"data": {"Solana": None}}))
        assert client.top_by_volume(
            since=AT - timedelta(minutes=10), till=AT, programs=["P"], limit=1
        ) == []

    def test_mint_extraction_handles_both_row_shapes(self) -> None:
        trade_row = {"Trade": {"Currency": {"MintAddress": "M1"}}}
        pool_row = {"Pool": {"Market": {"BaseCurrency": {"MintAddress": "M2"}}}}
        assert _mint_of(trade_row) == "M1"
        assert _mint_of(pool_row) == "M2"
        assert _mint_of({"Trade": {}}) is None
        assert _mint_of({}) is None
