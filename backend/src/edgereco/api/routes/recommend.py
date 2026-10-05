"""Recommend endpoint: stateless, strategy-aware rerank over the full catalog.

The server keeps no per-visitor session: personalization lives in the browser,
which holds the taste profile on-device. Here every request ranks against an
empty profile, so the same query always returns the same list.

``strategy`` defaults to ``for_you`` (today's behavior); ``seed`` is the product the
``vector_similarity`` strategies recommend around. An unknown strategy or a vector
strategy with no seed is a 422 client error, never a 500.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, HTTPException, Query

from edgereco.api.deps import Container
from edgereco.api.models import RecommendResponse
from edgereco.catalog.models import Product, SearchResult, SessionProfile
from edgereco.reco.cooccurrence import CooccurrenceMatrix
from edgereco.reco.ranking_config import RankingConfig
from edgereco.reco.recommend import recommend as run_recommend
from edgereco.search.vector import VectorSearcher

router = APIRouter()


@router.get("/recommend", response_model=RecommendResponse)
def recommend(
    container: Container,
    limit: Annotated[int, Query(ge=1, le=100)] = 10,
    strategy: Annotated[str, Query()] = "for_you",
    seed: Annotated[str | None, Query()] = None,
) -> RecommendResponse:
    ranked = _run(
        catalog=container.catalog,
        by_id=container.by_id,
        profile=SessionProfile(),
        config=container.ranking_config,
        vector=container.vector,
        cooccurrence=container.cooccurrence,
        strategy=strategy,
        seed=seed,
        limit=limit,
    )
    return RecommendResponse(results=ranked)


def _run(
    *,
    catalog: list[Product],
    by_id: dict[str, Product],
    profile: SessionProfile,
    config: RankingConfig,
    vector: VectorSearcher,
    cooccurrence: CooccurrenceMatrix,
    strategy: str,
    seed: str | None,
    limit: int,
) -> list[SearchResult]:
    """Dispatch the strategy, mapping bad input (unknown strategy / missing seed) to 422."""
    try:
        return run_recommend(
            catalog=catalog,
            by_id=by_id,
            profile=profile,
            config=config,
            vector=vector,
            cooccurrence=cooccurrence,
            strategy=strategy,
            seed=seed,
            limit=limit,
        )
    except KeyError as exc:
        raise HTTPException(status_code=422, detail=f"unknown strategy: {strategy}") from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
