"""Ranker tests: group integrity, baselines, and metric honesty.

Two failure modes are covered here.

**Group splitting.** If a choice set is divided across a train/test boundary,
the model has already seen the alternatives it is being asked to rank against.
NDCG goes up, the model is worthless, and nothing warns you.

**Unreadable metrics.** NDCG has no natural zero — with 8 candidates, random
ordering already scores ~0.6. The margin over the naive baselines is the only
interpretable quantity, so the baselines have to be right.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import numpy as np
import polars as pl
import pytest

from pattern_ml.choice.rank import (
    _evaluate,
    _group_sizes,
    _hit_at_1,
    _ndcg,
    _reciprocal_rank,
    _split_groups,
)
from pattern_ml.choice.schema import REL_CHOSEN, REL_IGNORED, REL_LATER

BASE = datetime(2026, 3, 1, tzinfo=timezone.utc)


def choice_frame(n_groups: int = 10, per_group: int = 5) -> pl.DataFrame:
    """Synthetic groups where the chosen candidate has the highest volume.

    A learnable signal by construction, so a ranker that cannot beat random on
    this is broken rather than merely uninformed.
    """
    rows = []
    for g in range(n_groups):
        for c in range(per_group):
            chosen = c == 0
            rows.append(
                {
                    "group_id": f"g{g}",
                    "decided_at": BASE + timedelta(hours=g),
                    "market_id": f"m{g}_{c}",
                    "relevance": REL_CHOSEN if chosen else REL_IGNORED,
                    "chosen": chosen,
                    "volume_5m_usd": 100_000.0 if chosen else 10_000.0,
                    "liquidity_usd": 50_000.0,
                    "age_seconds": 3600.0,
                }
            )
    return pl.DataFrame(rows)


class TestMetrics:
    def test_hit_at_1_rewards_the_correct_top_pick(self) -> None:
        scores = np.array([0.9, 0.1, 0.2])
        relevance = np.array([REL_CHOSEN, REL_IGNORED, REL_IGNORED], dtype=float)
        assert _hit_at_1(scores, relevance) == 1.0

    def test_hit_at_1_penalises_a_wrong_top_pick(self) -> None:
        scores = np.array([0.1, 0.9, 0.2])
        relevance = np.array([REL_CHOSEN, REL_IGNORED, REL_IGNORED], dtype=float)
        assert _hit_at_1(scores, relevance) == 0.0

    def test_reciprocal_rank_decays_with_position(self) -> None:
        relevance = np.array([REL_CHOSEN, REL_IGNORED, REL_IGNORED], dtype=float)
        assert _reciprocal_rank(np.array([0.9, 0.5, 0.1]), relevance) == 1.0
        assert _reciprocal_rank(np.array([0.5, 0.9, 0.1]), relevance) == pytest.approx(0.5)
        assert _reciprocal_rank(np.array([0.1, 0.9, 0.5]), relevance) == pytest.approx(1 / 3)

    def test_perfect_ranking_scores_ndcg_one(self) -> None:
        relevance = np.array([REL_CHOSEN, REL_LATER, REL_IGNORED], dtype=float)
        assert _ndcg(np.array([3.0, 2.0, 1.0]), relevance) == pytest.approx(1.0)

    def test_inverted_ranking_scores_below_perfect(self) -> None:
        relevance = np.array([REL_CHOSEN, REL_LATER, REL_IGNORED], dtype=float)
        assert _ndcg(np.array([1.0, 2.0, 3.0]), relevance) < 1.0

    def test_graded_relevance_rewards_ranking_later_above_ignored(self) -> None:
        """The point of graded labels: partial credit for near-misses."""
        relevance = np.array([REL_CHOSEN, REL_LATER, REL_IGNORED], dtype=float)
        good = _ndcg(np.array([0.1, 0.9, 0.5]), relevance)   # later ranked 1st
        bad = _ndcg(np.array([0.1, 0.5, 0.9]), relevance)    # ignored ranked 1st
        assert good > bad

    def test_groups_without_a_positive_are_skipped(self) -> None:
        frame = pl.DataFrame(
            {
                "group_id": ["g0", "g0"],
                "relevance": [REL_IGNORED, REL_IGNORED],
            }
        )
        ndcg, hit, mrr = _evaluate(frame, np.array([0.9, 0.1]))
        assert (ndcg, hit, mrr) == (0.0, 0.0, 0.0)


class TestGroupIntegrity:
    def test_group_sizes_match_the_frame_order(self) -> None:
        frame = choice_frame(n_groups=3, per_group=4)
        assert _group_sizes(frame) == [4, 4, 4]
        assert sum(_group_sizes(frame)) == frame.height

    def test_group_sizes_handle_uneven_groups(self) -> None:
        frame = pl.concat(
            [
                choice_frame(n_groups=1, per_group=3),
                choice_frame(n_groups=1, per_group=5).with_columns(
                    group_id=pl.lit("other")
                ),
            ]
        )
        assert sum(_group_sizes(frame)) == frame.height

    def test_splits_never_share_a_group(self) -> None:
        """The decisive structural test: no group in both train and test."""
        groups = [f"g{i}" for i in range(20)]
        for train, test in _split_groups(groups, n_splits=4):
            assert not set(train) & set(test)

    def test_train_always_precedes_test_in_time(self) -> None:
        """Never a random split — a model must not train on the future."""
        groups = [f"g{i:02d}" for i in range(20)]
        for train, test in _split_groups(groups, n_splits=4):
            assert max(groups.index(g) for g in train) < min(
                groups.index(g) for g in test
            )

    def test_too_few_groups_yields_no_folds(self) -> None:
        assert _split_groups(["g0", "g1"], n_splits=5) == []


class TestBaselines:
    def test_volume_baseline_finds_a_volume_driven_choice(self) -> None:
        """Sanity check on the baseline itself.

        If the chosen candidate always has the highest volume, rank-by-volume
        must score 1.0 — and a model that cannot beat it has added nothing.
        """
        from pattern_ml.choice.rank import _baseline_scores

        frame = choice_frame(n_groups=5, per_group=4)
        _, hit, _ = _evaluate(frame, _baseline_scores(frame, "volume", seed=0))
        assert hit == pytest.approx(1.0)

    def test_random_baseline_is_near_chance(self) -> None:
        from pattern_ml.choice.rank import _baseline_scores

        frame = choice_frame(n_groups=200, per_group=5)
        _, hit, _ = _evaluate(frame, _baseline_scores(frame, "random", seed=0))
        # 1-in-5 chance per group, with sampling slack.
        assert 0.1 < hit < 0.32

    def test_unknown_baseline_is_rejected(self) -> None:
        from pattern_ml.choice.rank import _baseline_scores

        with pytest.raises(ValueError, match="Unknown baseline"):
            _baseline_scores(choice_frame(), "psychic", seed=0)
