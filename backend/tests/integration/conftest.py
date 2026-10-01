"""Shared fixtures for integration tests.

The ``container`` is built the way the edge runtime really builds it: publish a
signed, content-addressed bundle from the mini catalog, then ``from_synced`` it.
``build_synced_container`` is the reusable builder; it optionally stages a custom
``ranking_config.json`` so a test can exercise the republish-retune path.
"""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest
from edgeproc.bundles.signing import Ed25519Verifier, generate_keypair
from fastapi.testclient import TestClient

from edgereco.api.app import create_app
from edgereco.api.deps import ServiceContainer
from edgereco.catalog.loader import load_jsonl
from edgereco.catalog.publish import publish_bundle
from edgereco.embeddings.encoder import ProductEncoder
from edgereco.embeddings.index import VectorIndex
from edgereco.reco.ranking_config import RankingConfig
from tests.signing import save_seed

FIXTURES_DIR = Path(__file__).parent.parent / "fixtures"


def _stage_mini_catalog(staging: Path, ranking_config: RankingConfig | None) -> tuple[int, int]:
    """Stage products + a prebuilt index (and, optionally, a custom ranking config).

    Returns ``(product_count, embedding_dim)`` for the publish call.
    """
    shutil.copy2(FIXTURES_DIR / "mini_catalog.jsonl", staging / "products.jsonl")
    products = load_jsonl(staging / "products.jsonl")
    encoder = ProductEncoder()
    index = VectorIndex.build(encoder.encode(products), [p.id for p in products], dim=encoder.dim)
    index.save(staging / "vector")
    if ranking_config is not None:
        (staging / "ranking_config.json").write_text(ranking_config.model_dump_json())
    return len(products), encoder.dim


def _publish_mini_bundle(
    staging: Path, origin: Path, key_path: Path, *, product_count: int, dim: int
) -> None:
    publish_bundle(
        staging_dir=staging,
        origin_dir=origin,
        private_key_path=key_path,
        catalog_id="integration-origin",
        version="v1",
        embedding_model="sentence-transformers/all-MiniLM-L6-v2",
        embedding_dim=dim,
        embedding_count=product_count,
        product_count=product_count,
    )


def build_synced_container(
    tmp_path_factory: pytest.TempPathFactory,
    *,
    ranking_config: RankingConfig | None = None,
) -> ServiceContainer:
    """Publish a signed bundle from the mini catalog and ``from_synced`` it."""
    staging = tmp_path_factory.mktemp("staging")
    product_count, dim = _stage_mini_catalog(staging, ranking_config)
    private, public = generate_keypair()
    key_path = tmp_path_factory.mktemp("keys") / "private.key"
    save_seed(private.private_bytes_raw(), key_path)
    origin = tmp_path_factory.mktemp("origin")
    _publish_mini_bundle(staging, origin, key_path, product_count=product_count, dim=dim)
    return ServiceContainer.from_synced(
        base_url=str(origin),
        cache_root=tmp_path_factory.mktemp("cache"),
        verifier=Ed25519Verifier(public),
    )


@pytest.fixture(scope="session")
def container(tmp_path_factory: pytest.TempPathFactory) -> ServiceContainer:
    return build_synced_container(tmp_path_factory)


@pytest.fixture(scope="session")
def client(container: ServiceContainer) -> TestClient:
    app = create_app(container)
    return TestClient(app)
