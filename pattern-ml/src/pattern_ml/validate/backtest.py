"""Backtest a set of positions as a *follower*, not as the KOL.

The distinction is the entire point of this module. A pattern can be perfectly
real — the KOL genuinely does win 70% of the time after doing X — and still be
worthless to copy, because by the time you see the trade the price has moved.
Reporting the KOL's own ROI as if it were yours is the most common way a
copy-trading backtest lies.

Three frictions are modelled, all pushing the same direction:

* **Latency** — you act after the KOL. On a Solana memecoin that is the
  difference between their entry and a much higher price.
* **Slippage** — your fill is worse than theirs, on both legs.
* **Fees** — per-side, in basis points.

The model is intentionally simple and pessimistic. It applies a fixed slippage
haircut rather than simulating an order book, because the honest answer to
"what would this have filled at" is unknowable from trade history alone. Treat
the output as an upper bound on what a follower could have made: if an edge
does not survive these assumptions, it will not survive a real venue.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import polars as pl

from ..stats import bootstrap_ci, deflated_sharpe


@dataclass(frozen=True)
class Frictions:
    """Cost assumptions for a follower.

    Defaults are deliberately harsh. Solana memecoin routes routinely give up
    more than 150 bps on a sizeable market order, and the point of a default is
    to avoid flattering the strategy.
    """

    entry_slippage_bps: float = 150.0
    exit_slippage_bps: float = 150.0
    fee_bps_per_side: float = 30.0
    # Positions the follower could not realistically have entered — the KOL was
    # in and out before a copier could react.
    min_hold_seconds: float = 60.0

    @property
    def round_trip_cost(self) -> float:
        """Total proportional cost of a round trip."""
        return (
            self.entry_slippage_bps + self.exit_slippage_bps + 2 * self.fee_bps_per_side
        ) / 10_000.0


@dataclass
class BacktestResult:
    n_positions: int
    n_skipped: int
    win_rate: float
    mean_roi: float
    median_roi: float
    roi_ci: tuple[float, float]
    total_return: float
    sharpe: float | None
    deflated_sharpe: float | None
    max_drawdown: float
    equity_curve: pl.DataFrame
    frictions: Frictions
    notes: list[str] = field(default_factory=list)

    @property
    def is_profitable(self) -> bool:
        """Profitable *after* frictions, with the CI clearing zero.

        A positive mean ROI whose confidence interval straddles zero is not a
        finding, and this property is what says so.
        """
        return self.mean_roi > 0 and self.roi_ci[0] > 0


def apply_frictions(positions: pl.DataFrame, frictions: Frictions) -> pl.DataFrame:
    """Recompute each position's ROI from a follower's perspective.

    Uses ``avg_entry_price``/``avg_exit_price`` to model both legs where they
    exist. Positions without them fall back to haircutting the KOL's own ROI,
    which is cruder but still directionally right.
    """
    if positions.is_empty():
        return positions

    cost = frictions.round_trip_cost
    entry_mult = 1 + frictions.entry_slippage_bps / 10_000.0
    exit_mult = 1 - frictions.exit_slippage_bps / 10_000.0
    fee = 2 * frictions.fee_bps_per_side / 10_000.0

    has_prices = (
        "avg_entry_price" in positions.columns and "avg_exit_price" in positions.columns
    )
    if has_prices:
        follower_roi = (
            pl.when(
                pl.col("avg_entry_price").is_not_null()
                & pl.col("avg_exit_price").is_not_null()
                & (pl.col("avg_entry_price") > 0)
            )
            .then(
                (pl.col("avg_exit_price") * exit_mult)
                / (pl.col("avg_entry_price") * entry_mult)
                - 1
                - fee
            )
            .otherwise(pl.col("roi") - cost)
        )
    else:
        follower_roi = pl.col("roi") - cost

    return positions.with_columns(follower_roi=follower_roi)


def backtest(
    positions: pl.DataFrame,
    *,
    frictions: Frictions | None = None,
    stake_fraction: float = 0.02,
    n_trials_searched: int = 1,
) -> BacktestResult:
    """Simulate following a selected set of positions.

    ``stake_fraction`` is fixed-fractional sizing: each position risks that
    share of current equity. Fixed-fractional rather than fixed-notional
    because it compounds the way a real account does and, unlike flat sizing,
    cannot be rescued by one enormous late winner.
    """
    frictions = frictions or Frictions()
    notes: list[str] = []

    if positions.is_empty():
        return _empty_result(frictions, ["No positions selected."])

    ordered = positions.sort("opened_at")
    before = ordered.height

    # Drop positions a follower could not have entered in time.
    if "hold_seconds" in ordered.columns:
        ordered = ordered.filter(
            pl.col("hold_seconds").is_null()
            | (pl.col("hold_seconds") >= frictions.min_hold_seconds)
        )
    skipped = before - ordered.height
    if skipped:
        notes.append(
            f"{skipped} position(s) held under {frictions.min_hold_seconds:.0f}s "
            "were dropped as un-copyable."
        )

    ordered = apply_frictions(ordered, frictions).filter(
        pl.col("follower_roi").is_not_null()
    )
    if ordered.is_empty():
        return _empty_result(frictions, notes + ["No positions survived filtering."])

    rois = ordered["follower_roi"].to_numpy()

    # Fixed-fractional compounding in chronological order.
    equity = 1.0
    curve: list[float] = []
    for roi in rois:
        equity *= 1 + stake_fraction * float(roi)
        curve.append(equity)
    equity_array = np.asarray(curve)

    running_max = np.maximum.accumulate(equity_array)
    drawdowns = (equity_array - running_max) / running_max
    max_dd = float(drawdowns.min()) if drawdowns.size else 0.0

    # Per-position Sharpe. Not annualized: positions do not arrive on a regular
    # calendar, so any annualization factor here would be invented.
    sharpe = (
        float(np.mean(rois) / np.std(rois))
        if rois.size > 1 and np.std(rois) > 0
        else None
    )

    return BacktestResult(
        n_positions=int(rois.size),
        n_skipped=skipped,
        win_rate=float(np.mean(rois > 0)),
        mean_roi=float(np.mean(rois)),
        median_roi=float(np.median(rois)),
        roi_ci=bootstrap_ci(rois),
        total_return=float(equity_array[-1] - 1.0),
        sharpe=sharpe,
        deflated_sharpe=(
            deflated_sharpe(sharpe, n_trials_searched, int(rois.size))
            if sharpe is not None
            else None
        ),
        max_drawdown=max_dd,
        equity_curve=ordered.select("opened_at", "follower_roi").with_columns(
            equity=pl.Series("equity", equity_array)
        ),
        frictions=frictions,
        notes=notes,
    )


def null_baseline(
    all_positions: pl.DataFrame,
    n_selected: int,
    *,
    frictions: Frictions | None = None,
    n_samples: int = 1_000,
    seed: int = 0,
) -> dict[str, float]:
    """What would picking that many positions *at random* have returned?

    This is the comparison that matters. A strategy returning 40% means nothing
    if throwing darts at the same position set returns 38% — the edge is the
    roster, not the pattern.
    """
    frictions = frictions or Frictions()
    pool = apply_frictions(all_positions, frictions).filter(
        pl.col("follower_roi").is_not_null()
    )
    empty = {
        "mean_roi": float("nan"),
        "std": float("nan"),
        "p95": float("nan"),
        "n_samples": 0,
        "pool_size": 0,
    }
    if pool.is_empty() or n_selected <= 0:
        return empty

    rois = pool["follower_roi"].to_numpy()
    take = min(n_selected, rois.size)
    rng = np.random.default_rng(seed)

    draws = np.array(
        [rng.choice(rois, size=take, replace=False).mean() for _ in range(n_samples)]
    )
    return {
        "mean_roi": float(draws.mean()),
        "std": float(draws.std()),
        "p95": float(np.quantile(draws, 0.95)),
        "n_samples": n_samples,
        "pool_size": int(rois.size),
    }


def significance_vs_null(
    result: BacktestResult, null: dict[str, float]
) -> dict[str, float | bool]:
    """Compare a backtest against its random-selection baseline."""
    if not np.isfinite(null.get("mean_roi", float("nan"))):
        return {"beats_null": False, "z_score": float("nan"), "edge": float("nan")}
    std = null.get("std", 0.0) or 0.0
    edge = result.mean_roi - null["mean_roi"]
    z = edge / std if std > 0 else (float("inf") if edge > 0 else 0.0)
    return {
        "beats_null": bool(result.mean_roi > null.get("p95", float("inf"))),
        "z_score": float(z),
        "edge": float(edge),
    }


def _empty_result(frictions: Frictions, notes: list[str]) -> BacktestResult:
    return BacktestResult(
        n_positions=0,
        n_skipped=0,
        win_rate=0.0,
        mean_roi=0.0,
        median_roi=0.0,
        roi_ci=(float("nan"), float("nan")),
        total_return=0.0,
        sharpe=None,
        deflated_sharpe=None,
        max_drawdown=0.0,
        equity_curve=pl.DataFrame(
            schema={
                "opened_at": pl.Datetime("us", "UTC"),
                "follower_roi": pl.Float64,
                "equity": pl.Float64,
            }
        ),
        frictions=frictions,
        notes=notes,
    )
