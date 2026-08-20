"""Validation: does a candidate strategy survive contact with reality?

Mining finds candidates. This package tries to kill them, via follower-side
frictions and a random-selection null. Anything still standing afterwards is
worth trading; anything that isn't was an artefact of the search.
"""

from .backtest import (
    BacktestResult,
    Frictions,
    apply_frictions,
    backtest,
    null_baseline,
    significance_vs_null,
)

__all__ = [
    "BacktestResult",
    "Frictions",
    "apply_frictions",
    "backtest",
    "null_baseline",
    "significance_vs_null",
]
