"""Learning to rank: which candidate does this KOL pick?

``LGBMRanker`` with ``lambdarank``, which optimizes NDCG directly and consumes
the graded relevance labels natively. LightGBM rather than XGBoost only because
it is already a dependency here; the formulation is identical.

Two things make this evaluation trustworthy rather than decorative.

**Groups never split across a fold.** A choice set is one decision. Put some of
its candidates in train and the rest in test and the model has seen the
alternatives it is being asked to rank against — the single easiest way to
manufacture a spectacular NDCG that means nothing. Splits are therefore by
*group*, in time order.

**Two baselines are mandatory.** NDCG in isolation is unreadable: with 8
candidates per group, random ranking already scores ~0.6 by construction. The
numbers that matter are the margins over (a) random and (b) ranking by raw
volume. A model that cannot beat "pick the highest-volume candidate" has
learned nothing, however good its absolute score looks — that is the
learning-to-rank analogue of the random-pick null in the backtest.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import polars as pl

from .schema import FEATURE_COLUMNS, REL_CHOSEN

try:
    from lightgbm import LGBMRanker

    _HAS_LGBM = True
except ImportError:  # pragma: no cover - depends on install
    _HAS_LGBM = False


@dataclass
class FoldMetrics:
    fold: int
    train_groups: int
    test_groups: int
    ndcg_at_5: float
    hit_at_1: float
    mrr: float
    # Baselines on the identical test groups.
    random_hit_at_1: float
    volume_hit_at_1: float
    random_mrr: float
    volume_mrr: float

    @property
    def lift_over_random(self) -> float:
        return self.hit_at_1 - self.random_hit_at_1

    @property
    def lift_over_volume(self) -> float:
        return self.hit_at_1 - self.volume_hit_at_1


@dataclass
class RankerResult:
    model: object
    features_used: list[str]
    folds: list[FoldMetrics]
    importance: pl.DataFrame
    n_groups: int
    mean_candidates: float
    notes: list[str] = field(default_factory=list)

    @property
    def mean_hit_at_1(self) -> float:
        return float(np.mean([f.hit_at_1 for f in self.folds])) if self.folds else 0.0

    @property
    def mean_lift_over_volume(self) -> float:
        return (
            float(np.mean([f.lift_over_volume for f in self.folds]))
            if self.folds
            else 0.0
        )

    @property
    def beats_baselines(self) -> bool:
        """The only verdict worth reading.

        Absolute NDCG says little; beating *both* naive orderings on every fold
        is what distinguishes a model from an expensive sort.
        """
        return bool(
            self.folds
            and all(f.lift_over_random > 0 for f in self.folds)
            and all(f.lift_over_volume > 0 for f in self.folds)
        )


def _hit_at_1(scores: np.ndarray, relevance: np.ndarray) -> float:
    """Did the top-scored candidate turn out to be the chosen one?

    The most operationally honest metric here: if you act on one pick per
    decision, this is how often you were right.
    """
    return float(relevance[int(np.argmax(scores))] == REL_CHOSEN)


def _reciprocal_rank(scores: np.ndarray, relevance: np.ndarray) -> float:
    order = np.argsort(-scores)
    ranked = relevance[order]
    hits = np.where(ranked == REL_CHOSEN)[0]
    return float(1.0 / (hits[0] + 1)) if hits.size else 0.0


def _ndcg(scores: np.ndarray, relevance: np.ndarray, k: int = 5) -> float:
    order = np.argsort(-scores)[:k]
    gains = (2.0 ** relevance[order] - 1) / np.log2(np.arange(2, order.size + 2))
    ideal_order = np.argsort(-relevance)[:k]
    ideal = (2.0 ** relevance[ideal_order] - 1) / np.log2(
        np.arange(2, ideal_order.size + 2)
    )
    denominator = ideal.sum()
    return float(gains.sum() / denominator) if denominator > 0 else 0.0


def _evaluate(
    frame: pl.DataFrame, scores: np.ndarray, k: int = 5
) -> tuple[float, float, float]:
    """Average NDCG@k, hit@1 and MRR across the groups in ``frame``."""
    working = frame.with_columns(_score=pl.Series("_score", scores))
    ndcgs, hits, rrs = [], [], []
    for _, group in working.group_by("group_id", maintain_order=True):
        relevance = group["relevance"].to_numpy().astype(float)
        group_scores = group["_score"].to_numpy()
        if relevance.max() < REL_CHOSEN:
            continue  # no positive to find
        ndcgs.append(_ndcg(group_scores, relevance, k))
        hits.append(_hit_at_1(group_scores, relevance))
        rrs.append(_reciprocal_rank(group_scores, relevance))
    if not hits:
        return 0.0, 0.0, 0.0
    return float(np.mean(ndcgs)), float(np.mean(hits)), float(np.mean(rrs))


def _baseline_scores(frame: pl.DataFrame, kind: str, seed: int) -> np.ndarray:
    if kind == "random":
        return np.random.default_rng(seed).random(frame.height)
    if kind == "volume":
        # Rank by the screen's own attention key — the coarsest sensible
        # heuristic, and the thing a human scanning the board actually does.
        #
        # `curve_completion` is in the list because on a launchpad every volume
        # column is null: the curve-state query returns progress, not dollars.
        # Falling through to zeros there would make the baseline a constant,
        # beatable by any ordering at all, and `beats_baselines` would read as
        # a pass on a model that had learned nothing.
        for column in (
            "volume_5m_usd",
            "volume_24h_usd",
            "volume_1h_usd",
            "curve_completion",
        ):
            if column in frame.columns and frame[column].null_count() < frame.height:
                return np.nan_to_num(frame[column].to_numpy().astype(float), nan=-1.0)
        return np.zeros(frame.height)
    raise ValueError(f"Unknown baseline: {kind}")


def _usable_features(frame: pl.DataFrame) -> list[str]:
    """Declared features that are present and not entirely null."""
    present = [c for c in FEATURE_COLUMNS if c in frame.columns]
    return [c for c in present if frame[c].null_count() < frame.height]


def _split_groups(group_order: list[str], n_splits: int) -> list[tuple[list[str], list[str]]]:
    """Expanding-window splits over groups in time order.

    Train always precedes test. Never a random split: these decisions are
    ordered in time and a model trained on August must not be tested on July.
    """
    total = len(group_order)
    folds: list[tuple[list[str], list[str]]] = []
    step = total // (n_splits + 1)
    if step < 1:
        return folds
    for i in range(1, n_splits + 1):
        cut = step * i
        train, test = group_order[:cut], group_order[cut : cut + step]
        if train and test:
            folds.append((train, test))
    return folds


def train_ranker(
    candidates: pl.DataFrame,
    *,
    n_splits: int = 4,
    seed: int = 0,
    min_groups: int = 200,
) -> RankerResult:
    """Fit and time-validate a candidate ranker."""
    if not _HAS_LGBM:  # pragma: no cover
        raise ImportError("lightgbm is required for ranking; pip install lightgbm")
    if candidates.is_empty():
        raise ValueError("No choice sets. Build them with `pattern-ml choice-sets`.")

    features = _usable_features(candidates)
    if not features:
        raise ValueError(
            "No usable feature columns — every candidate feature was all-null. "
            "The snapshot provider is not filling them."
        )

    notes: list[str] = []
    # Chronological, and grouped: every row of a group stays together.
    frame = candidates.sort(["decided_at", "group_id"])
    group_order = frame.select("group_id").unique(maintain_order=True)["group_id"].to_list()

    if len(group_order) < min_groups:
        notes.append(
            f"Only {len(group_order)} choice sets — below the {min_groups} needed "
            "for a trustworthy ranking. Treat these numbers as directional."
        )

    dropped = [c for c in FEATURE_COLUMNS if c not in features]
    if dropped:
        notes.append(f"Unavailable features dropped: {', '.join(dropped)}")

    folds: list[FoldMetrics] = []
    for index, (train_ids, test_ids) in enumerate(_split_groups(group_order, n_splits)):
        train = frame.filter(pl.col("group_id").is_in(train_ids))
        test = frame.filter(pl.col("group_id").is_in(test_ids))
        if train.is_empty() or test.is_empty():
            continue

        model = _make_ranker(seed)
        model.fit(
            train.select(features).to_numpy(),
            train["relevance"].to_numpy(),
            group=_group_sizes(train),
        )

        scores = model.predict(test.select(features).to_numpy())
        ndcg, hit, mrr = _evaluate(test, scores)
        _, random_hit, random_mrr = _evaluate(
            test, _baseline_scores(test, "random", seed + index)
        )
        _, volume_hit, volume_mrr = _evaluate(
            test, _baseline_scores(test, "volume", seed)
        )

        folds.append(
            FoldMetrics(
                fold=index,
                train_groups=len(train_ids),
                test_groups=len(test_ids),
                ndcg_at_5=ndcg,
                hit_at_1=hit,
                mrr=mrr,
                random_hit_at_1=random_hit,
                volume_hit_at_1=volume_hit,
                random_mrr=random_mrr,
                volume_mrr=volume_mrr,
            )
        )

    if not folds:
        notes.append("Too few groups to form a single train/test split.")

    final = _make_ranker(seed)
    final.fit(
        frame.select(features).to_numpy(),
        frame["relevance"].to_numpy(),
        group=_group_sizes(frame),
    )

    importance = pl.DataFrame(
        {
            "feature": features,
            "gain": final.booster_.feature_importance(importance_type="gain").tolist(),
        }
    ).sort("gain", descending=True)

    mean_candidates = float(
        frame.group_by("group_id").len()["len"].mean() or 0.0
    )

    return RankerResult(
        model=final,
        features_used=features,
        folds=folds,
        importance=importance,
        n_groups=len(group_order),
        mean_candidates=mean_candidates,
        notes=notes,
    )


def _make_ranker(seed: int):
    return LGBMRanker(
        objective="lambdarank",
        metric="ndcg",
        ndcg_eval_at=[1, 3, 5],
        n_estimators=300,
        learning_rate=0.05,
        num_leaves=31,
        # Choice sets are small and noisy; these constrain the fit.
        min_child_samples=20,
        subsample=0.8,
        subsample_freq=1,
        colsample_bytree=0.8,
        reg_lambda=1.0,
        random_state=seed,
        n_jobs=1,
        # Match the bounded JSON contract; never create unsupported leaf/split
        # semantics and rely on an inference approximation to erase them.
        linear_tree=False,
        zero_as_missing=False,
        verbose=-1,
    )


def _group_sizes(frame: pl.DataFrame) -> list[int]:
    """Row counts per group, in the frame's current order.

    LightGBM's ranking API takes group *sizes*, not ids, and assumes rows are
    already contiguous by group. A frame sorted differently would silently
    mis-associate candidates with decisions.
    """
    return (
        frame.group_by("group_id", maintain_order=True)
        .len()["len"]
        .to_list()
    )


def score_candidates(
    result: RankerResult, candidates: pl.DataFrame
) -> pl.DataFrame:
    """Score a live candidate set. Highest score = most KOL-like.

    The scores are ordinal, not probabilities: only their order within one
    choice set is meaningful, and comparing scores across different decisions
    is not valid.
    """
    if candidates.is_empty():
        return candidates
    matrix = candidates.select(result.features_used).to_numpy()
    scores = result.model.predict(matrix)  # type: ignore[attr-defined]
    return candidates.with_columns(score=pl.Series("score", scores)).sort(
        "score", descending=True
    )
