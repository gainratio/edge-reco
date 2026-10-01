"""Unit tests for ``ServiceContainer.from_synced`` (signed-chunk bundle consumer).

A tiny REAL FAISS ``vector/`` index is built once from synthetic embeddings (no
model download — ``VectorIndex.build`` takes the embeddings array directly), staged
alongside a ``products.jsonl``, published into a signed origin via B2a's producer,
then consumed by ``from_synced``. The container must expose the same shape
``from_dirs`` returns: catalog, a working vector index, and a ``CatalogManifest``.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
from edgeproc.bundles.adapters import FilesystemAdapter, HttpAdapter
from edgeproc.bundles.signing import Ed25519Verifier, SignatureError, generate_keypair
from tests.signing import save_seed

from edgereco.api.deps import ServiceContainer, _materialize_bundle, _select_adapter
from edgereco.catalog.models import CatalogManifest, Product
from edgereco.catalog.publish import publish_bundle
from edgereco.embeddings.encoder import ProductEncoder
from edgereco.embeddings.index import VectorIndex
from edgereco.reco.cooccurrence import CooccurrenceMatrix, Neighbor
from edgereco.reco.ranking_config import DEFAULT_RANKING_CONFIG

_DIM = 8
_PRODUCTS = [
    Product(id="P1", title="Wireless Headphones", category="Electronics"),
    Product(id="P2", title="Running Shoes", category="Sports"),
    Product(id="P3", title="Cooking Pot", category="Home & Kitchen"),
]


class _StubEncoder(ProductEncoder):
    """Hermetic query encoder matching the synthetic ``_DIM`` index (no download).

    These bundles ship a synthetic ``_DIM``-wide index, so the consumer's query
    encoder must live in that same space — the real model would fail the
    fail-closed dim check ``from_synced`` now enforces.
    """

    def __init__(self, model_name: str, dim: int = _DIM) -> None:
        self.model_name = model_name
        self._dim = dim

    @property
    def dim(self) -> int:
        return self._dim


def _build_origin(tmp_path: Path) -> tuple[Path, Ed25519Verifier]:
    """Stage a real tiny index + products, publish a signed origin, return verifier."""
    staging = tmp_path / "staging"
    staging.mkdir()
    rng = np.random.default_rng(0)
    embeddings = rng.standard_normal((len(_PRODUCTS), _DIM)).astype(np.float32)
    index = VectorIndex.build(embeddings, [p.id for p in _PRODUCTS], dim=_DIM)
    index.save(staging / "vector")
    products_jsonl = "\n".join(p.model_dump_json() for p in _PRODUCTS) + "\n"
    (staging / "products.jsonl").write_text(products_jsonl, encoding="utf-8")

    private, public = generate_keypair()
    key_path = tmp_path / "private.key"
    save_seed(private.private_bytes_raw(), key_path)
    origin = tmp_path / "origin"
    publish_bundle(
        staging_dir=staging,
        origin_dir=origin,
        private_key_path=key_path,
        catalog_id="unit-origin",
        version="2026-05-27T00:00:00Z",
        embedding_model="sentence-transformers/all-MiniLM-L6-v2",
        embedding_dim=_DIM,
        embedding_count=len(_PRODUCTS),
        product_count=len(_PRODUCTS),
    )
    return origin, Ed25519Verifier(public)


def test_from_synced_builds_container(tmp_path: Path) -> None:
    origin, verifier = _build_origin(tmp_path)

    container = ServiceContainer.from_synced(
        base_url=str(origin),
        cache_root=tmp_path / "cache",
        verifier=verifier,
        encoder_factory=_StubEncoder,
    )

    assert len(container.catalog) == len(_PRODUCTS)
    assert {p.id for p in container.catalog} == {"P1", "P2", "P3"}
    assert container.vector.ntotal == len(_PRODUCTS)
    assert isinstance(container.manifest, CatalogManifest)
    assert container.manifest.catalog_id == "unit-origin"
    assert container.manifest.embedding_dim == _DIM
    # The vector index actually answers a query.
    hits = container.vector.search(np.zeros(_DIM, dtype=np.float32), k=3)
    assert len(hits) == 3


def test_from_synced_defaults_empty_cooccurrence(tmp_path: Path) -> None:
    """A bundle staged without a co-occurrence matrix yields an empty one."""
    origin, verifier = _build_origin(tmp_path)

    container = ServiceContainer.from_synced(
        base_url=str(origin),
        cache_root=tmp_path / "cache",
        verifier=verifier,
        encoder_factory=_StubEncoder,
    )

    assert container.cooccurrence == CooccurrenceMatrix()


def test_from_synced_loads_cooccurrence_from_bundle(tmp_path: Path) -> None:
    """A bundle that ships ``cooccurrence.json`` exposes it on the container."""
    staging = tmp_path / "staging"
    staging.mkdir()
    rng = np.random.default_rng(0)
    embeddings = rng.standard_normal((len(_PRODUCTS), _DIM)).astype(np.float32)
    VectorIndex.build(embeddings, [p.id for p in _PRODUCTS], dim=_DIM).save(staging / "vector")
    (staging / "products.jsonl").write_text(
        "\n".join(p.model_dump_json() for p in _PRODUCTS) + "\n", encoding="utf-8"
    )
    cooc = CooccurrenceMatrix(neighbors={"P1": [Neighbor(id="P2", score=0.7)]})
    (staging / "cooccurrence.json").write_text(cooc.model_dump_json(), encoding="utf-8")

    private, public = generate_keypair()
    key_path = tmp_path / "private.key"
    save_seed(private.private_bytes_raw(), key_path)
    origin = tmp_path / "origin"
    publish_bundle(
        staging_dir=staging,
        origin_dir=origin,
        private_key_path=key_path,
        catalog_id="cooc-origin",
        version="v1",
        embedding_model="m",
        embedding_dim=_DIM,
        embedding_count=len(_PRODUCTS),
        product_count=len(_PRODUCTS),
    )

    container = ServiceContainer.from_synced(
        base_url=str(origin),
        cache_root=tmp_path / "cache",
        verifier=Ed25519Verifier(public),
        encoder_factory=_StubEncoder,
    )
    assert container.cooccurrence == cooc


def test_from_synced_loads_ranking_config_from_bundle(tmp_path: Path) -> None:
    origin, verifier = _build_origin(tmp_path)

    container = ServiceContainer.from_synced(
        base_url=str(origin),
        cache_root=tmp_path / "cache",
        verifier=verifier,
        encoder_factory=_StubEncoder,
    )

    # The producer signs DEFAULT_RANKING_CONFIG into every bundle; the consumer
    # reads its scorer weights from there, not from a module constant.
    assert container.ranking_config == DEFAULT_RANKING_CONFIG


def test_from_synced_falls_back_to_default_when_config_absent(tmp_path: Path) -> None:
    """A bundle that predates ranking_config.json still yields a working container
    by falling back to DEFAULT_RANKING_CONFIG — no fail-closed on a missing file."""
    origin, verifier = _build_origin(tmp_path)
    # Materialize, then delete the config file to mimic a pre-config bundle.
    from edgereco.api.deps import _sync_and_load_manifest

    store, manifest = _sync_and_load_manifest(
        base_url=str(origin), cache_root=tmp_path / "premat", verifier=verifier
    )
    local = _materialize_bundle(store, manifest, tmp_path / "stripped")
    (local / "ranking_config.json").unlink()

    config = ServiceContainer._load_ranking_config(local)
    assert config == DEFAULT_RANKING_CONFIG


def test_load_ranking_config_legacy_bundle_defaults_when_absent(tmp_path: Path) -> None:
    """A genuine pre-feature bundle (legacy meta schema) with no ranking_config.json
    falls back to the default — true backward compat."""
    from edgereco.catalog.publish import CURRENT_META_SCHEMA

    local = tmp_path / "stripped"
    local.mkdir()
    config = ServiceContainer._load_ranking_config(local, meta_schema=CURRENT_META_SCHEMA - 1)
    assert config == DEFAULT_RANKING_CONFIG


def test_load_ranking_config_current_bundle_missing_file_raises(tmp_path: Path) -> None:
    """A CURRENT-schema bundle that is unexpectedly missing ranking_config.json is a
    corruption signal — raise, never silently bake legacy weights into a republish."""
    from edgereco.catalog.publish import CURRENT_META_SCHEMA

    local = tmp_path / "current"
    local.mkdir()
    with pytest.raises(FileNotFoundError):
        ServiceContainer._load_ranking_config(local, meta_schema=CURRENT_META_SCHEMA)


def test_load_cooccurrence_legacy_bundle_defaults_when_absent(tmp_path: Path) -> None:
    """A genuine pre-feature bundle with no cooccurrence.json falls back to empty."""
    from edgereco.catalog.publish import CURRENT_META_SCHEMA

    local = tmp_path / "stripped"
    local.mkdir()
    matrix = ServiceContainer._load_cooccurrence(local, meta_schema=CURRENT_META_SCHEMA - 1)
    assert matrix == CooccurrenceMatrix()


def test_load_cooccurrence_current_bundle_missing_file_raises(tmp_path: Path) -> None:
    """A CURRENT-schema bundle missing cooccurrence.json raises rather than degrading."""
    from edgereco.catalog.publish import CURRENT_META_SCHEMA

    local = tmp_path / "current"
    local.mkdir()
    with pytest.raises(FileNotFoundError):
        ServiceContainer._load_cooccurrence(local, meta_schema=CURRENT_META_SCHEMA)


def test_from_synced_current_bundle_loads_signed_files(tmp_path: Path) -> None:
    """End-to-end: a freshly published (current-schema) bundle carries both files,
    so from_synced loads them without tripping the missing-file guard."""
    origin, verifier = _build_origin(tmp_path)
    container = ServiceContainer.from_synced(
        base_url=str(origin),
        cache_root=tmp_path / "cache",
        verifier=verifier,
        encoder_factory=_StubEncoder,
    )
    assert container.ranking_config == DEFAULT_RANKING_CONFIG


def test_select_adapter_by_scheme(tmp_path: Path) -> None:
    assert isinstance(_select_adapter("https://cdn.example/catalog"), HttpAdapter)
    assert isinstance(_select_adapter("http://cdn.example/catalog"), HttpAdapter)
    assert isinstance(_select_adapter(str(tmp_path)), FilesystemAdapter)


def test_from_synced_fail_closed_on_bad_signature(tmp_path: Path) -> None:
    origin, _ = _build_origin(tmp_path)
    _, wrong_public = generate_keypair()
    with pytest.raises(SignatureError):
        ServiceContainer.from_synced(
            base_url=str(origin),
            cache_root=tmp_path / "cache",
            verifier=Ed25519Verifier(wrong_public),
        )
