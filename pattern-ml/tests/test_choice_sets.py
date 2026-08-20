"""Point-in-time and group-integrity tests for the choice-set pipeline.

The highest-value tests in the package. A leak here does not crash anything —
it produces an excellent NDCG, a confident model, and losses in production,
with no signal anywhere upstream that something is wrong.

The central device is a provider that **records every timestamp it was asked
for**, so a test can assert the pipeline never requested data at or after the
decision instant.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import polars as pl
import pytest

from pattern_ml.choice.assemble import build_choice_sets, kol_entries
from pattern_ml.choice.schema import (
    REL_CHOSEN,
    REL_IGNORED,
    REL_LATER,
    SolanaScreen,
    screen_coverage,
)
from pattern_ml.schema import CANONICAL_TRADE_SCHEMA, conform

BASE = datetime(2026, 3, 1, 14, 0, tzinfo=timezone.utc)


class RecordingProvider:
    """A provider that logs what it was asked for, and when.

    ``requested`` is what the leakage tests assert against.
    """

    chain = "solana"
    source = "synthetic"

    def __init__(self, universe: dict[str, dict] | None = None) -> None:
        self.requested: list[datetime] = []
        self.universe = universe or {}

    def candidates_at(self, at: datetime, *, limit: int = 200) -> list[dict]:
        self.requested.append(at)
        out = []
        for market_id, features in self.universe.items():
            row = dict(features)
            row["market_id"] = market_id
            out.append(row)
        return out[:limit]

    def features_at(self, market_id: str, at: datetime) -> dict | None:
        self.requested.append(at)
        features = self.universe.get(market_id)
        return dict(features) if features else None


def token(volume: float = 50_000.0, liquidity: float = 20_000.0, age: float = 3600.0) -> dict:
    """A candidate that comfortably passes SolanaScreen."""
    return {
        "volume_5m_usd": volume,
        "liquidity_usd": liquidity,
        "age_seconds": age,
        "price": 0.001,
    }


def trades(rows: list[dict]) -> pl.DataFrame:
    out = []
    for i, row in enumerate(rows):
        out.append(
            {
                "trade_id": f"t{i}",
                "chain": row.get("chain", "solana"),
                "kol_address": row.get("kol", "KOL1"),
                "kol_handle": "kol-one",
                "ts": row["ts"],
                "venue": "jupiter",
                "market_id": row["market_id"],
                "market_label": None,
                "outcome": None,
                "side": row.get("side", "buy"),
                "price": 0.001,
                "qty": 1000.0,
                "size_usd": row.get("size_usd", 500.0),
                "fee_usd": 0.0,
                "tx_ref": f"sig{i}",
                "raw_file": None,
            }
        )
    return conform(pl.DataFrame(out), CANONICAL_TRADE_SCHEMA)


class TestNoLookahead:
    def test_provider_is_never_asked_for_a_time_after_the_decision(self) -> None:
        """The decisive test. Any request at t' > t is lookahead bias."""
        universe = {"A": token(), "B": token(), "C": token(), "D": token()}
        provider = RecordingProvider(universe)

        build_choice_sets(
            trades([{"ts": BASE, "market_id": "A"}]),
            provider,
            SolanaScreen(),
            chain="solana",
        )

        assert provider.requested, "provider was never called"
        assert all(t <= BASE for t in provider.requested), (
            f"requested future data: {[t for t in provider.requested if t > BASE]}"
        )

    def test_universe_is_requested_at_exactly_the_decision_instant(self) -> None:
        provider = RecordingProvider({"A": token(), "B": token(), "C": token()})
        build_choice_sets(
            trades([{"ts": BASE, "market_id": "A"}]),
            provider,
            SolanaScreen(),
            chain="solana",
        )
        assert provider.requested[0] == BASE

    def test_prior_kol_entries_excludes_the_decision_itself(self) -> None:
        """A trade at exactly t is simultaneous, not prior.

        Counting it would let the model see the decision it is predicting.
        """
        provider = RecordingProvider({"A": token(), "B": token(), "C": token()})
        candidates, _ = build_choice_sets(
            trades(
                [
                    {"ts": BASE - timedelta(hours=1), "market_id": "A", "kol": "OTHER"},
                    {"ts": BASE, "market_id": "A", "kol": "KOL1"},
                ]
            ),
            provider,
            SolanaScreen(),
            chain="solana",
        )
        chosen = candidates.filter(
            (pl.col("market_id") == "A") & pl.col("chosen")
        ).row(0, named=True)
        # Only the earlier OTHER buy counts, not KOL1's own simultaneous one.
        assert chosen["prior_kol_entries"] == 1.0

    def test_a_later_buy_never_counts_as_prior_interest(self) -> None:
        provider = RecordingProvider({"A": token(), "B": token(), "C": token()})
        candidates, _ = build_choice_sets(
            trades(
                [
                    {"ts": BASE, "market_id": "A", "kol": "KOL1"},
                    {"ts": BASE + timedelta(hours=2), "market_id": "B", "kol": "OTHER"},
                ]
            ),
            provider,
            SolanaScreen(),
            chain="solana",
        )
        row = candidates.filter(pl.col("market_id") == "B").row(0, named=True)
        assert row["prior_kol_entries"] == 0.0


class TestGradedRelevance:
    def test_the_bought_asset_is_graded_chosen(self) -> None:
        provider = RecordingProvider({"A": token(), "B": token(), "C": token()})
        candidates, _ = build_choice_sets(
            trades([{"ts": BASE, "market_id": "A"}]),
            provider,
            SolanaScreen(),
            chain="solana",
        )
        row = candidates.filter(pl.col("market_id") == "A").row(0, named=True)
        assert row["relevance"] == REL_CHOSEN
        assert row["chosen"]

    def test_bought_later_is_graded_above_ignored(self) -> None:
        """A token bought two hours later was attractive, not rejected."""
        provider = RecordingProvider({"A": token(), "B": token(), "C": token()})
        candidates, _ = build_choice_sets(
            trades(
                [
                    {"ts": BASE, "market_id": "A"},
                    {"ts": BASE + timedelta(hours=2), "market_id": "B"},
                ]
            ),
            provider,
            SolanaScreen(),
            chain="solana",
        )
        first_group = candidates.filter(pl.col("decided_at") == BASE)
        b_row = first_group.filter(pl.col("market_id") == "B").row(0, named=True)
        c_row = first_group.filter(pl.col("market_id") == "C").row(0, named=True)
        assert b_row["relevance"] == REL_LATER
        assert c_row["relevance"] == REL_IGNORED

    def test_a_buy_beyond_the_window_is_a_genuine_rejection(self) -> None:
        provider = RecordingProvider({"A": token(), "B": token(), "C": token()})
        candidates, _ = build_choice_sets(
            trades(
                [
                    {"ts": BASE, "market_id": "A"},
                    {"ts": BASE + timedelta(days=5), "market_id": "B"},
                ]
            ),
            provider,
            SolanaScreen(),
            chain="solana",
            later_window=timedelta(hours=24),
        )
        row = (
            candidates.filter(pl.col("decided_at") == BASE)
            .filter(pl.col("market_id") == "B")
            .row(0, named=True)
        )
        assert row["relevance"] == REL_IGNORED


class TestSimultaneity:
    def test_tokens_bought_in_the_same_minute_are_not_rejections(self) -> None:
        """Three buys in ninety seconds is one decision about three assets.

        Scoring the others as rejections teaches the model to reject exactly
        what this trader likes.
        """
        provider = RecordingProvider(
            {"A": token(), "B": token(), "C": token(), "D": token()}
        )
        candidates, _ = build_choice_sets(
            trades(
                [
                    {"ts": BASE, "market_id": "A"},
                    {"ts": BASE + timedelta(seconds=30), "market_id": "B"},
                ]
            ),
            provider,
            SolanaScreen(),
            chain="solana",
            simultaneity_window=timedelta(minutes=5),
        )
        first_group = candidates.filter(pl.col("decided_at") == BASE)
        assert "B" not in first_group["market_id"].to_list()


class TestScreenBehaviour:
    def test_candidates_failing_the_screen_are_excluded(self) -> None:
        provider = RecordingProvider(
            {
                "A": token(),
                "B": token(),
                "C": token(),
                "DEAD": token(volume=10.0, liquidity=5.0),
            }
        )
        candidates, _ = build_choice_sets(
            trades([{"ts": BASE, "market_id": "A"}]),
            provider,
            SolanaScreen(),
            chain="solana",
        )
        assert "DEAD" not in candidates["market_id"].to_list()

    def test_missing_features_do_not_pass_the_screen(self) -> None:
        """Admitting unknowns lets the model rank on missingness."""
        screen = SolanaScreen()
        assert not screen.passes({"volume_5m_usd": None, "liquidity_usd": 1e6,
                                  "age_seconds": 60})
        assert not screen.passes({"volume_5m_usd": 1e6, "liquidity_usd": 1e6})

    def test_chosen_asset_is_reinserted_and_flagged_when_it_fails(self) -> None:
        """A group with no positive is untrainable, so the choice is re-added.

        The flag is what screen_coverage counts — it is the screen admitting it
        does not describe this trader.
        """
        provider = RecordingProvider(
            {
                "HIDDEN": token(volume=1.0, liquidity=1.0),
                "B": token(),
                "C": token(),
                "D": token(),
            }
        )
        candidates, groups = build_choice_sets(
            trades([{"ts": BASE, "market_id": "HIDDEN"}]),
            provider,
            SolanaScreen(),
            chain="solana",
        )
        assert "HIDDEN" in candidates["market_id"].to_list()
        assert groups.row(0, named=True)["chosen_passed_screen"] is False

    def test_screen_is_capped_at_max_candidates(self) -> None:
        universe = {f"T{i}": token(volume=1000.0 * i) for i in range(1, 40)}
        universe["A"] = token(volume=99_999.0)
        provider = RecordingProvider(universe)
        candidates, groups = build_choice_sets(
            trades([{"ts": BASE, "market_id": "A"}]),
            provider,
            SolanaScreen(max_candidates=10),
            chain="solana",
        )
        assert groups.row(0, named=True)["n_candidates"] <= 10

    def test_groups_below_the_minimum_are_dropped(self) -> None:
        provider = RecordingProvider({"A": token(), "B": token()})
        candidates, groups = build_choice_sets(
            trades([{"ts": BASE, "market_id": "A"}]),
            provider,
            SolanaScreen(),
            chain="solana",
            min_candidates=5,
        )
        assert candidates.is_empty()
        assert groups.is_empty()


class TestEntrySelection:
    def test_only_the_first_buy_per_market_is_a_decision(self) -> None:
        """A scale-in is a follow-through, not a fresh choice."""
        frame = kol_entries(
            trades(
                [
                    {"ts": BASE, "market_id": "A"},
                    {"ts": BASE + timedelta(hours=1), "market_id": "A"},
                    {"ts": BASE + timedelta(hours=2), "market_id": "A"},
                ]
            ),
            chain="solana",
        )
        assert frame.height == 1
        assert frame.row(0, named=True)["ts"] == BASE

    def test_sells_are_not_decisions(self) -> None:
        frame = kol_entries(
            trades([{"ts": BASE, "market_id": "A", "side": "sell"}]), chain="solana"
        )
        assert frame.is_empty()

    def test_different_kols_get_their_own_decisions(self) -> None:
        frame = kol_entries(
            trades(
                [
                    {"ts": BASE, "market_id": "A", "kol": "K1"},
                    {"ts": BASE, "market_id": "A", "kol": "K2"},
                ]
            ),
            chain="solana",
        )
        assert frame.height == 2


class TestScreenCoverage:
    def test_reports_per_kol_coverage(self) -> None:
        groups = pl.DataFrame(
            {
                "kol_address": ["K1", "K1", "K2", "K2"],
                "chosen_passed_screen": [True, True, True, False],
                "n_candidates": [10, 10, 10, 10],
            }
        )
        coverage = screen_coverage(groups)
        by_kol = {r["kol_address"]: r for r in coverage.iter_rows(named=True)}
        assert by_kol["K1"]["coverage"] == pytest.approx(1.0)
        assert by_kol["K2"]["coverage"] == pytest.approx(0.5)

    def test_empty_input_is_not_an_error(self) -> None:
        assert screen_coverage(pl.DataFrame()).is_empty()
