"""Thin FastAPI wrapper adding CORS + a browse endpoint over edge-reco's engine.

The demo storefront is a browser SPA (Vite dev server on :5174, preview on
:4173) that calls edge-reco's API directly. The library's ``create_app`` adds
no CORS and exposes only ``/search`` + ``/recommend``; a storefront also needs a
plain catalog-browse feed. So this module builds the engine's ``ServiceContainer``,
wraps the app with ``CORSMiddleware``, and mounts a typed ``/products`` browse route.

Catalog source — local-first delivery loop:
    When ``EDGERECO_BUNDLE_BASE_URL`` + ``EDGERECO_VERIFY_KEY_PATH`` are set (the
    Docker stack sets both), the backend SYNCS a signed, content-addressed bundle
    from the Caddy CDN origin at import time via ``ServiceContainer.from_synced`` —
    proving the real publish→sync→serve loop end-to-end with the 720-product synthetic
    catalog. Sync fails closed on a bad signature or tampered chunk.

    With no bundle env set (plain ``uv run`` / tests), it falls back to the committed
    stand-in catalog via ``from_catalog`` so the demo stays runnable offline.

The build runs at import time, BEFORE uvicorn's event loop exists — required because
both ``from_catalog`` (``VectorIndex.build``) and ``from_synced`` (``VectorIndex.load``)
call ``asyncio.run`` internally, which raises inside an already-running loop. See
``serve.py`` for the launcher that imports this pre-built ``app``.

Launch:
    uv run python -m demo_server.serve
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from edgereco.api.app import create_app
from edgereco.api.deps import ServiceContainer
from edgereco.catalog.loader import load_jsonl
from edgereco.catalog.models import Product
from edgereco.config import Settings

CATALOG_PATH = Path(__file__).parent / "catalog" / "products.jsonl"

ALLOWED_ORIGINS = (
    "http://localhost:5174",
    "http://localhost:4173",
)


def cors_origins() -> list[str]:
    """Allowed browser origins. ``DEMO_CORS_ORIGINS`` (comma-separated) overrides the
    localhost defaults — needed when the frontend is served from a non-localhost host
    (Docker edge / LAN)."""
    raw = os.environ.get("DEMO_CORS_ORIGINS", "")
    configured = [origin.strip() for origin in raw.split(",") if origin.strip()]
    return configured or list(ALLOWED_ORIGINS)


class BrowseResponse(BaseModel):
    """Catalog browse page: a window of products plus the category facets."""

    products: list[Product]
    total: int
    categories: list[str]


def load_catalog() -> list[Product]:
    """Load the committed demo catalog as a list of edge-reco Products."""
    return load_jsonl(CATALOG_PATH)


def build_container() -> ServiceContainer:
    """Sync the signed bundle from the CDN when configured, else use the committed catalog.

    Runs at import time (no event loop yet), so the ``asyncio.run`` inside
    ``VectorIndex.load`` / ``VectorIndex.build`` is safe.
    """
    settings = Settings()
    if settings.bundle_base_url and settings.verify_key_path:
        from edgeproc.bundles.signing import Ed25519Verifier

        verifier = Ed25519Verifier.from_public_bytes(settings.verify_key_path.read_bytes())
        return ServiceContainer.from_synced(
            base_url=settings.bundle_base_url,
            cache_root=settings.bundle_cache_dir,
            verifier=verifier,
        )
    return ServiceContainer.from_catalog(load_catalog())


def _browse_router(products: list[Product]) -> APIRouter:
    """A read-only catalog-browse feed over the in-memory demo catalog."""
    router = APIRouter()
    categories = sorted({product.category for product in products})

    @router.get("/products")
    def list_products(
        category: Annotated[str | None, Query()] = None,
        limit: Annotated[int, Query(ge=1, le=100)] = 24,
        offset: Annotated[int, Query(ge=0)] = 0,
    ) -> BrowseResponse:
        items = [p for p in products if category is None or p.category == category]
        return BrowseResponse(
            products=items[offset : offset + limit], total=len(items), categories=categories
        )

    return router


def build_app() -> FastAPI:
    """Build the edge-reco app over the catalog source with CORS + browse enabled."""
    container = build_container()
    fastapi_app = create_app(container)
    fastapi_app.add_middleware(
        CORSMiddleware,
        allow_origins=cors_origins(),
        allow_methods=["*"],
        allow_headers=["*"],
    )
    fastapi_app.include_router(_browse_router(container.catalog))
    return fastapi_app


app = build_app()
