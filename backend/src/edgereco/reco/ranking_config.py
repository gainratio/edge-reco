"""Ranking configuration: the scoring weights, carried in the signed bundle.

The scorer used to hardcode its weights as module constants. They now live in a
typed ``RankingConfig`` serialized as ``ranking_config.json`` inside the signed,
content-addressed bundle, so a maintainer can retune ranking by republishing data
— no code change, no redeploy. ``DEFAULT_RANKING_CONFIG`` reproduces the original
constants byte-for-byte and is the typed fallback when a bundle predates the file,
so today's scores stay identical.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

#: Closed set of candidate-selection policies a strategy may pick (``reco.pool``).
#: ``affinity_first`` is today's warm/cold logic; ``co_occurrence`` is the Phase-3
#: item-to-item addition; the rest are Phase-2.
CandidatePolicy = Literal[
    "affinity_first",
    "popularity",
    "freshness",
    "vector_similarity",
    "co_occurrence",
]


class ScoringWeights(BaseModel):
    """Per-signal weights for the final ranking formula (``reco.scorer``).

    ``similarity`` (Phase 2) and ``cooccurrence`` (Phase 3) both default to 0.0, so a
    pre-Phase-3 bundle — and every strategy that doesn't use them — reduces to the
    original formula byte-for-byte. Every weight is range-constrained ``>= 0``: an
    illegal (negative) weight in a signed config fails Pydantic validation fail-closed.
    """

    popularity: float = Field(ge=0)
    category: float = Field(ge=0)
    tag: float = Field(ge=0)
    brand: float = Field(ge=0)
    freshness: float = Field(ge=0)
    repetition_penalty: float = Field(ge=0)
    similarity: float = Field(default=0.0, ge=0)
    cooccurrence: float = Field(default=0.0, ge=0)


class GradedSignal(BaseModel):
    """Affinity bumps a single interaction applies (the browser tier's ``applyInteraction``).

    Each bump is range-constrained ``>= 0`` so a tampered/negative affinity weight
    in a signed config fails validation fail-closed.
    """

    category: float = Field(ge=0)
    tag: float = Field(ge=0)
    brand: float = Field(ge=0)


class InteractionWeights(BaseModel):
    """Per-event-type affinity bumps, one ``GradedSignal`` per ``EventType``."""

    click: GradedSignal
    view: GradedSignal
    favorite: GradedSignal
    cart: GradedSignal


class Strategy(BaseModel):
    """A named recommendation strategy: a candidate policy + its scoring weights.

    Carried in the bundle so a maintainer can add or retune a rail by republishing
    data — no code change. ``label`` is the human-facing rail title.
    ``co_occurrence_top_k`` (Phase 3) caps how many of the seed's co-occurrence
    neighbours feed the pool; ``None`` keeps them all (``also_bought``), a small
    integer makes a tighter "frequently bought together" cut.
    """

    label: str
    candidate_policy: CandidatePolicy
    weights: ScoringWeights
    co_occurrence_top_k: int | None = None


class RankingConfig(BaseModel):
    """The full ranking configuration carried as ``ranking_config.json``.

    ``strategies`` (Phase 2) defaults to empty so a v1 bundle loads cleanly with only
    ``for_you`` implied. ``schema_version`` is 3 as of Phase 3 (co-occurrence
    strategies + ``cooccurrence`` weight); older bundles still validate (additive).
    """

    scoring_weights: ScoringWeights
    interaction_weights: InteractionWeights
    schema_version: int
    strategies: dict[str, Strategy] = {}


_DEFAULT_SCORING_WEIGHTS = ScoringWeights(
    popularity=0.40,
    category=0.20,
    tag=0.15,
    brand=0.10,
    freshness=0.10,
    repetition_penalty=0.25,
)

#: The seven shipped strategies. ``for_you`` re-uses the top-level weights verbatim
#: (Phase-1 parity); the others lean their dominant signal heaviest. ``similarity``
#: is non-zero only for the vector-similarity strategies.
_DEFAULT_STRATEGIES = {
    "for_you": Strategy(
        label="Recommended for you",
        candidate_policy="affinity_first",
        weights=_DEFAULT_SCORING_WEIGHTS,
    ),
    "trending": Strategy(
        label="Trending now",
        candidate_policy="popularity",
        weights=ScoringWeights(
            popularity=0.80,
            category=0.05,
            tag=0.04,
            brand=0.03,
            freshness=0.08,
            repetition_penalty=0.25,
        ),
    ),
    "new_arrivals": Strategy(
        label="New arrivals",
        candidate_policy="freshness",
        weights=ScoringWeights(
            popularity=0.15,
            category=0.05,
            tag=0.04,
            brand=0.03,
            freshness=0.70,
            repetition_penalty=0.25,
        ),
    ),
    "similar_items": Strategy(
        label="Similar items",
        candidate_policy="vector_similarity",
        weights=ScoringWeights(
            popularity=0.20,
            category=0.05,
            tag=0.04,
            brand=0.03,
            freshness=0.05,
            repetition_penalty=0.25,
            similarity=0.60,
        ),
    ),
    "because_viewed": Strategy(
        label="Because you viewed this",
        candidate_policy="vector_similarity",
        weights=ScoringWeights(
            popularity=0.10,
            category=0.12,
            tag=0.08,
            brand=0.06,
            freshness=0.04,
            repetition_penalty=0.25,
            similarity=0.55,
        ),
    ),
    "also_bought": Strategy(
        label="Customers who bought this also bought",
        candidate_policy="co_occurrence",
        weights=ScoringWeights(
            popularity=0.15,
            category=0.05,
            tag=0.04,
            brand=0.03,
            freshness=0.03,
            repetition_penalty=0.25,
            cooccurrence=0.70,
        ),
    ),
    "frequently_bought_together": Strategy(
        label="Frequently bought together",
        candidate_policy="co_occurrence",
        weights=ScoringWeights(
            popularity=0.08,
            category=0.04,
            tag=0.03,
            brand=0.02,
            freshness=0.02,
            repetition_penalty=0.25,
            cooccurrence=0.80,
        ),
        co_occurrence_top_k=3,
    ),
}

DEFAULT_RANKING_CONFIG = RankingConfig(
    scoring_weights=_DEFAULT_SCORING_WEIGHTS,
    interaction_weights=InteractionWeights(
        click=GradedSignal(category=0.10, tag=0.05, brand=0.08),
        view=GradedSignal(category=0.02, tag=0.01, brand=0.02),
        favorite=GradedSignal(category=0.20, tag=0.10, brand=0.15),
        cart=GradedSignal(category=0.25, tag=0.12, brand=0.20),
    ),
    schema_version=3,
    strategies=_DEFAULT_STRATEGIES,
)
