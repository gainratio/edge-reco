"""Unit tests for the signed, bundle-carried ranking configuration.

The default config must reproduce today's hardcoded weights *exactly*, so swapping
the scorer onto a loaded ``RankingConfig`` is byte-identical: no score changes, no
parity-fixture drift. These tests pin the default values and the JSON round-trip.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from edgereco.reco.ranking_config import (
    DEFAULT_RANKING_CONFIG,
    RankingConfig,
    ScoringWeights,
)


def test_default_scoring_weights_match_legacy_constants() -> None:
    w = DEFAULT_RANKING_CONFIG.scoring_weights
    assert w.popularity == 0.40
    assert w.category == 0.20
    assert w.tag == 0.15
    assert w.brand == 0.10
    assert w.freshness == 0.10
    assert w.repetition_penalty == 0.25


@pytest.mark.parametrize(
    "field",
    [
        "popularity",
        "category",
        "tag",
        "brand",
        "freshness",
        "repetition_penalty",
        "similarity",
        "cooccurrence",
    ],
)
def test_negative_scoring_weight_fails_closed(field: str) -> None:
    """A negative weight in a (signed) config is rejected at validation — fail-closed."""
    base = {
        "popularity": 0.40,
        "category": 0.20,
        "tag": 0.15,
        "brand": 0.10,
        "freshness": 0.10,
        "repetition_penalty": 0.25,
    }
    base[field] = -0.01
    with pytest.raises(ValidationError):
        ScoringWeights(**base)


def test_negative_graded_signal_fails_closed() -> None:
    """A negative interaction-affinity weight is rejected at validation."""
    from edgereco.reco.ranking_config import GradedSignal

    with pytest.raises(ValidationError):
        GradedSignal(category=-0.1, tag=0.05, brand=0.08)


def test_committed_default_config_still_validates() -> None:
    """The shipped default (all weights >= 0) round-trips byte-stable under the bound."""
    payload = DEFAULT_RANKING_CONFIG.model_dump_json()
    assert RankingConfig.model_validate_json(payload) == DEFAULT_RANKING_CONFIG


# The historical hardcoded affinity bumps (once the server-side ``INTERACTION_WEIGHTS``,
# now retired). Pinned literally so the default config cannot drift from the values
# every committed bundle and parity fixture was produced with.
_LEGACY_INTERACTION_WEIGHTS: dict[str, dict[str, float]] = {
    "click": {"category": 0.10, "tag": 0.05, "brand": 0.08},
    "view": {"category": 0.02, "tag": 0.01, "brand": 0.02},
    "favorite": {"category": 0.20, "tag": 0.10, "brand": 0.15},
    "cart": {"category": 0.25, "tag": 0.12, "brand": 0.20},
}


def test_default_interaction_weights_match_legacy_constants() -> None:
    iw = DEFAULT_RANKING_CONFIG.interaction_weights
    for event_type, legacy in _LEGACY_INTERACTION_WEIGHTS.items():
        graded = getattr(iw, event_type)
        assert graded.category == legacy["category"]
        assert graded.tag == legacy["tag"]
        assert graded.brand == legacy["brand"]


def test_default_schema_version_is_three() -> None:
    """Phase 3 bumps the schema to 3 (co-occurrence strategies + weight)."""
    assert DEFAULT_RANKING_CONFIG.schema_version == 3


def test_json_round_trip_preserves_default() -> None:
    payload = DEFAULT_RANKING_CONFIG.model_dump_json()
    restored = RankingConfig.model_validate_json(payload)
    assert restored == DEFAULT_RANKING_CONFIG


def test_strategies_field_is_optional_and_defaults_empty() -> None:
    """A v1 bundle (no ``strategies``) loads cleanly — only ``for_you`` is implied."""
    legacy = RankingConfig(
        scoring_weights=DEFAULT_RANKING_CONFIG.scoring_weights,
        interaction_weights=DEFAULT_RANKING_CONFIG.interaction_weights,
        schema_version=1,
    )
    assert legacy.strategies == {}


def test_similarity_weight_defaults_to_zero() -> None:
    """``ScoringWeights.similarity`` defaults to 0 → the formula reduces to today's."""
    assert DEFAULT_RANKING_CONFIG.scoring_weights.similarity == 0.0


def test_default_strategy_map_has_the_seven_named_strategies() -> None:
    assert set(DEFAULT_RANKING_CONFIG.strategies) == {
        "for_you",
        "trending",
        "new_arrivals",
        "similar_items",
        "because_viewed",
        "also_bought",
        "frequently_bought_together",
    }


def test_cooccurrence_weight_defaults_to_zero() -> None:
    """``ScoringWeights.cooccurrence`` defaults to 0 → other strategies unchanged."""
    assert DEFAULT_RANKING_CONFIG.scoring_weights.cooccurrence == 0.0


def test_also_bought_strategy_shape() -> None:
    s = DEFAULT_RANKING_CONFIG.strategies["also_bought"]
    assert s.label == "Customers who bought this also bought"
    assert s.candidate_policy == "co_occurrence"
    assert s.weights.cooccurrence > 0.0


def test_frequently_bought_together_strategy_shape() -> None:
    s = DEFAULT_RANKING_CONFIG.strategies["frequently_bought_together"]
    assert s.label == "Frequently bought together"
    assert s.candidate_policy == "co_occurrence"
    assert s.weights.cooccurrence > 0.0


def test_cooccurrence_weight_round_trips() -> None:
    payload = DEFAULT_RANKING_CONFIG.model_dump_json()
    restored = RankingConfig.model_validate_json(payload)
    assert (
        restored.strategies["also_bought"].weights.cooccurrence
        == DEFAULT_RANKING_CONFIG.strategies["also_bought"].weights.cooccurrence
    )


def test_pre_phase3_bundle_without_cooccurrence_weight_degrades() -> None:
    """A schema-2 bundle (no ``cooccurrence`` weight) still parses; weight defaults 0."""
    legacy = RankingConfig(
        scoring_weights=ScoringWeights(
            popularity=0.40,
            category=0.20,
            tag=0.15,
            brand=0.10,
            freshness=0.10,
            repetition_penalty=0.25,
        ),
        interaction_weights=DEFAULT_RANKING_CONFIG.interaction_weights,
        schema_version=2,
    )
    assert legacy.scoring_weights.cooccurrence == 0.0


def test_for_you_strategy_weights_equal_top_level_scoring_weights() -> None:
    """Parity invariant: ``for_you`` re-ranks identically to the Phase-1 default."""
    for_you = DEFAULT_RANKING_CONFIG.strategies["for_you"]
    assert for_you.candidate_policy == "affinity_first"
    assert for_you.weights == DEFAULT_RANKING_CONFIG.scoring_weights


def test_default_strategy_candidate_policies() -> None:
    strategies = DEFAULT_RANKING_CONFIG.strategies
    assert strategies["trending"].candidate_policy == "popularity"
    assert strategies["new_arrivals"].candidate_policy == "freshness"
    assert strategies["similar_items"].candidate_policy == "vector_similarity"
    assert strategies["because_viewed"].candidate_policy == "vector_similarity"


def test_default_strategy_weight_leans() -> None:
    """Each strategy leans its dominant signal heaviest."""
    s = DEFAULT_RANKING_CONFIG.strategies
    # trending: popularity dominates
    assert _argmax(s["trending"].weights) == "popularity"
    # new_arrivals: freshness dominates
    assert _argmax(s["new_arrivals"].weights) == "freshness"
    # similar_items: similarity dominates + some popularity
    assert _argmax(s["similar_items"].weights) == "similarity"
    assert s["similar_items"].weights.popularity > 0.0
    # because_viewed: similarity dominates + light affinity
    assert _argmax(s["because_viewed"].weights) == "similarity"
    assert s["because_viewed"].weights.category > 0.0


def _argmax(weights: object) -> str:
    """Name of the heaviest positive signal (repetition_penalty excluded)."""
    fields = ("popularity", "category", "tag", "brand", "freshness", "similarity")
    return max(fields, key=lambda f: getattr(weights, f))


def test_json_round_trip_preserves_strategies() -> None:
    payload = DEFAULT_RANKING_CONFIG.model_dump_json()
    restored = RankingConfig.model_validate_json(payload)
    assert restored.strategies == DEFAULT_RANKING_CONFIG.strategies
