"""Data models for EdgeReco product catalog."""

from __future__ import annotations

from typing import Literal

from assay import ScoreResult
from pydantic import BaseModel


class Product(BaseModel):
    """A product in the catalog."""

    id: str
    title: str
    description: str = ""
    category: str
    subcategories: list[str] = []
    tags: list[str] = []
    brand: str = ""
    price: float | None = None
    currency: str = "USD"
    popularity_score: float = 0.0
    freshness_score: float = 0.0
    image_url: str = ""
    url: str = ""
    attributes: dict[str, str] = {}


class CatalogFile(BaseModel):
    """A file entry in a catalog manifest."""

    path: str
    file_type: str
    checksum: str
    rows: int | None = None


class CatalogManifest(BaseModel):
    """Manifest describing a catalog version and its files."""

    catalog_id: str
    version: str
    embedding_model: str
    embedding_dim: int = 384
    files: list[CatalogFile]


class SessionProfile(BaseModel):
    """User session profile for personalization."""

    category_affinity: dict[str, float] = {}
    tag_affinity: dict[str, float] = {}
    brand_affinity: dict[str, float] = {}
    recently_viewed: list[str] = []
    click_count: int = 0


class SearchResult(BaseModel):
    """A single search/recommendation result."""

    product: Product
    score: float
    score_components: dict[str, float] = {}
    score_explanation: ScoreResult | None = None


type EventType = Literal["click", "view", "favorite", "cart"]
