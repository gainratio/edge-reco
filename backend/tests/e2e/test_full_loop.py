"""End-to-end test: publish signed bundle → from_synced → search → stateless recommend."""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest
from edgeproc.bundles.signing import Ed25519Verifier, generate_keypair
from fastapi.testclient import TestClient

from edgereco.api.app import create_app
from edgereco.api.deps import ServiceContainer
from edgereco.catalog.loader import load_jsonl
from edgereco.embeddings.encoder import ProductEncoder
from edgereco.embeddings.index import VectorIndex
from tests.signing import save_seed

FIXTURES_DIR = Path(__file__).parent.parent / "fixtures"


@pytest.fixture(scope="module")
def signed_origin(tmp_path_factory: pytest.TempPathFactory) -> tuple[Path, Ed25519Verifier]:
    """Build a real index over mini_catalog, stage it, publish a signed bundle origin."""
    staging = tmp_path_factory.mktemp("staging")
    shutil.copy2(FIXTURES_DIR / "mini_catalog.jsonl", staging / "products.jsonl")

    products = load_jsonl(staging / "products.jsonl")
    encoder = ProductEncoder()
    embeddings = encoder.encode(products)
    index = VectorIndex.build(embeddings, [p.id for p in products], dim=encoder.dim)
    index.save(staging / "vector")

    private, public = generate_keypair()
    key_path = tmp_path_factory.mktemp("keys") / "private.key"
    save_seed(private.private_bytes_raw(), key_path)

    origin = tmp_path_factory.mktemp("origin")
    from edgereco.catalog.publish import publish_bundle

    publish_bundle(
        staging_dir=staging,
        origin_dir=origin,
        private_key_path=key_path,
        catalog_id="e2e-origin",
        version="v1",
        embedding_model="sentence-transformers/all-MiniLM-L6-v2",
        embedding_dim=encoder.dim,
        embedding_count=len(products),
        product_count=len(products),
    )
    return origin, Ed25519Verifier(public)


@pytest.fixture(scope="module")
def container(
    signed_origin: tuple[Path, Ed25519Verifier],
    tmp_path_factory: pytest.TempPathFactory,
) -> ServiceContainer:
    """Sync the signed origin and build a container — the edge runtime's real path."""
    origin, verifier = signed_origin
    cache_root = tmp_path_factory.mktemp("cache")
    return ServiceContainer.from_synced(
        base_url=str(origin), cache_root=cache_root, verifier=verifier
    )


@pytest.fixture(scope="module")
def client(container: ServiceContainer) -> TestClient:
    app = create_app(container)
    return TestClient(app)


@pytest.mark.e2e
def test_full_discovery_loop(client: TestClient) -> None:
    # 1. Health check
    health = client.get("/healthz")
    assert health.status_code == 200
    assert health.json() == {"status": "ok"}

    # 2. Catalog info reflects the synced bundle's catalog_meta.json
    info = client.get("/catalog/info")
    assert info.status_code == 200
    body = info.json()
    assert body["catalog_id"] == "e2e-origin"
    assert body["product_count"] == 50

    # 3. Search returns hybrid+reranked results for a real query
    search = client.get("/search", params={"q": "wireless bluetooth headphones", "limit": 10})
    assert search.status_code == 200
    payload = search.json()
    assert payload["query"] == "wireless bluetooth headphones"
    assert payload["total"] >= 1
    result_ids = [r["product"]["id"] for r in payload["results"]]
    assert "B001" in result_ids  # Wireless Bluetooth Headphones in mini_catalog

    # 4. Recommend ranks the whole catalog against an empty profile.
    rec_initial = client.get("/recommend", params={"limit": 50})
    assert rec_initial.status_code == 200
    assert len(rec_initial.json()["results"]) == 50

    # 5. Stateless: the server keeps no session, so a session header changes nothing
    #    and the response carries no per-session state.
    rec_again = client.get("/recommend", params={"limit": 50}, headers={"X-Session-Id": "e2e"})
    assert rec_again.json() == rec_initial.json()
    assert set(rec_again.json()) == {"results"}
