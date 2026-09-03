"""Assemble choice sets: one KOL decision, its alternatives, graded labels.

This is where lookahead bias gets in if it gets in anywhere, so the ordering
of operations matters and is stated explicitly:

1. Take a KOL buy at ``t``. That asset is the positive.
2. Ask the provider for the universe **as of** ``t``. Never later.
3. Apply the screen; keep the top ``max_candidates`` by attention order.
4. Label: chosen = 2, bought-within-24h = 1, everything else = 0.
5. Drop candidates the KOL also traded inside ±5 minutes — those were part of
   the same decision, not rejections of it.
6. If the chosen asset failed the screen, re-insert it and flag the group. A
   group with no positive teaches nothing, and the flag is what
   ``screen_coverage`` counts.

Step 5 is subtle and worth stating plainly: a KOL who buys three tokens in
ninety seconds made one decision about three assets. Scoring two of them as
rejections of the third would teach the model to reject exactly the things this
trader likes.
"""

from __future__ import annotations

import hashlib
from collections.abc import Mapping
from datetime import datetime, timedelta

import polars as pl

from ..schema import SIDE_BUY
from .schema import (
    CANDIDATE_SCHEMA,
    CHOICE_SET_SCHEMA,
    DEFAULT_LATER_WINDOW,
    DEFAULT_SIMULTANEITY_WINDOW,
    REL_CHOSEN,
    REL_IGNORED,
    REL_LATER,
    Screen,
)
from .snapshot import MarketSnapshotProvider

# A group with too few alternatives teaches nothing — ranking one item against
# zero others is not a ranking problem.
MIN_CANDIDATES = 3

# A screen per venue, or one screen for everything. The per-venue form exists
# because a launchpad board and an AMM trending list are ranked by different
# things, and forcing one screen across both would describe neither.
ScreenSpec = Screen | Mapping[str, Screen]


def _screen_for(spec: ScreenSpec, venue: str | None) -> Screen | None:
    """Resolve the screen governing one decision.

    A mapping without a match returns ``None``, which drops the decision. That
    is intentional: assembling a launchpad buy against an AMM screen would
    manufacture alternatives the trader never saw, and a silently mis-screened
    group is worse than a missing one.
    """
    if not isinstance(spec, Mapping):
        return spec
    if venue and venue in spec:
        return spec[venue]
    from ..venues import venue_kind

    kind = venue_kind(venue) if venue else None
    if kind and kind in spec:
        return spec[kind]
    return spec.get("*")


def _group_id(kol_address: str, market_id: str, at: datetime) -> str:
    payload = f"{kol_address}|{market_id}|{at.isoformat()}"
    return hashlib.sha256(payload.encode()).hexdigest()[:24]


def kol_entries(trades: pl.DataFrame, *, chain: str) -> pl.DataFrame:
    """The buys that count as decisions.

    Only *opening* buys: a scale-in on a position already held is not a fresh
    choice among alternatives, it is a follow-through on one already made.
    First-buy-per-(kol, market) approximates that without needing the position
    table, and errs toward fewer, cleaner decisions.
    """
    if trades.is_empty():
        return trades

    buys = trades.filter((pl.col("chain") == chain) & (pl.col("side") == SIDE_BUY))
    if buys.is_empty():
        return buys

    return (
        buys.sort("ts")
        .group_by(["kol_address", "market_id"], maintain_order=True)
        .first()
        .sort("ts")
    )


def _traded_within(
    trades: pl.DataFrame, kol_address: str, at: datetime, window: timedelta
) -> set[str]:
    """Markets this KOL traded inside ±window of ``at``."""
    if trades.is_empty():
        return set()
    lower, upper = at - window, at + window
    rows = trades.filter(
        (pl.col("kol_address") == kol_address)
        & (pl.col("ts") >= lower)
        & (pl.col("ts") <= upper)
    )
    return set(rows["market_id"].to_list())


def _bought_later(
    trades: pl.DataFrame, kol_address: str, at: datetime, window: timedelta
) -> set[str]:
    """Markets this KOL bought strictly after ``at``, within ``window``."""
    if trades.is_empty():
        return set()
    rows = trades.filter(
        (pl.col("kol_address") == kol_address)
        & (pl.col("side") == SIDE_BUY)
        & (pl.col("ts") > at)
        & (pl.col("ts") <= at + window)
    )
    return set(rows["market_id"].to_list())


def _prior_kol_context(
    trades: pl.DataFrame, market_id: str, at: datetime
) -> tuple[float, float | None]:
    """How much tracked-KOL interest this asset had accumulated *before* ``at``.

    Strictly ``< at``: a trade at exactly ``at`` is simultaneous, not prior, and
    including it would let the model see the very decision it is predicting.

    Note this feature cuts against early entry — it is strongest precisely when
    you are latest. Kept because measuring that tradeoff is more useful than
    assuming it, but a model that ranks well *only* with these two columns has
    learned to follow, not to anticipate.
    """
    if trades.is_empty():
        return 0.0, None
    prior = trades.filter(
        (pl.col("market_id") == market_id)
        & (pl.col("side") == SIDE_BUY)
        & (pl.col("ts") < at)
    )
    if prior.is_empty():
        return 0.0, None
    first = prior.select(pl.col("ts").min()).item()
    return float(prior.height), float((at - first).total_seconds())


def build_choice_sets(
    trades: pl.DataFrame,
    provider: MarketSnapshotProvider,
    screen: ScreenSpec,
    *,
    chain: str,
    later_window: timedelta = DEFAULT_LATER_WINDOW,
    simultaneity_window: timedelta = DEFAULT_SIMULTANEITY_WINDOW,
    min_candidates: int = MIN_CANDIDATES,
    max_decisions: int | None = None,
) -> tuple[pl.DataFrame, pl.DataFrame]:
    """Turn KOL buys into ranked training groups.

    ``screen`` is either one ``Screen`` or a mapping keyed by venue name or
    venue kind (``"bonding-curve"``, ``"amm"``), with ``"*"`` as the fallback.

    Returns ``(candidates, choice_sets)`` — the per-candidate training matrix
    and one metadata row per decision.
    """
    entries = kol_entries(trades, chain=chain)
    if entries.is_empty():
        return (
            pl.DataFrame(schema=CANDIDATE_SCHEMA),
            pl.DataFrame(schema=CHOICE_SET_SCHEMA),
        )

    if max_decisions:
        entries = entries.head(max_decisions)

    candidate_rows: list[dict] = []
    group_rows: list[dict] = []

    for entry in entries.iter_rows(named=True):
        kol = entry["kol_address"]
        chosen_id = entry["market_id"]
        at = entry["ts"]
        # The venue the KOL actually traded on decides which board gets
        # reconstructed. On Solana this is the whole question; on Polymarket
        # there is one order book and the provider ignores it.
        venue = entry.get("venue")

        active_screen = _screen_for(screen, venue)
        if active_screen is None:
            continue

        universe = provider.candidates_at(at, venue=venue)
        if not universe:
            continue

        # Category gating, when the screen asks for it. A politics specialist
        # was not choosing between an election and a football game, so markets
        # from unrelated categories are phantom alternatives. Enforced here
        # rather than in `Screen.passes`, which sees one candidate at a time and
        # cannot know the chosen market's category.
        if getattr(active_screen, "same_category_only", False):
            chosen_row = next(
                (c for c in universe if c.get("market_id") == chosen_id), None
            )
            chosen_category = chosen_row.get("category") if chosen_row else None
            if chosen_category:
                universe = [
                    c
                    for c in universe
                    if c.get("category") == chosen_category
                    or c.get("market_id") == chosen_id
                ]

        # Screen, then take the top slice by attention order.
        passing = [c for c in universe if active_screen.passes(c)]
        passing.sort(key=active_screen.rank_key, reverse=True)
        passing = passing[: active_screen.max_candidates]

        chosen_passed = any(c.get("market_id") == chosen_id for c in passing)
        if not chosen_passed:
            # The chosen asset was invisible to our screen. Re-insert it so the
            # group has a positive, and flag it — a KOL with many such groups is
            # telling you the screen does not describe how they find trades.
            features = provider.features_at(chosen_id, at, venue=venue)
            if features is None:
                continue
            features["market_id"] = chosen_id
            passing.append(features)

        # Simultaneous trades are part of this decision, not rejections of it.
        simultaneous = _traded_within(trades, kol, at, simultaneity_window)
        later = _bought_later(trades, kol, at, later_window)

        kept: list[dict] = []
        for candidate in passing:
            market_id = candidate.get("market_id")
            if not market_id:
                continue
            if market_id != chosen_id and market_id in simultaneous:
                continue
            kept.append(candidate)

        if len(kept) < min_candidates:
            continue

        group_id = _group_id(kol, chosen_id, at)
        n_positive = 0

        for candidate in kept:
            market_id = candidate["market_id"]
            if market_id == chosen_id:
                relevance = REL_CHOSEN
                n_positive += 1
            elif market_id in later:
                relevance = REL_LATER
            else:
                relevance = REL_IGNORED

            prior_entries, since_first = _prior_kol_context(trades, market_id, at)

            row = {
                "group_id": group_id,
                "chain": chain,
                "kol_address": kol,
                "decided_at": at,
                "market_id": market_id,
                "market_label": candidate.get("market_label"),
                "outcome": candidate.get("outcome"),
                "venue": venue,
                "category": candidate.get("category"),
                "relevance": relevance,
                "chosen": market_id == chosen_id,
                "snapshot_source": candidate.get("snapshot_source", provider.source),
                "snapshot_at": candidate.get("snapshot_at", at),
                "prior_kol_entries": prior_entries,
                "seconds_since_first_kol_entry": since_first,
            }
            # Copy only declared feature columns — an unexpected key from a
            # provider must never silently become a model input.
            for column in CANDIDATE_SCHEMA:
                if column not in row and column in candidate:
                    row[column] = candidate[column]
            candidate_rows.append(row)

        group_rows.append(
            {
                "group_id": group_id,
                "chain": chain,
                "kol_address": kol,
                "kol_handle": entry.get("kol_handle"),
                "decided_at": at,
                "chosen_market_id": chosen_id,
                "venue": venue,
                "n_candidates": len(kept),
                "n_positive": n_positive,
                "screen_name": active_screen.name,
                "snapshot_source": provider.source,
                "chosen_passed_screen": chosen_passed,
            }
        )

    if not candidate_rows:
        return (
            pl.DataFrame(schema=CANDIDATE_SCHEMA),
            pl.DataFrame(schema=CHOICE_SET_SCHEMA),
        )

    from ..schema import conform

    return (
        conform(pl.DataFrame(candidate_rows, infer_schema_length=None, strict=False),
                CANDIDATE_SCHEMA),
        conform(pl.DataFrame(group_rows, infer_schema_length=None, strict=False),
                CHOICE_SET_SCHEMA),
    )
