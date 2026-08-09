"""Choice-set schema, relevance grades, and the screening contract.

The tables here are *group-structured*: rows belong to a ``group_id``, one
group per KOL decision, and a model consumes whole groups rather than
independent rows. Getting that structure wrong — splitting a group across a
train/test boundary, say — leaks the answer, because the other candidates in a
group tell you a great deal about which one was chosen.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
from typing import Protocol

import polars as pl

# ---------------------------------------------------------------------------
# Relevance grades
# ---------------------------------------------------------------------------
# Graded rather than binary. A token the KOL bought 40 minutes later was not a
# negative — it was attractive, just not *first*. Labelling it 0 teaches the
# model the opposite of the truth, and NDCG consumes grades natively, so there
# is no reason to throw the distinction away.
REL_CHOSEN = 2   # bought at t: chosen over everything else on screen
REL_LATER = 1    # bought within the lookahead window: liked, but not first
REL_IGNORED = 0  # never bought: a genuine rejection

# How far ahead to look when assigning REL_LATER. Beyond this the connection to
# the decision at t is too weak to be evidence of anything.
DEFAULT_LATER_WINDOW = timedelta(hours=24)

# Candidates traded inside this window around t are treated as simultaneous —
# a KOL clicking three tokens in ninety seconds made one decision, not three,
# so the others must not be scored as rejections.
DEFAULT_SIMULTANEITY_WINDOW = timedelta(minutes=5)


# ---------------------------------------------------------------------------
# Tables
# ---------------------------------------------------------------------------

# One row per (decision, candidate). This is the model's training matrix.
CANDIDATE_SCHEMA: dict[str, pl.DataType] = {
    # grouping — a model must never see rows from one group split across folds
    "group_id": pl.Utf8,
    "chain": pl.Utf8,
    "kol_address": pl.Utf8,
    "decided_at": pl.Datetime(time_unit="us", time_zone="UTC"),
    # the candidate
    "market_id": pl.Utf8,
    "market_label": pl.Utf8,
    "outcome": pl.Utf8,
    # label
    "relevance": pl.Int32,
    "chosen": pl.Boolean,
    # provenance of the alternatives: how U_t was produced, so a model trained
    # on a reconstructed universe is never silently mixed with a live one
    "snapshot_source": pl.Utf8,   # "live" | "reconstructed" | "synthetic"
    "snapshot_at": pl.Datetime(time_unit="us", time_zone="UTC"),
    # --- point-in-time features, all strictly as-of `decided_at` ------------
    "age_seconds": pl.Float64,
    "price": pl.Float64,
    "liquidity_usd": pl.Float64,
    "volume_5m_usd": pl.Float64,
    "volume_1h_usd": pl.Float64,
    "volume_24h_usd": pl.Float64,
    "trades_5m": pl.Float64,
    "unique_buyers_5m": pl.Float64,
    "buy_sell_ratio_5m": pl.Float64,
    "price_change_5m": pl.Float64,
    "price_change_1h": pl.Float64,
    "holder_count": pl.Float64,
    "top10_holder_pct": pl.Float64,
    "spread_pct": pl.Float64,
    # roster-relative: how many tracked KOLs were already in, before t
    "prior_kol_entries": pl.Float64,
    "seconds_since_first_kol_entry": pl.Float64,
}

# One row per decision. Metadata about the group as a whole.
CHOICE_SET_SCHEMA: dict[str, pl.DataType] = {
    "group_id": pl.Utf8,
    "chain": pl.Utf8,
    "kol_address": pl.Utf8,
    "kol_handle": pl.Utf8,
    "decided_at": pl.Datetime(time_unit="us", time_zone="UTC"),
    "chosen_market_id": pl.Utf8,
    "n_candidates": pl.Int32,
    "n_positive": pl.Int32,
    "screen_name": pl.Utf8,
    "snapshot_source": pl.Utf8,
    # False when the chosen asset failed the screen and had to be re-inserted.
    # These groups are the screen telling you it does not describe this trader.
    "chosen_passed_screen": pl.Boolean,
}

# Columns a ranker may learn from. Everything else is an identifier, a label,
# or provenance. Keeping this explicit is what stops `relevance` or `chosen`
# from being handed to the model by an careless `select`.
FEATURE_COLUMNS: tuple[str, ...] = (
    "age_seconds",
    "price",
    "liquidity_usd",
    "volume_5m_usd",
    "volume_1h_usd",
    "volume_24h_usd",
    "trades_5m",
    "unique_buyers_5m",
    "buy_sell_ratio_5m",
    "price_change_5m",
    "price_change_1h",
    "holder_count",
    "top10_holder_pct",
    "spread_pct",
    "prior_kol_entries",
    "seconds_since_first_kol_entry",
)

LABEL_COLUMNS: tuple[str, ...] = ("relevance", "chosen")


# ---------------------------------------------------------------------------
# Screens
# ---------------------------------------------------------------------------


class Screen(Protocol):
    """What the trader could plausibly have been looking at.

    A screen is the modelling assumption made explicit. It should approximate
    the tool the KOL actually uses — a DexScreener filter, a Pump.fun board —
    because the negatives it admits are what the model learns to reject.
    """

    name: str
    max_candidates: int

    def passes(self, candidate: dict) -> bool:
        """Whether one candidate belongs in U_t."""
        ...

    def rank_key(self, candidate: dict) -> float:
        """Attention ordering. The top ``max_candidates`` are kept.

        Screens surface far more than a human reads. This is the proxy for
        which ones actually got looked at — usually recent volume, since that
        is what trending boards sort by.
        """
        ...


@dataclass(frozen=True)
class SolanaScreen:
    """Approximates a memecoin trending board.

    Defaults follow the shape of a typical DexScreener/Pump.fun filter: young,
    liquid enough to trade, and showing real recent volume. They are a starting
    point to be tuned against ``screen_coverage``, not received wisdom.
    """

    name: str = "solana-trending"
    max_age_seconds: float = 12 * 3600
    min_volume_5m_usd: float = 10_000.0
    min_liquidity_usd: float = 5_000.0
    max_candidates: int = 20

    def passes(self, candidate: dict) -> bool:
        age = candidate.get("age_seconds")
        volume = candidate.get("volume_5m_usd")
        liquidity = candidate.get("liquidity_usd")
        # A missing value is not a pass. Admitting unknowns would fill U_t with
        # candidates whose features are all null, and the model would learn to
        # rank on missingness — which does not exist at serve time.
        if age is None or volume is None or liquidity is None:
            return False
        return (
            age <= self.max_age_seconds
            and volume >= self.min_volume_5m_usd
            and liquidity >= self.min_liquidity_usd
        )

    def rank_key(self, candidate: dict) -> float:
        return float(candidate.get("volume_5m_usd") or 0.0)


@dataclass(frozen=True)
class PolymarketScreen:
    """Approximates the active-markets board.

    Far more tractable than Solana: the live universe is hundreds of markets,
    not a hundred thousand, so U_t is close to genuinely enumerable rather than
    approximated.
    """

    name: str = "polymarket-active"
    min_volume_24h_usd: float = 50_000.0
    max_spread_pct: float = 3.0
    max_candidates: int = 20
    # When set, only markets sharing the chosen market's category compete. A
    # politics specialist was not choosing between an election and a football
    # game, and pretending otherwise adds noise, not signal.
    same_category_only: bool = True

    def passes(self, candidate: dict) -> bool:
        volume = candidate.get("volume_24h_usd")
        spread = candidate.get("spread_pct")
        if volume is None or spread is None:
            return False
        return volume >= self.min_volume_24h_usd and spread <= self.max_spread_pct

    def rank_key(self, candidate: dict) -> float:
        return float(candidate.get("volume_24h_usd") or 0.0)


# ---------------------------------------------------------------------------
# The diagnostic that decides whether any of this is valid
# ---------------------------------------------------------------------------


def screen_coverage(
    choice_sets: pl.DataFrame, *, by_kol: bool = True
) -> pl.DataFrame:
    """What fraction of real KOL buys the screen would have surfaced.

    **Read this before reading any NDCG number.** If a KOL's buys mostly fail
    the screen, the negatives are drawn from a universe they never looked at,
    and the model is learning to discriminate within the wrong set. No amount
    of tuning fixes that; the screen has to change, or that KOL has to be
    excluded as sourcing from somewhere unobservable (a private group, a
    launch they were told about directly).

    Rough reading: above ~0.7 the screen describes the trader well; below ~0.4
    it does not describe them at all.
    """
    if choice_sets.is_empty():
        return pl.DataFrame(
            schema={
                "kol_address": pl.Utf8,
                "decisions": pl.Int32,
                "passed": pl.Int32,
                "coverage": pl.Float64,
            }
        )

    keys = ["kol_address"] if by_kol else []
    grouped = (
        choice_sets.group_by(keys) if keys else choice_sets.group_by(pl.lit(1).alias("_all"))
    )
    out = grouped.agg(
        decisions=pl.len().cast(pl.Int32),
        passed=pl.col("chosen_passed_screen").sum().cast(pl.Int32),
        median_candidates=pl.col("n_candidates").median(),
    ).with_columns(coverage=pl.col("passed") / pl.col("decisions"))

    if not keys:
        out = out.drop("_all")
    return out.sort("coverage")
