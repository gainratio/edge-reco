"""Unit tests for canonical ``catalogue.sqlite`` bundle staging and generation."""

from __future__ import annotations

import json
import sqlite3
from contextlib import closing
from pathlib import Path

import numpy as np
import pytest
from edgeproc.bundles.adapters import FilesystemAdapter
from edgeproc.bundles.cas import FilesystemCacheStore
from edgeproc.bundles.signing import Ed25519Verifier, generate_keypair
from edgeproc.bundles.sqlite import is_sqlite_bytes
from edgeproc.bundles.sync import materialize_file, sync_index
from tests.signing import save_seed

from edgereco.catalog.models import Product
from edgereco.catalog.publish import publish_bundle
from edgereco.catalog.sqlite_bundle import (
    CATALOGUE_SQLITE_NAME,
    build_catalogue_sqlite,
    can_stage_catalogue_sqlite,
)
from edgereco.embeddings.index import VectorIndex

_DIM = 8
_PRODUCTS = [
    Product(
        id="P1",
        title="Wireless Noise-Cancelling Headphones",
        description="Over-ear Bluetooth headphones",
        category="Electronics",
        tags=["audio", "wireless"],
        brand="Nimbus",
        price=199.99,
        popularity_score=0.9,
        freshness_score=0.8,
    ),
    Product(
        id="P2",
        title="Trail Running Shoes",
        description="Lightweight mountain runners",
        category="Sports",
        tags=["running", "outdoor"],
        brand="Stride",
        price=129.50,
        popularity_score=0.75,
        freshness_score=0.65,
    ),
]


def _stage_real_catalog(tmp_path: Path, name: str = "staging") -> Path:
    staging = tmp_path / name
    staging.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(42)
    embeddings = rng.standard_normal((len(_PRODUCTS), _DIM)).astype(np.float32)
    VectorIndex.build(embeddings, [p.id for p in _PRODUCTS], dim=_DIM).save(staging / "vector")
    products_jsonl = "\n".join(p.model_dump_json() for p in _PRODUCTS) + "\n"
    (staging / "products.jsonl").write_text(products_jsonl, encoding="utf-8")
    return staging


def test_build_catalogue_sqlite_populates_products_fts_and_canonical_pages(
    tmp_path: Path,
) -> None:
    staging = _stage_real_catalog(tmp_path)
    assert can_stage_catalogue_sqlite(staging, embedding_dim=_DIM, embedding_count=len(_PRODUCTS))

    first = build_catalogue_sqlite(staging, embedding_dim=_DIM, embedding_count=len(_PRODUCTS))
    second = build_catalogue_sqlite(staging, embedding_dim=_DIM, embedding_count=len(_PRODUCTS))
    assert first == second
    assert is_sqlite_bytes(first)
    assert len(first) % 4096 == 0

    db_file = tmp_path / "check.sqlite"
    db_file.write_bytes(first)
    with closing(sqlite3.connect(db_file)) as conn:
        rows = conn.execute(
            "SELECT rowid, id, title, category, tags, tags_json, brand, price, length(embedding) "
            "FROM products ORDER BY rowid ASC"
        ).fetchall()
        assert len(rows) == 2
        assert rows[0] == (
            0,
            "P1",
            "Wireless Noise-Cancelling Headphones",
            "Electronics",
            "audio wireless",
            '["audio","wireless"]',
            "Nimbus",
            199.99,
            _DIM * 4,
        )
        fts_hits = conn.execute(
            "SELECT p.id FROM products_fts JOIN products p ON p.rowid = products_fts.rowid "
            "WHERE products_fts MATCH 'headphones'"
        ).fetchall()
        assert fts_hits == [("P1",)]


def test_publish_bundle_signs_and_syncs_catalogue_sqlite(tmp_path: Path) -> None:
    staging = _stage_real_catalog(tmp_path)
    origin = tmp_path / "origin"
    private, public = generate_keypair()
    key_path = tmp_path / "private.key"
    save_seed(private.private_bytes_raw(), key_path)

    publish_bundle(
        staging_dir=staging,
        origin_dir=origin,
        private_key_path=key_path,
        catalog_id="amazon-demo",
        version="v1",
        embedding_model="sentence-transformers/all-MiniLM-L6-v2",
        embedding_dim=_DIM,
        embedding_count=len(_PRODUCTS),
        product_count=len(_PRODUCTS),
    )

    cache = FilesystemCacheStore(tmp_path / "cache")
    sync_index(
        base_url=str(origin),
        store=cache,
        adapter=FilesystemAdapter(),
        verifier=Ed25519Verifier(public),
    )
    pointer = cache.read_active()
    assert pointer is not None
    manifest = cache._load_manifest(pointer.manifest_hash)
    paths = {entry.path for entry in manifest.files}
    assert CATALOGUE_SQLITE_NAME in paths

    sqlite_bytes = materialize_file(cache, manifest, CATALOGUE_SQLITE_NAME)
    assert is_sqlite_bytes(sqlite_bytes)
    assert len(sqlite_bytes) % 4096 == 0


def test_can_stage_catalogue_sqlite_rejects_mismatched_or_corrupt_inputs(
    tmp_path: Path,
) -> None:
    staging = _stage_real_catalog(tmp_path)
    assert not can_stage_catalogue_sqlite(
        staging, embedding_dim=384, embedding_count=len(_PRODUCTS)
    )

    (staging / "vector" / "state.json").write_text("{not-json", encoding="utf-8")
    assert not can_stage_catalogue_sqlite(
        staging, embedding_dim=_DIM, embedding_count=len(_PRODUCTS)
    )
    with pytest.raises(json.JSONDecodeError):
        build_catalogue_sqlite(staging, embedding_dim=_DIM, embedding_count=len(_PRODUCTS))

    (staging / "vector" / "state.json").write_text(
        json.dumps({"faiss_ids": ["P1"]}), encoding="utf-8"
    )
    with pytest.raises(ValueError, match="faiss_ids length"):
        build_catalogue_sqlite(staging, embedding_dim=_DIM, embedding_count=len(_PRODUCTS))

    (staging / "vector" / "state.json").write_text(
        json.dumps({"faiss_ids": ["P1", "P2"]}), encoding="utf-8"
    )
    (staging / "vector" / "embeddings.f32").write_bytes(b"\x00" * 8)
    with pytest.raises(ValueError, match=r"embeddings\.f32 has 8 bytes"):
        build_catalogue_sqlite(staging, embedding_dim=_DIM, embedding_count=len(_PRODUCTS))


def test_publish_bundle_sqlite_only_quantizes_int8_and_omits_redundant_files(
    tmp_path: Path,
) -> None:
    staging = _stage_real_catalog(tmp_path)
    origin = tmp_path / "origin"
    private, public = generate_keypair()
    key_path = tmp_path / "private.key"
    save_seed(private.private_bytes_raw(), key_path)

    publish_bundle(
        staging_dir=staging,
        origin_dir=origin,
        private_key_path=key_path,
        catalog_id="amazon-demo",
        version="v1",
        embedding_model="sentence-transformers/all-MiniLM-L6-v2",
        embedding_dim=_DIM,
        embedding_count=len(_PRODUCTS),
        product_count=len(_PRODUCTS),
        sqlite_only=True,
    )

    cache = FilesystemCacheStore(tmp_path / "cache")
    sync_index(
        base_url=str(origin),
        store=cache,
        adapter=FilesystemAdapter(),
        verifier=Ed25519Verifier(public),
    )
    pointer = cache.read_active()
    assert pointer is not None
    manifest = cache._load_manifest(pointer.manifest_hash)
    paths = {entry.path for entry in manifest.files}
    assert CATALOGUE_SQLITE_NAME in paths
    assert "products.jsonl" not in paths
    assert "vector/embeddings.f32" not in paths
    assert "vector/index.faiss" not in paths

    sqlite_bytes = materialize_file(cache, manifest, CATALOGUE_SQLITE_NAME)
    db_file = tmp_path / "int8.sqlite"
    db_file.write_bytes(sqlite_bytes)
    with closing(sqlite3.connect(db_file)) as conn:
        lengths = [
            row[0]
            for row in conn.execute("SELECT length(embedding) FROM products").fetchall()
        ]
        assert lengths == [_DIM, _DIM]

