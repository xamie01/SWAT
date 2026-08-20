"""Tests for round-trip position reconstruction.

Positions are where labels come from, so an error here poisons everything
downstream: any model, any cluster, any mined rule learns from ``is_win``.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import polars as pl
import pytest

from pattern_ml.index.positions import build_positions, label_coverage
from pattern_ml.schema import CANONICAL_TRADE_SCHEMA, conform

BASE = datetime(2026, 1, 1, tzinfo=timezone.utc)


def trades(rows: list[dict]) -> pl.DataFrame:
    out = []
    for i, row in enumerate(rows):
        out.append(
            {
                "trade_id": row.get("trade_id", f"t{i}"),
                "chain": row.get("chain", "solana"),
                "kol_address": row.get("kol_address", "KOL1"),
                "kol_handle": "kol-one",
                "ts": row.get("ts", BASE + timedelta(minutes=i)),
                "venue": "jupiter",
                "market_id": row.get("market_id", "TOKEN_A"),
                "market_label": "TokenA",
                "outcome": row.get("outcome"),
                "side": row["side"],
                "price": row.get("price"),
                "qty": row["qty"],
                "size_usd": row.get("size_usd"),
                "fee_usd": row.get("fee_usd", 0.0),
                "tx_ref": f"sig{i}",
                "raw_file": None,
            }
        )
    return conform(pl.DataFrame(out), CANONICAL_TRADE_SCHEMA)


class TestBasicRoundTrip:
    def test_buy_then_full_sell_closes_the_position(self) -> None:
        frame = build_positions(
            trades(
                [
                    {"side": "buy", "qty": 100, "size_usd": 1000, "price": 10},
                    {"side": "sell", "qty": 100, "size_usd": 1500, "price": 15},
                ]
            )
        )
        assert frame.height == 1
        row = frame.row(0, named=True)
        assert row["is_closed"]
        assert row["cost_usd"] == pytest.approx(1000)
        assert row["proceeds_usd"] == pytest.approx(1500)
        assert row["pnl_usd"] == pytest.approx(500)
        assert row["roi"] == pytest.approx(0.5)
        assert row["is_win"]

    def test_a_loss_is_labelled_a_loss(self) -> None:
        frame = build_positions(
            trades(
                [
                    {"side": "buy", "qty": 100, "size_usd": 1000},
                    {"side": "sell", "qty": 100, "size_usd": 400},
                ]
            )
        )
        row = frame.row(0, named=True)
        assert row["pnl_usd"] == pytest.approx(-600)
        assert not row["is_win"]

    def test_fees_are_charged_against_pnl(self) -> None:
        frame = build_positions(
            trades(
                [
                    {"side": "buy", "qty": 100, "size_usd": 1000, "fee_usd": 5},
                    {"side": "sell", "qty": 100, "size_usd": 1100, "fee_usd": 5},
                ]
            )
        )
        row = frame.row(0, named=True)
        assert row["fees_usd"] == pytest.approx(10)
        assert row["pnl_usd"] == pytest.approx(90)

    def test_hold_time_is_measured_open_to_close(self) -> None:
        frame = build_positions(
            trades(
                [
                    {"side": "buy", "qty": 10, "size_usd": 100, "ts": BASE},
                    {
                        "side": "sell",
                        "qty": 10,
                        "size_usd": 150,
                        "ts": BASE + timedelta(hours=2),
                    },
                ]
            )
        )
        assert frame.row(0, named=True)["hold_seconds"] == pytest.approx(7200)


class TestPartialAndScaledPositions:
    def test_scaling_in_averages_the_entry(self) -> None:
        frame = build_positions(
            trades(
                [
                    {"side": "buy", "qty": 100, "size_usd": 1000},
                    {"side": "buy", "qty": 100, "size_usd": 3000},
                    {"side": "sell", "qty": 200, "size_usd": 5000},
                ]
            )
        )
        row = frame.row(0, named=True)
        assert row["entry_count"] == 2
        assert row["cost_usd"] == pytest.approx(4000)
        assert row["avg_entry_price"] == pytest.approx(20.0)  # 4000/200
        assert row["pnl_usd"] == pytest.approx(1000)

    def test_partial_exit_leaves_the_position_open(self) -> None:
        frame = build_positions(
            trades(
                [
                    {"side": "buy", "qty": 100, "size_usd": 1000},
                    {"side": "sell", "qty": 40, "size_usd": 600},
                ]
            )
        )
        row = frame.row(0, named=True)
        assert not row["is_closed"]
        assert row["residual_qty"] == pytest.approx(60)
        # An unfinished position has no result to learn from.
        assert row["is_win"] is None

    def test_dust_left_behind_still_counts_as_closed(self) -> None:
        """Rounding means inventory rarely returns to exactly zero."""
        frame = build_positions(
            trades(
                [
                    {"side": "buy", "qty": 100, "size_usd": 1000},
                    {"side": "sell", "qty": 99.9, "size_usd": 1500},
                ]
            )
        )
        assert frame.row(0, named=True)["is_closed"]

    def test_reopening_after_a_flat_creates_a_second_position(self) -> None:
        frame = build_positions(
            trades(
                [
                    {"side": "buy", "qty": 100, "size_usd": 1000},
                    {"side": "sell", "qty": 100, "size_usd": 1200},
                    {"side": "buy", "qty": 50, "size_usd": 700},
                    {"side": "sell", "qty": 50, "size_usd": 500},
                ]
            )
        )
        assert frame.height == 2
        results = sorted(frame["pnl_usd"].to_list())
        assert results[0] == pytest.approx(-200)
        assert results[1] == pytest.approx(200)


class TestEdgeCases:
    def test_empty_input(self) -> None:
        assert build_positions(trades([])).is_empty()

    def test_sell_with_no_prior_buy_is_ignored(self) -> None:
        """Inventory bought before the data window has no knowable cost basis.

        Recording it would invent a position with zero cost and infinite ROI.
        """
        frame = build_positions(trades([{"side": "sell", "qty": 100, "size_usd": 500}]))
        assert frame.is_empty()

    def test_buy_with_no_sell_stays_open_and_unlabelled(self) -> None:
        frame = build_positions(trades([{"side": "buy", "qty": 100, "size_usd": 1000}]))
        row = frame.row(0, named=True)
        assert not row["is_closed"]
        assert row["is_win"] is None

    def test_different_markets_are_separate_positions(self) -> None:
        frame = build_positions(
            trades(
                [
                    {"side": "buy", "qty": 10, "size_usd": 100, "market_id": "A"},
                    {"side": "buy", "qty": 10, "size_usd": 100, "market_id": "B"},
                    {"side": "sell", "qty": 10, "size_usd": 150, "market_id": "A"},
                    {"side": "sell", "qty": 10, "size_usd": 50, "market_id": "B"},
                ]
            )
        )
        assert frame.height == 2

    def test_different_kols_are_separate_positions(self) -> None:
        frame = build_positions(
            trades(
                [
                    {"side": "buy", "qty": 10, "size_usd": 100, "kol_address": "A"},
                    {"side": "buy", "qty": 10, "size_usd": 100, "kol_address": "B"},
                ]
            )
        )
        assert frame.height == 2
        assert set(frame["kol_address"].to_list()) == {"A", "B"}

    def test_polymarket_outcomes_are_separate_positions(self) -> None:
        """Yes and No on the same market are opposite bets, not one position."""
        frame = build_positions(
            trades(
                [
                    {
                        "side": "buy",
                        "qty": 10,
                        "size_usd": 4,
                        "outcome": "Yes",
                        "chain": "polymarket",
                    },
                    {
                        "side": "buy",
                        "qty": 10,
                        "size_usd": 6,
                        "outcome": "No",
                        "chain": "polymarket",
                    },
                ]
            )
        )
        assert frame.height == 2

    def test_oversized_sell_cannot_create_phantom_proceeds(self) -> None:
        """Selling more than was bought must clip to held inventory."""
        frame = build_positions(
            trades(
                [
                    {"side": "buy", "qty": 100, "size_usd": 1000},
                    {"side": "sell", "qty": 500, "size_usd": 5000},
                ]
            )
        )
        row = frame.row(0, named=True)
        assert row["qty_sold"] == pytest.approx(100)
        # Proceeds are pro-rated to the portion actually held.
        assert row["proceeds_usd"] == pytest.approx(1000)

    def test_null_size_usd_does_not_drag_the_average_price_down(self) -> None:
        """Unpriced fills must not be treated as zero-cost."""
        frame = build_positions(
            trades(
                [
                    {"side": "buy", "qty": 100, "size_usd": 1000},
                    {"side": "buy", "qty": 100, "size_usd": None},
                    {"side": "sell", "qty": 200, "size_usd": 3000},
                ]
            )
        )
        # Only the priced 100 units back the 1000 of cost.
        assert frame.row(0, named=True)["avg_entry_price"] == pytest.approx(10.0)


class TestLabelCoverage:
    def test_reports_zero_for_an_empty_frame(self) -> None:
        assert label_coverage(build_positions(trades([])))["positions"] == 0

    def test_counts_closed_and_labelled_separately(self) -> None:
        frame = build_positions(
            trades(
                [
                    {"side": "buy", "qty": 10, "size_usd": 100, "market_id": "A"},
                    {"side": "sell", "qty": 10, "size_usd": 150, "market_id": "A"},
                    {"side": "buy", "qty": 10, "size_usd": 100, "market_id": "B"},
                ]
            )
        )
        coverage = label_coverage(frame)
        assert coverage["positions"] == 2
        assert coverage["closed"] == 1
        assert coverage["labelled"] == 1
        assert coverage["closed_rate"] == pytest.approx(0.5)
