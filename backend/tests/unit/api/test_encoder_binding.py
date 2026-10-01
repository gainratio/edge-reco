"""The container's query encoder must be bound to the bundle's declared model.

A bundle ships a PREBUILT vector index computed with a specific embedding model;
queries must be encoded in that same space. ``from_synced`` / ``from_dirs`` must
therefore construct the encoder from the bundle/manifest metadata — never a
silent hardcoded default — and fail closed (typed, logged) when the declared
``embedding_dim`` contradicts the encoder. Tests stay hermetic via the
``encoder_factory`` seam: a stub records the bound model, no model download.
"""

from __future__ import annotations

import logging
from pathlib import Path

import numpy as np
import pytest
from edgeproc.bundles.signing import Ed25519Verifier, generate_keypair
from tests.signing import save_seed

from edgereco.api.deps import EmbeddingModelMismatchError, ServiceContainer
from edgereco.catalog.models import CatalogManifest, Product
from edgereco.catalog.publish import publish_bundle
from edgereco.embeddings.encoder import DEFAULT_MODEL_NAME, ProductEncoder
from edgereco.embeddings.index import VectorIndex

_DIM = 8
_MODEL = "acme/stub-embedder-v2"
_PRODUCTS = [
    Product(id="P1", title="Wireless Headphones", category="Electronics"),
    Product(id="P2", title="Running Shoes", category="Sports"),
]


class _StubEncoder(ProductEncoder):
    """Hermetic stand-in: records the bound model name, never loads a real model."""

    def __init__(self, model_name: str, dim: int = _DIM) -> None:
        self.model_name = model_name
        self._dim = dim

    @property
    def dim(self) -> int:
        return self._dim


def _save_index(dest: Path) -> None:
    rng = np.random.default_rng(0)
    embeddings = rng.standard_normal((len(_PRODUCTS), _DIM)).astype(np.float32)
    VectorIndex.build(embeddings, [p.id for p in _PRODUCTS], dim=_DIM).save(dest)


def _build_origin(tmp_path: Path) -> tuple[Path, Ed25519Verifier]:
    """Publish a signed origin whose meta declares ``_MODEL`` at ``_DIM``."""
    staging = tmp_path / "staging"
    staging.mkdir()
    _save_index(staging / "vector")
    (staging / "products.jsonl").write_text(
        "\n".join(p.model_dump_json() for p in _PRODUCTS) + "\n", encoding="utf-8"
    )
    private, public = generate_keypair()
    key_path = tmp_path / "private.key"
    save_seed(private.private_bytes_raw(), key_path)
    origin = tmp_path / "origin"
    publish_bundle(
        staging_dir=staging,
        origin_dir=origin,
        private_key_path=key_path,
        catalog_id="binding-origin",
        version="v1",
        embedding_model=_MODEL,
        embedding_dim=_DIM,
        embedding_count=len(_PRODUCTS),
        product_count=len(_PRODUCTS),
    )
    return origin, Ed25519Verifier(public)


def _dirs(tmp_path: Path, *, embedding_model: str) -> tuple[Path, Path]:
    """A legacy flat cache_dir + index_dir pair whose manifest declares a model."""
    cache_dir = tmp_path / "cache_dir"
    cache_dir.mkdir()
    (cache_dir / "products.jsonl").write_text(
        "\n".join(p.model_dump_json() for p in _PRODUCTS) + "\n", encoding="utf-8"
    )
    manifest = CatalogManifest(
        catalog_id="dirs-catalog",
        version="v1",
        embedding_model=embedding_model,
        embedding_dim=_DIM,
        files=[],
    )
    (cache_dir / "manifest.json").write_text(manifest.model_dump_json(), encoding="utf-8")
    index_dir = tmp_path / "index_dir"
    _save_index(index_dir / "vector")
    return cache_dir, index_dir


def test_from_synced_binds_encoder_to_declared_bundle_model(tmp_path: Path) -> None:
    origin, verifier = _build_origin(tmp_path)

    container = ServiceContainer.from_synced(
        base_url=str(origin),
        cache_root=tmp_path / "cache",
        verifier=verifier,
        encoder_factory=_StubEncoder,
    )

    assert isinstance(container.encoder, _StubEncoder)
    assert container.encoder.model_name == _MODEL


def test_from_synced_dim_mismatch_raises_typed_logged_error(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """A declared dim that contradicts the encoder is a fail-closed error, never
    a silent wrong-space default."""
    origin, verifier = _build_origin(tmp_path)

    def _wrong_dim_factory(model_name: str) -> ProductEncoder:
        return _StubEncoder(model_name, dim=_DIM + 1)

    with (
        caplog.at_level(logging.ERROR, logger="edgereco.api.deps"),
        pytest.raises(EmbeddingModelMismatchError, match=r"embedding_dim=8"),
    ):
        ServiceContainer.from_synced(
            base_url=str(origin),
            cache_root=tmp_path / "cache",
            verifier=verifier,
            encoder_factory=_wrong_dim_factory,
        )
    assert any("wrong embedding space" in r.message for r in caplog.records)


def test_from_dirs_binds_encoder_to_manifest_model(tmp_path: Path) -> None:
    cache_dir, index_dir = _dirs(tmp_path, embedding_model=_MODEL)

    container = ServiceContainer.from_dirs(cache_dir, index_dir, encoder_factory=_StubEncoder)

    assert isinstance(container.encoder, _StubEncoder)
    assert container.encoder.model_name == _MODEL


def test_from_dirs_legacy_manifest_without_model_is_explicit_logged_default(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """No declared model (legacy meta) binds the default model as an explicit,
    logged decision — not an accidental hardcoded fallback."""
    cache_dir, index_dir = _dirs(tmp_path, embedding_model="")

    with caplog.at_level(logging.WARNING, logger="edgereco.api.deps"):
        container = ServiceContainer.from_dirs(cache_dir, index_dir, encoder_factory=_StubEncoder)

    assert isinstance(container.encoder, _StubEncoder)
    assert container.encoder.model_name == DEFAULT_MODEL_NAME
    assert any("declares no embedding model" in r.message for r in caplog.records)
