"""Unit tests for bit-exact 2-bit TurboQuant precomputation and coarse IVF sharding."""

from __future__ import annotations

import sqlite3
from contextlib import closing
from pathlib import Path

import numpy as np

from edgereco.catalog.models import Product
from edgereco.catalog.sqlite_bundle import build_catalogue_sqlite
from edgereco.catalog.turboquant import (
    _beta_interval_moments,
    _beta_pdf_shifted,
    build_rotation_matrix,
    make_turbo_codebook,
    partition_ivf_shards,
    populate_turboquant_shadow,
    quantize_turbo_batch,
)
from edgereco.embeddings.index import VectorIndex

_EXPECTED_C_CODES_HEX = (
    "dab85959514eab61297be82964a5b076a68bb6d39990aaa9a1566f95d1ae6692"
    "8a95af69757fa49545669558198889911aa91b53aa55a6b55c62ab6e61da6d6d"
    "585a996a5d55965dab969e925e9e7ec7b8477ede6550593a2a64da1ae46aad2d"
)


def test_quantize_turbo_batch_matches_c_sqlite_vector_bytes() -> None:
    dim = 384
    int8_vec = np.zeros(dim, dtype=np.float32)
    int8_vec[0] = 120.0
    int8_vec[7] = 80.0
    int8_vec[13] = -95.0

    rotation = build_rotation_matrix(dim=dim, rounds=12)
    centroids, boundaries = make_turbo_codebook(bits=2, dim=dim)
    blob = quantize_turbo_batch(
        int8_vec.reshape(1, dim),
        np.array([0], dtype="<i8"),
        rotation=rotation,
        centroids=centroids,
        boundaries=boundaries,
    )
    assert len(blob) == 108
    assert blob[:8] == b"\x00" * 8
    assert blob[12:].hex() == _EXPECTED_C_CODES_HEX
    scale = float(np.frombuffer(blob[8:12], dtype="<f4")[0])
    c_scale = float(np.frombuffer(bytes.fromhex("1ddaa13f"), dtype="<f4")[0])
    assert np.isclose(scale, c_scale, rtol=1e-6)
    assert _beta_pdf_shifted(-1.0, dim) == 0.0
    assert _beta_interval_moments(0.5, 0.2, dim) == (0.0, 0.0)


def test_populate_turboquant_shadow_strips_raw_embeddings(tmp_path: Path) -> None:
    db_path = tmp_path / "shadow.sqlite"
    rng = np.random.default_rng(7)
    embeddings = rng.standard_normal((10, 16)).astype(np.float32)
    with closing(sqlite3.connect(db_path)) as conn:
        conn.execute("CREATE TABLE products(rowid INTEGER PRIMARY KEY, embedding BLOB NOT NULL)")
        conn.execute(
            "CREATE TABLE _sqliteai_vector "
            "(tblname TEXT, colname TEXT, key TEXT, value ANY, PRIMARY KEY(tblname, colname, key))"
        )
        conn.executemany(
            "INSERT INTO products VALUES (?, ?)",
            [(i, embeddings[i].tobytes()) for i in range(10)],
        )
        populate_turboquant_shadow(conn, embeddings, block_rows=4, strip_raw_embeddings=True)
        qtype = conn.execute(
            "SELECT value FROM _sqliteai_vector "
            "WHERE tblname='products' AND colname='embedding' AND key='qtype'"
        ).fetchone()
        assert qtype == (4,)
        blocks = conn.execute(
            'SELECT rowid1, rowid2, counter, length(data) FROM "vector0_products_embedding" '
            "ORDER BY rowid1"
        ).fetchall()
        assert blocks == [(0, 3, 4, 4 * 16), (4, 7, 4, 4 * 16), (8, 9, 2, 2 * 16)]
        raw_lengths = [
            r[0] for r in conn.execute("SELECT length(embedding) FROM products").fetchall()
        ]
        assert raw_lengths == [0] * 10


def test_build_catalogue_sqlite_prequantize_turbo2(tmp_path: Path) -> None:
    staging = tmp_path / "staging"
    staging.mkdir(parents=True, exist_ok=True)
    dim = 16
    products = [
        Product(
            id=f"P{i}",
            title=f"Product {i}",
            category="Gear",
            tags=["outdoor"],
            brand="Apex",
        )
        for i in range(4)
    ]
    rng = np.random.default_rng(11)
    embeddings = rng.standard_normal((len(products), dim)).astype(np.float32)
    VectorIndex.build(embeddings, [p.id for p in products], dim=dim).save(staging / "vector")
    (staging / "products.jsonl").write_text(
        "\n".join(p.model_dump_json() for p in products) + "\n", encoding="utf-8"
    )

    sqlite_bytes = build_catalogue_sqlite(
        staging,
        embedding_dim=dim,
        embedding_count=len(products),
        prequantize_turbo2=True,
    )
    db_file = tmp_path / "preq.sqlite"
    db_file.write_bytes(sqlite_bytes)
    with closing(sqlite3.connect(db_file)) as conn:
        lengths = [r[0] for r in conn.execute("SELECT length(embedding) FROM products").fetchall()]
        assert lengths == [0, 0, 0, 0]
        total_q = conn.execute('SELECT SUM(counter) FROM "vector0_products_embedding"').fetchone()
        assert total_q == (4,)


def test_partition_ivf_shards_recovers_planted_clusters() -> None:
    rng = np.random.default_rng(99)
    centers = rng.standard_normal((4, 32)).astype(np.float32)
    centers /= np.linalg.norm(centers, axis=1, keepdims=True)
    points = np.vstack(
        [centers[k] + 0.05 * rng.standard_normal((25, 32)).astype(np.float32) for k in range(4)]
    )
    centroids, labels = partition_ivf_shards(points, n_shards=4, max_iter=10, seed=99)
    assert centroids.shape == (4, 32)
    assert labels.shape == (100,)
    assert len(set(labels.tolist())) == 4
