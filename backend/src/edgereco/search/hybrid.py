"""Reciprocal Rank Fusion — built on EdgeProc's shared local-execution lego.

Re-exports ``reciprocal_rank_fusion`` from ``edge-proc[localvec]`` and provides
``weighted_reciprocal_rank_fusion`` (2:1 semantic-to-lexical weight, matching
the browser SQLite FTS5 + sqlite-vector fusion in ``catalogueDb.ts``) so
single-word lexical coincidences cannot outvote dense semantic matches.
"""

from __future__ import annotations

from edgeproc.localvec.fusion import reciprocal_rank_fusion

LEXICAL_RRF_WEIGHT: float = 1.0
SEMANTIC_RRF_WEIGHT: float = 2.0


def weighted_reciprocal_rank_fusion(
    keyword_results: list[tuple[str, float]],
    vector_results: list[tuple[str, float]],
    *,
    k: int | None = None,
    lexical_weight: float = LEXICAL_RRF_WEIGHT,
    semantic_weight: float = SEMANTIC_RRF_WEIGHT,
) -> list[tuple[str, float]]:
    """Semantic-weighted RRF composed over EdgeProc's ``reciprocal_rank_fusion``."""
    scores: dict[str, float] = {}
    for doc_id, score in reciprocal_rank_fusion(keyword_results, [], k=k):
        scores[doc_id] = scores.get(doc_id, 0.0) + lexical_weight * score
    for doc_id, score in reciprocal_rank_fusion([], vector_results, k=k):
        scores[doc_id] = scores.get(doc_id, 0.0) + semantic_weight * score
    return sorted(scores.items(), key=lambda x: x[1], reverse=True)


__all__ = [
    "LEXICAL_RRF_WEIGHT",
    "SEMANTIC_RRF_WEIGHT",
    "reciprocal_rank_fusion",
    "weighted_reciprocal_rank_fusion",
]
