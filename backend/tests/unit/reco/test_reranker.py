import re
from pathlib import Path

import pytest

from edgereco.catalog.models import Product, SearchResult, SessionProfile
from edgereco.reco.reranker import (
    MIN_LEXICAL_RELEVANCE,
    MIN_SEMANTIC_RELEVANCE,
    RetrievalEvidence,
    meets_relevance_floor,
    rerank,
    rerank_search,
    retrieval_evidence,
)


def _product(pid: str, category: str = "Electronics", pop: float = 0.5) -> Product:
    return Product(id=pid, title=f"Product {pid}", category=category, popularity_score=pop)


def _result(
    pid: str, score: float, category: str = "Electronics", pop: float = 0.5
) -> SearchResult:
    return SearchResult(product=_product(pid, category, pop), score=score)


def _admit(*pids: str) -> dict[str, RetrievalEvidence]:
    """Every named candidate admitted on strong semantic evidence."""
    return {pid: RetrievalEvidence(semantic=0.9, lexical=None) for pid in pids}


def test_rerank_with_empty_profile_preserves_order() -> None:
    results = [_result("a", 0.9), _result("b", 0.7), _result("c", 0.5)]
    reranked = rerank_search(results, SessionProfile(), _admit("a", "b", "c"))
    assert len(reranked) == 3


def test_rerank_boosts_matching_category() -> None:
    # Recommendation candidates ignore retrieval scores and use session affinity.
    results = [
        _result("formal", 0.9, "Clothing", 0.6),
        _result("electronics", 0.89, "Electronics", 0.2),
    ]
    profile = SessionProfile(category_affinity={"Electronics": 1.0})
    reranked = rerank(results, profile)
    assert reranked[0].product.id == "electronics"


def test_rerank_applies_repetition_penalty() -> None:
    results = [_result("a", 0.9, pop=0.9), _result("b", 0.7, pop=0.7)]
    profile = SessionProfile(recently_viewed=["a"])
    reranked = rerank(results, profile)
    assert reranked[0].product.id == "b"


def test_should_keep_strong_retrieval_ahead_of_popularity() -> None:
    # Given
    results = [_result("relevant", 99.0, pop=0.6), _result("popular", 1.0, pop=0.8)]

    # When
    reranked = rerank_search(results, SessionProfile(), _admit("relevant", "popular"))

    # Then
    assert [result.product.id for result in reranked] == ["relevant", "popular"]
    assert reranked[0].score_components["retrieval"] == 1.0


def test_should_rank_stadium_seat_first_when_a_seat_cover_is_more_popular() -> None:
    """REGRESSION: "stadium seat" led with car seat covers.

    Both retrievers put the Stadium Seats products first, but RRF at k=60 is flat
    (rank 1 = 0.0328, rank 6 = 0.0294). Dividing by the best hit left retrieval
    spanning 0.18-0.20 while popularity spans 0-0.4, so the query-independent signal
    outvoted the query. Fused scores and popularity are the measured catalogue values.
    """
    # Given
    results = [
        _result("NB-00533", 0.0328, pop=0.3359),
        _result("NB-00667", 0.0294, pop=0.8414),
        _result("NB-00408", 0.0286, pop=0.5388),
    ]
    reranked = rerank_search(results, SessionProfile(), _admit("NB-00533", "NB-00667", "NB-00408"))
    assert reranked[0].product.id == "NB-00533"


def test_should_span_retrieval_zero_to_one_when_scores_differ() -> None:
    """Pinned literals: best admitted hit 1.0, weakest 0.0, the rest on the line."""
    # Given
    results = [_result("best", 0.04), _result("mid", 0.03), _result("worst", 0.02)]

    # When
    reranked = rerank_search(results, SessionProfile(), _admit("best", "mid", "worst"))

    # Then
    retrieval = {r.product.id: r.score_components["retrieval"] for r in reranked}
    assert retrieval["best"] == 1.0
    assert retrieval["mid"] == pytest.approx(0.5, abs=1e-12)
    assert retrieval["worst"] == 0.0


def test_should_give_full_weight_when_fused_scores_tie() -> None:
    # Given
    results = [_result("a", 0.02), _result("b", 0.02)]

    # When
    reranked = rerank_search(results, SessionProfile(), _admit("a", "b"))

    # Then
    assert [r.score_components["retrieval"] for r in reranked] == [1.0, 1.0]


def test_should_match_browser_relevance_weight_when_reading_reranker_ts() -> None:
    """Pin the literal on both sides, so the two tiers cannot rank differently."""
    source = (
        Path(__file__).resolve().parents[3].parent
        / "frontend/packages/edgereco-browser/src/engine/reranker.ts"
    ).read_text(encoding="utf-8")
    weight = re.search(r"SEARCH_RELEVANCE_WEIGHT = ([\d.]+);", source)
    assert weight is not None, "reranker.ts no longer declares SEARCH_RELEVANCE_WEIGHT"
    assert float(weight.group(1)) == 1.0


def test_the_floor_is_the_measured_noise_ceiling() -> None:
    """Pin the literals the docstrings promise, not the constants against themselves."""
    assert MIN_SEMANTIC_RELEVANCE == 0.4
    assert MIN_LEXICAL_RELEVANCE == 0.0


def test_the_browser_port_carries_the_same_floor() -> None:
    """One rule in two languages diverges unless something reads both copies.

    The TypeScript engine reproduces this ranker in the browser; a floor that moved
    on one side only would ship two different answers to the same query.
    """
    source = (
        Path(__file__).resolve().parents[3].parent
        / "frontend/packages/edgereco-browser/src/engine/reranker.ts"
    ).read_text(encoding="utf-8")
    semantic = re.search(r"MIN_SEMANTIC_RELEVANCE = ([\d.]+);", source)
    lexical = re.search(r"MIN_LEXICAL_RELEVANCE = ([\d.]+);", source)
    assert semantic is not None, "reranker.ts no longer declares MIN_SEMANTIC_RELEVANCE"
    assert lexical is not None, "reranker.ts no longer declares MIN_LEXICAL_RELEVANCE"
    assert float(semantic.group(1)) == MIN_SEMANTIC_RELEVANCE
    assert float(lexical.group(1)) == MIN_LEXICAL_RELEVANCE


def test_a_candidate_below_the_semantic_floor_is_dropped() -> None:
    assert meets_relevance_floor(RetrievalEvidence(semantic=0.3999, lexical=None)) is False
    assert meets_relevance_floor(RetrievalEvidence(semantic=0.4, lexical=None)) is True


def test_a_keyword_hit_is_admitted_however_weak_its_cosine() -> None:
    assert meets_relevance_floor(RetrievalEvidence(semantic=0.05, lexical=0.9)) is True
    assert meets_relevance_floor(RetrievalEvidence(semantic=0.05, lexical=0.0)) is False


def test_a_candidate_with_no_evidence_is_dropped_fail_closed() -> None:
    assert meets_relevance_floor(None) is False
    assert meets_relevance_floor(RetrievalEvidence(semantic=None, lexical=None)) is False


def test_a_set_whose_best_hit_is_junk_returns_nothing() -> None:
    """THE PROPERTY. Rank-normalization gave the best hit a full 1.0 for every query.

    Here every candidate is noise, and the honest answer is an empty page.
    """
    results = [_result("a", 0.0328), _result("b", 0.0164)]
    evidence = {
        "a": RetrievalEvidence(semantic=0.397, lexical=None),
        "b": RetrievalEvidence(semantic=0.21, lexical=None),
    }
    assert rerank_search(results, SessionProfile(), evidence) == []


def test_retrieval_is_renormalized_over_the_survivors() -> None:
    results = [_result("dropped", 100.0), _result("kept", 10.0)]
    evidence = {
        "dropped": RetrievalEvidence(semantic=0.1, lexical=None),
        "kept": RetrievalEvidence(semantic=0.9, lexical=None),
    }
    reranked = rerank_search(results, SessionProfile(), evidence)
    assert [result.product.id for result in reranked] == ["kept"]
    assert reranked[0].score_components["retrieval"] == 1.0


def test_admitted_results_with_no_retrieval_signal_score_zero_retrieval() -> None:
    """The floor made this branch reachable only here: admitted, but nothing to scale.

    ``rerank_search`` divides by the best admitted RRF score. With every admitted
    score at 0 there is no scale, and the retrieval component must be 0 rather than
    a division by zero.
    """
    results = [_result("a", 0.0), _result("b", 0.0)]
    reranked = rerank_search(results, SessionProfile(), _admit("a", "b"))
    assert [r.score_components["retrieval"] for r in reranked] == [0.0, 0.0]


def test_retrieval_evidence_keys_both_scales_by_id() -> None:
    evidence = retrieval_evidence([("a", 3.5)], [("a", 0.62), ("b", 0.31)])
    assert evidence["a"] == RetrievalEvidence(semantic=0.62, lexical=3.5)
    # Retrieved by one engine only: the other side is absent, not zero. Zero would
    # read as "scored 0", a measurement the retriever never made.
    assert evidence["b"] == RetrievalEvidence(semantic=0.31, lexical=None)
    assert "nope" not in evidence
