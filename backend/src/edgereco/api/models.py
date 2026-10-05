"""Typed response models for the EdgeReco HTTP API.

These mirror the JSON each route returns so handlers can declare a precise
``response_model`` instead of an opaque ``dict[str, Any]``. Field names and
nesting match the wire format the frontend and tests rely on.
"""

from __future__ import annotations

from pydantic import BaseModel

from edgereco.catalog.models import SearchResult


class IndexStats(BaseModel):
    """Sizes of the keyword and vector indices backing a catalog."""

    keyword_corpus_size: int
    vector_index_size: int


class CatalogInfo(BaseModel):
    """Response for ``GET /catalog/info``."""

    catalog_id: str
    version: str
    product_count: int
    index_stats: IndexStats


class SearchResponse(BaseModel):
    """Response for ``GET /search``."""

    results: list[SearchResult]
    query: str
    total: int


class RecommendResponse(BaseModel):
    """Response for ``GET /recommend``."""

    results: list[SearchResult]
