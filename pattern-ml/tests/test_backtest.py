"""Tests for follower-side backtesting.

The recurring failure mode this guards against: reporting the KOL's return as
if it were the copier's. Every test here checks that frictions actually bite.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import polars as pl
import pytest

from pattern_ml.validate import (
    Frictions,
    apply_frictions,
    backtest,
    null_baseline,
    significance_vs_null,
)

BASE = datetime(2026, 1, 1, tzinfo=timezone.utc)


def make_positions(specs: list[dict]) -> pl.DataFrame:
    rows = []
    for i, spec in enumerate(specs):
        entry = spec.get("avg_entry_price", 1.0)
        exit_ = spec.get("avg_exit_price", 1.1)
        rows.append(
            {
                "position_id": f"p{i}",
                "kol_address": spec.get("kol_address", "KOL1"),
                "opened_at": BASE + timedelta(hours=i),
                "avg_entry_price": entry,
                "avg_exit_price": exit_,
                "roi": spec.get("roi", exit_ / entry - 1),
                "hold_seconds": spec.get("hold_seconds", 3600.0),
                "is_win": spec.get("is_win", exit_ > entry),
                "cost_usd": spec.get("cost_usd", 1000.0),
            }
        )
    return pl.DataFrame(rows)


class TestFrictions:
    def test_round_trip_cost_sums_both_legs_and_fees(self) -> None:
        frictions = Frictions(
            entry_slippage_bps=100, exit_slippage_bps=100, fee_bps_per_side=25
        )
        # 100 + 100 + 2*25 = 250 bps
        assert frictions.round_trip_cost == pytest.approx(0.025)

    def test_zero_frictions_is_a_valid_configuration(self) -> None:
        assert Frictions(0, 0, 0).round_trip_cost == 0.0

    def test_follower_roi_is_always_worse_than_kol_roi(self) -> None:
        positions = make_positions([{"avg_entry_price": 1.0, "avg_exit_price": 1.5}])
        row = apply_frictions(positions, Frictions()).row(0, named=True)
        assert row["follower_roi"] < row["roi"]

    def test_marginal_winner_becomes_a_loser_after_costs(self) -> None:
        """A 2% gain does not survive a 3.6% round trip. This is the point."""
        positions = make_positions([{"avg_entry_price": 1.0, "avg_exit_price": 1.02}])
        adjusted = apply_frictions(positions, Frictions())
        assert adjusted.row(0, named=True)["follower_roi"] < 0

    def test_falls_back_to_haircutting_roi_when_prices_are_missing(self) -> None:
        positions = make_positions([{}]).with_columns(
            avg_entry_price=pl.lit(None, dtype=pl.Float64),
            avg_exit_price=pl.lit(None, dtype=pl.Float64),
        )
        row = apply_frictions(positions, Frictions()).row(0, named=True)
        assert row["follower_roi"] == pytest.approx(
            row["roi"] - Frictions().round_trip_cost
        )


class TestBacktest:
    def test_empty_selection_does_not_raise(self) -> None:
        result = backtest(make_positions([]).clear())
        assert result.n_positions == 0
        assert not result.is_profitable

    def test_drops_positions_too_fast_to_copy(self) -> None:
        positions = make_positions([{"hold_seconds": 5.0}, {"hold_seconds": 3600.0}])
        result = backtest(positions)
        assert result.n_skipped == 1
        assert result.n_positions == 1
        assert any("un-copyable" in note for note in result.notes)

    def test_a_strong_edge_survives_frictions(self) -> None:
        # 50% gains clear a 3.6% round trip comfortably.
        positions = make_positions(
            [{"avg_entry_price": 1.0, "avg_exit_price": 1.5} for _ in range(40)]
        )
        result = backtest(positions)
        assert result.mean_roi > 0
        assert result.is_profitable

    def test_a_thin_edge_does_not_survive(self) -> None:
        positions = make_positions(
            [{"avg_entry_price": 1.0, "avg_exit_price": 1.01} for _ in range(40)]
        )
        result = backtest(positions)
        assert result.mean_roi < 0
        assert not result.is_profitable

    def test_equity_curve_has_one_row_per_traded_position(self) -> None:
        result = backtest(make_positions([{} for _ in range(7)]))
        assert result.equity_curve.height == result.n_positions

    def test_max_drawdown_is_zero_or_negative(self) -> None:
        assert backtest(make_positions([{} for _ in range(10)])).max_drawdown <= 0

    def test_drawdown_is_detected_on_a_losing_run(self) -> None:
        positions = make_positions(
            [
                {"avg_entry_price": 1.0, "avg_exit_price": 2.0},
                {"avg_entry_price": 1.0, "avg_exit_price": 0.5},
                {"avg_entry_price": 1.0, "avg_exit_price": 0.5},
            ]
        )
        assert backtest(positions).max_drawdown < 0

    def test_stake_fraction_scales_total_return(self) -> None:
        positions = make_positions(
            [{"avg_entry_price": 1.0, "avg_exit_price": 1.5} for _ in range(10)]
        )
        small = backtest(positions, stake_fraction=0.01)
        large = backtest(positions, stake_fraction=0.05)
        assert large.total_return > small.total_return
        # Per-position ROI is a property of the trades, not of sizing.
        assert small.mean_roi == pytest.approx(large.mean_roi)


class TestNullBaseline:
    def test_random_selection_matches_the_pool_mean(self) -> None:
        positions = make_positions(
            [{"avg_entry_price": 1.0, "avg_exit_price": 1.2} for _ in range(50)]
        )
        null = null_baseline(positions, n_selected=10, n_samples=200, seed=0)
        adjusted = apply_frictions(positions, Frictions())
        assert null["mean_roi"] == pytest.approx(adjusted["follower_roi"].mean(), abs=0.01)

    def test_no_selection_returns_an_inert_result(self) -> None:
        null = null_baseline(make_positions([{}]), n_selected=0)
        assert null["n_samples"] == 0
        assert null["pool_size"] == 0

    def test_result_shape_is_the_same_whether_or_not_it_ran(self) -> None:
        """Callers index this dict directly; the keys must not vary."""
        ran = null_baseline(make_positions([{} for _ in range(5)]), 2, n_samples=10)
        inert = null_baseline(make_positions([{}]), n_selected=0)
        assert ran.keys() == inert.keys()

    def test_uniform_pool_yields_no_edge(self) -> None:
        """If every trade is identical, no selection can beat random."""
        positions = make_positions(
            [{"avg_entry_price": 1.0, "avg_exit_price": 1.2} for _ in range(40)]
        )
        result = backtest(positions)
        null = null_baseline(positions, result.n_positions, n_samples=200, seed=0)
        assert not significance_vs_null(result, null)["beats_null"]

    def test_edge_is_reported_relative_to_the_null(self) -> None:
        good = make_positions(
            [{"avg_entry_price": 1.0, "avg_exit_price": 2.0} for _ in range(10)]
        )
        mixed = pl.concat(
            [
                good,
                make_positions(
                    [{"avg_entry_price": 1.0, "avg_exit_price": 0.5} for _ in range(30)]
                ),
            ]
        )
        result = backtest(good)
        null = null_baseline(mixed, result.n_positions, n_samples=200, seed=0)
        assert significance_vs_null(result, null)["edge"] > 0
