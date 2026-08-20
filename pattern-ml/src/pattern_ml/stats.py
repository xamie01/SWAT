"""Statistical helpers shared by the miners and the validators.

Pattern mining generates hypotheses by the thousand. Testing each one at
p < 0.05 and keeping the winners is how you manufacture a portfolio of pure
noise: with 2,000 candidate patterns and no real edge anywhere, ~100 still
clear that bar. Everything here exists to stop that happening, so no miner in
this package reports a raw p-value without a correction beside it.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy import stats


@dataclass(frozen=True)
class RateTest:
    """A win-rate claim, with everything needed to judge it."""

    successes: int
    trials: int
    baseline: float
    p_value: float
    ci_low: float
    ci_high: float

    @property
    def rate(self) -> float:
        return self.successes / self.trials if self.trials else 0.0

    @property
    def lift(self) -> float:
        """Win rate minus the baseline it's being compared against."""
        return self.rate - self.baseline

    @property
    def beats_baseline_at_ci(self) -> bool:
        """The honest test: is the *whole* confidence interval above baseline?

        A point estimate above baseline means little at low sample counts. This
        is the check that survives contact with live trading.
        """
        return self.ci_low > self.baseline


def wilson_interval(
    successes: int, trials: int, confidence: float = 0.95
) -> tuple[float, float]:
    """Wilson score interval for a binomial proportion.

    Preferred over the normal approximation because pattern subgroups are often
    small and extreme (9 wins from 10). The normal interval happily returns
    bounds above 1.0 there; Wilson stays inside [0,1] and keeps its coverage.
    """
    if trials <= 0:
        return (0.0, 0.0)
    z = stats.norm.ppf(1 - (1 - confidence) / 2)
    phat = successes / trials
    denom = 1 + z**2 / trials
    centre = (phat + z**2 / (2 * trials)) / denom
    margin = (
        z * np.sqrt(phat * (1 - phat) / trials + z**2 / (4 * trials**2))
    ) / denom
    return (max(0.0, centre - margin), min(1.0, centre + margin))


def test_rate(successes: int, trials: int, baseline: float) -> RateTest:
    """One-sided binomial test that a subgroup beats the baseline rate."""
    if trials <= 0:
        return RateTest(0, 0, baseline, 1.0, 0.0, 0.0)
    result = stats.binomtest(successes, trials, baseline, alternative="greater")
    low, high = wilson_interval(successes, trials)
    return RateTest(
        successes=successes,
        trials=trials,
        baseline=baseline,
        p_value=float(result.pvalue),
        ci_low=low,
        ci_high=high,
    )


def benjamini_hochberg(p_values: list[float], fdr: float = 0.05) -> list[bool]:
    """Benjamini–Hochberg step-up. Returns a keep/discard mask.

    Controls the false *discovery* rate — the share of reported patterns that
    are noise — rather than the family-wise error rate. That is the right
    tradeoff here: Bonferroni over thousands of patterns is so conservative it
    would reject genuine edges too, and a handful of false positives in a
    ranked shortlist is survivable when every survivor still has to clear a
    walk-forward backtest.
    """
    n = len(p_values)
    if n == 0:
        return []
    order = np.argsort(p_values)
    ranked = np.asarray(p_values, dtype=float)[order]
    thresholds = fdr * np.arange(1, n + 1) / n
    passing = np.where(ranked <= thresholds)[0]
    keep = np.zeros(n, dtype=bool)
    if passing.size:
        # Everything up to the largest passing rank is kept.
        keep[order[: passing[-1] + 1]] = True
    return keep.tolist()


def bootstrap_ci(
    values: np.ndarray,
    statistic=np.mean,
    n_boot: int = 2_000,
    confidence: float = 0.95,
    seed: int = 0,
) -> tuple[float, float]:
    """Percentile bootstrap CI, for statistics with no closed form.

    Used for mean ROI, whose distribution is far too heavy-tailed for a
    t-interval — one 40x memecoin runner dominates the mean and the normal
    approximation understates the spread badly.
    """
    values = np.asarray(values, dtype=float)
    values = values[np.isfinite(values)]
    if values.size == 0:
        return (float("nan"), float("nan"))
    rng = np.random.default_rng(seed)
    draws = rng.choice(values, size=(n_boot, values.size), replace=True)
    stats_ = statistic(draws, axis=1)
    alpha = (1 - confidence) / 2
    return (
        float(np.quantile(stats_, alpha)),
        float(np.quantile(stats_, 1 - alpha)),
    )


def deflated_sharpe(sharpe: float, n_trials: int, n_obs: int) -> float:
    """Haircut a Sharpe ratio for the number of configurations tried.

    Searching many patterns and reporting the best inflates Sharpe even with no
    edge. This applies the standard multiple-testing adjustment so the number
    that gets reported is the one that survived the search, not the one that
    won it.
    """
    if n_trials < 1 or n_obs < 2:
        return sharpe
    euler = 0.5772156649
    # Expected maximum Sharpe of `n_trials` independent zero-edge strategies.
    expected_max = (1 - euler) * stats.norm.ppf(
        1 - 1 / n_trials
    ) + euler * stats.norm.ppf(1 - 1 / (n_trials * np.e))
    return float((sharpe - expected_max) * np.sqrt(n_obs - 1))
