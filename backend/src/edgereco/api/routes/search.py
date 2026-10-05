"""Search endpoint: hybrid BM25 + FAISS + RRF, then a stateless rerank.

The server keeps no per-visitor session; the rerank runs against an empty profile.
"""

from __future__ import annotations

from typing import Annotated, NamedTuple

from fastapi import APIRouter, Query

from edgereco.api.deps import Container, ServiceContainer
from edgereco.api.models import SearchResponse
from edgereco.catalog.models import SearchResult, SessionProfile
from edgereco.reco.reranker import RetrievalEvidence, rerank_search, retrieval_evidence
from edgereco.search.hybrid import reciprocal_rank_fusion

router = APIRouter()


class _Fused(NamedTuple):
    """The fused candidate pool, plus the absolute scores RRF discards."""

    results: list[SearchResult]
    evidence: dict[str, RetrievalEvidence]


def _fused_results(container: ServiceContainer, q: str, k: int) -> _Fused:
    """Hybrid keyword + vector hits fused with RRF, hydrated against the catalog."""
    keyword_hits = container.keyword.search(q, k=k)
    query_vec = container.encoder.encode_query(q)
    vector_hits = container.vector.search(query_vec, k=k)
    results: list[SearchResult] = []
    for pid, score in reciprocal_rank_fusion(keyword_hits, vector_hits):
        product = container.by_id.get(pid)
        if product is not None:
            results.append(SearchResult(product=product, score=score))
    return _Fused(results, retrieval_evidence(keyword_hits, vector_hits))


def _filter_category(results: list[SearchResult], category: str | None) -> list[SearchResult]:
    """Keep only ``category`` products when a category filter is given."""
    if not category:
        return results
    return [r for r in results if r.product.category == category]


@router.get("/search", response_model=SearchResponse)
def search(
    container: Container,
    q: Annotated[str, Query()] = "",
    limit: Annotated[int, Query(ge=1, le=100)] = 10,
    category: Annotated[str | None, Query()] = None,
) -> SearchResponse:
    if not q.strip():
        return SearchResponse(results=[], query="", total=0)

    fused = _fused_results(container, q, k=max(limit * 3, 30))

    ranked = rerank_search(
        fused.results, SessionProfile(), fused.evidence, container.ranking_config.scoring_weights
    )
    # `total` counts what SURVIVED the absolute floor, not what fusion produced.
    # Reporting the fused count would tell a caller "192 matches" alongside a page
    # holding none of them — the same lie the floor exists to stop telling.
    total_pre_filter = len(ranked)
    results = _filter_category(ranked, category)

    return SearchResponse(results=results[:limit], query=q, total=total_pre_filter)
