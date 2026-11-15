"""Unit tests for sharded 2-bit ``IVF-TurboQuant`` SQLite bundle generation."""

from __future__ import annotations

import json
import sqlite3
import tempfile
from contextlib import closing
from pathlib import Path

import numpy as np
import pytest
import zstandard as zstd
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from edgereco.catalog.publish import publish_bundle
from edgereco.catalog.sharded_bundle import (
    IVF_CENTROIDS_NAME,
    ProductRow,
    build_shard_sqlite,
    product_id_for_shard,
    shard_for_product_id,
    shard_relpath,
)


def _sample_row(rowid: int, product_id: str, category: str = "Electronics") -> ProductRow:
    return (
        rowid,
        product_id,
        f"Title {product_id}",
        "Desc",
        category,
        "wireless audio",
        '["wireless"]',
        "BrandX",
        29.99,
        0.8,
        0.7,
        "/images/NB-00001.svg",
        b"",
    )


def test_shard_relpath_and_id_routing() -> None:
    assert shard_relpath(0) == "shards/shard_00.sqlite"
    assert shard_relpath(63) == "shards/shard_63.sqlite"
    with pytest.raises(ValueError, match="shard_idx"):
        shard_relpath(-1)
    assert product_id_for_shard("NB-00001", 0, 0) == "NB-00001"
    assert product_id_for_shard("B001", 7, 0) == "S07-B001"
    assert product_id_for_shard("B001", 63, 4) == "S63-B001-4"
    assert shard_for_product_id("NB-00001", 64) == 0
    assert shard_for_product_id("S07-B001", 64) == 7
    assert shard_for_product_id("S63-B001-4", 64) == 63
    assert shard_for_product_id("S99-B001", 64) == 0
    assert shard_for_product_id("plain-id", 64) == 0
    assert shard_for_product_id("S07-B001", 1) == 0


def test_build_shard_sqlite_strips_embeddings_and_stores_global_counts() -> None:
    rng = np.random.default_rng(7)
    vecs = rng.standard_normal((8, 384)).astype(np.float32)
    rows = [_sample_row(i, f"S00-item-{i}") for i in range(8)]
    counts = {"": 1_000_000, "Electronics": 120_000}
    payload = build_shard_sqlite(rows, vecs, global_counts=counts)
    with tempfile.NamedTemporaryFile(suffix=".sqlite") as tmp:
        tmp.write(payload)
        tmp.flush()
        with closing(sqlite3.connect(tmp.name)) as conn:
            total, max_emb = conn.execute(
                "SELECT count(*), max(length(embedding)) FROM products"
            ).fetchone()
            assert (total, max_emb) == (8, 0)
            q_rows = conn.execute(
                'SELECT sum(counter) FROM "vector0_products_embedding"'
            ).fetchone()[0]
            assert q_rows == 8
            stored = dict(conn.execute("SELECT category, total FROM _edgereco_global_counts"))
            assert stored == counts


def test_build_shard_sqlite_rejects_mismatched_lengths() -> None:
    rows = [_sample_row(0, "S00-a")]
    vecs = np.zeros((2, 384), dtype=np.float32)
    with pytest.raises(ValueError, match="row count"):
        build_shard_sqlite(rows, vecs)


def test_publish_bundle_sharded_sqlite_only(tmp_path: Path) -> None:
    staging = tmp_path / "staging"
    (staging / "shards").mkdir(parents=True)
    (staging / "images").mkdir(parents=True)
    key_path = tmp_path / "private.key"
    key_path.write_bytes(Ed25519PrivateKey.generate().private_bytes_raw())
    key_path.chmod(0o600)
    vecs = np.ones((4, 384), dtype=np.float32)
    shard_bytes = build_shard_sqlite(
        [_sample_row(i, f"S00-{i}") for i in range(4)],
        vecs,
        global_counts={"": 8},
    )
    (staging / "shards" / "shard_00.sqlite").write_bytes(shard_bytes)
    (staging / "shards" / "shard_01.sqlite").write_bytes(shard_bytes)
    (staging / IVF_CENTROIDS_NAME).write_bytes(np.ones((2, 384), dtype=np.float32).tobytes())
    (staging / "images" / "NB-00001.svg").write_bytes(b"<svg/>")
    origin = tmp_path / "origin"
    publish_bundle(
        staging_dir=staging,
        origin_dir=origin,
        private_key_path=key_path,
        catalog_id="sharded-test",
        version="v1",
        embedding_model="test-model",
        embedding_dim=384,
        embedding_count=8,
        product_count=8,
        sqlite_only=True,
        ivf_shards=2,
    )
    latest = json.loads((origin / "latest").read_text(encoding="utf-8"))
    manifest = json.loads((origin / "manifest" / latest["manifest_hash"]).read_bytes())
    by_path = {entry["path"]: entry for entry in manifest["files"]}
    assert IVF_CENTROIDS_NAME in by_path
    assert "shards/shard_00.sqlite" in by_path
    assert "shards/shard_01.sqlite" in by_path
    dctx = zstd.ZstdDecompressor()
    meta_chunks = by_path["catalog_meta.json"]["chunks"]
    meta_raw = b"".join(
        dctx.decompress((origin / "chunk" / c["hash"]).read_bytes()) for c in meta_chunks
    )
    assert json.loads(meta_raw)["ivf_shards"] == 2
