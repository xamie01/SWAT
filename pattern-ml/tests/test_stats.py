"""Tests for the statistical helpers.

These matter more than they look. If ``benjamini_hochberg`` is wrong, every
mined pattern report is wrong in the direction of false confidence, and nothing
downstream would notice.
"""

from __future__ import annotations

import numpy as np

from pattern_ml.stats import (
    benjamini_hochberg,
    bootstrap_ci,
    test_rate,
    wilson_interval,
)


class TestWilsonInterval:
    def test_contains_point_estimate(self) -> None:
        low, high = wilson_interval(7, 10)
        assert low < 0.7 < high

    def test_stays_inside_unit_range_at_extremes(self) -> None:
        # The normal approximation returns > 1.0 here; Wilson must not.
        low, high = wilson_interval(10, 10)
        assert 0.0 <= low <= 1.0
        assert 0.0 <= high <= 1.0

    def test_zero_successes_has_zero_lower_bound(self) -> None:
        low, _ = wilson_interval(0, 20)
        assert low == 0.0

    def test_interval_narrows_with_more_data(self) -> None:
        narrow = wilson_interval(700, 1000)
        wide = wilson_interval(7, 10)
        assert (narrow[1] - narrow[0]) < (wide[1] - wide[0])

    def test_no_trials_is_not_an_error(self) -> None:
        assert wilson_interval(0, 0) == (0.0, 0.0)


class TestRateTest:
    def test_detects_a_real_edge(self) -> None:
        result = test_rate(successes=80, trials=100, baseline=0.5)
        assert result.p_value < 0.001
        assert result.beats_baseline_at_ci

    def test_small_sample_does_not_clear_ci_gate(self) -> None:
        """9/10 looks spectacular and must still fail the honest test."""
        result = test_rate(successes=9, trials=10, baseline=0.5)
        assert result.rate == 0.9
        # The point estimate is far above baseline; the lower bound decides.
        assert result.ci_low < 0.9

    def test_at_baseline_is_not_significant(self) -> None:
        result = test_rate(successes=50, trials=100, baseline=0.5)
        assert result.p_value > 0.05
        assert not result.beats_baseline_at_ci

    def test_lift_is_relative_to_baseline(self) -> None:
        result = test_rate(successes=60, trials=100, baseline=0.5)
        assert abs(result.lift - 0.1) < 1e-9


class TestBenjaminiHochberg:
    def test_empty_input(self) -> None:
        assert benjamini_hochberg([]) == []

    def test_keeps_clearly_significant(self) -> None:
        keep = benjamini_hochberg([0.0001, 0.9, 0.8, 0.7])
        assert keep[0] is True

    def test_rejects_all_when_nothing_is_significant(self) -> None:
        assert not any(benjamini_hochberg([0.6, 0.7, 0.8, 0.9]))

    def test_is_stricter_than_a_raw_threshold(self) -> None:
        """The whole point: 0.04 survives alone, but not among 100 nulls."""
        assert benjamini_hochberg([0.04]) == [True]
        crowd = benjamini_hochberg([0.04] + [0.5] * 99)
        assert crowd[0] is False

    def test_step_up_keeps_everything_below_the_largest_passing_rank(self) -> None:
        # With n=4 and fdr=0.05 the thresholds are .0125, .025, .0375, .05
        keep = benjamini_hochberg([0.001, 0.02, 0.9, 0.9])
        assert keep[0] is True
        assert keep[1] is True
        assert keep[2] is False

    def test_input_order_is_preserved(self) -> None:
        assert benjamini_hochberg([0.9, 0.0001, 0.9]) == [False, True, False]


class TestBootstrapCi:
    def test_brackets_the_mean(self) -> None:
        values = np.random.default_rng(0).normal(loc=0.5, scale=0.1, size=500)
        low, high = bootstrap_ci(values, seed=0)
        assert low < 0.5 < high

    def test_is_deterministic_for_a_fixed_seed(self) -> None:
        values = np.array([0.1, -0.2, 0.5, 0.3, -0.1])
        assert bootstrap_ci(values, seed=7) == bootstrap_ci(values, seed=7)

    def test_empty_input_returns_nan(self) -> None:
        low, high = bootstrap_ci(np.array([]))
        assert np.isnan(low) and np.isnan(high)

    def test_ignores_non_finite_values(self) -> None:
        values = np.array([0.1, 0.2, np.nan, np.inf, 0.3])
        low, high = bootstrap_ci(values, seed=0)
        assert np.isfinite(low) and np.isfinite(high)
