"""Build a canonical single-file ``catalogue.sqlite`` database for the signed bundle.

Materializes the staged ``products.jsonl``, ``vector/state.json``, and
``vector/embeddings.f32`` into one SQLite database containing:

- ``products``: one row per product in ``faiss_ids`` row order (``rowid = 0 .. N-1``),
  with display/scoring fields and its ``embedding`` float32 ``BLOB``.
- ``products_fts``: pre-populated FTS5 external-content index over ``products``
  (``title``, ``category``, ``tags``, ``brand``) with the ``unicode61`` tokenizer.

The resulting file is canonicalized via ``edgeproc.bundles.sqlite.canonicalize_sqlite``
(``journal_mode=DELETE``, ``page_size=4096``, ``VACUUM``, zeroed volatile header
change counters) so Gear-CDC chunks align with 4 KiB SQLite B-tree pages and
``@gainratio/browser``'s ``importDatabase`` can swap the database in place without
rebuilding FTS5 in the browser on cold boot.
"""

from __future__ import annotations

import json
import sqlite3
import tempfile
from contextlib import closing
from pathlib import Path
from typing import Final

import numpy as np
from edgeproc.bundles.sqlite import canonicalize_sqlite

from edgereco.catalog.models import Product

CATALOGUE_SQLITE_NAME: Final[str] = "catalogue.sqlite"
_FLOAT32_BYTES: Final[int] = 4

_SCHEMA_STATEMENTS: Final[tuple[str, ...]] = (
    """CREATE TABLE products(
        rowid INTEGER PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL,
        tags TEXT NOT NULL,
        tags_json TEXT NOT NULL DEFAULT '[]',
        brand TEXT NOT NULL,
        price REAL NOT NULL DEFAULT 0,
        popularity_score REAL NOT NULL DEFAULT 0,
        freshness_score REAL NOT NULL DEFAULT 0,
        image_url TEXT NOT NULL DEFAULT '',
        embedding BLOB NOT NULL
    )""",
    "CREATE INDEX idx_products_category_rowid ON products(category, rowid)",
    "CREATE INDEX idx_products_popularity ON products(popularity_score DESC, rowid ASC)",
    "CREATE INDEX idx_products_freshness ON products(freshness_score DESC, rowid ASC)",
    """CREATE VIRTUAL TABLE products_fts USING fts5(
        title, category, tags, brand,
        content = 'products', content_rowid = 'rowid',
        tokenize = "unicode61 remove_diacritics 2 tokenchars '-'''"
    )""",
    """CREATE TABLE _sqliteai_vector (
        tblname TEXT,
        colname TEXT,
        key TEXT,
        value ANY,
        PRIMARY KEY(tblname, colname, key)
    )""",
)

_INSERT_PRODUCT_SQL: Final[str] = (
    "INSERT INTO products VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
)


def can_stage_catalogue_sqlite(
    staging_dir: Path, *, embedding_dim: int, embedding_count: int
) -> bool:
    """Return ``True`` when ``staging_dir`` carries a complete ``faiss_ids`` + float32 matrix."""
    state_path = staging_dir / "vector" / "state.json"
    emb_path = staging_dir / "vector" / "embeddings.f32"
    expected_bytes = embedding_count * embedding_dim * _FLOAT32_BYTES
    if not (_is_regular_file(state_path) and _is_regular_file(emb_path)):
        return False
    return emb_path.stat().st_size == expected_bytes and _has_faiss_ids(state_path, embedding_count)


def _is_regular_file(path: Path) -> bool:
    return path.is_file() and not path.is_symlink()


def _has_faiss_ids(state_path: Path, expected_count: int) -> bool:
    try:
        raw = json.loads(state_path.read_text(encoding="utf-8"))
    except ValueError:
        return False
    ids = raw.get("faiss_ids") if isinstance(raw, dict) else None
    return isinstance(ids, list) and len(ids) == expected_count


def _quantize_embeddings_int8(embeddings: bytes, count: int, dim: int) -> bytes:
    """Quantize L2-normalized float32 embeddings to per-row symmetric int8."""
    matrix = np.frombuffer(embeddings, dtype=np.float32).reshape(count, dim)
    max_abs = np.max(np.abs(matrix), axis=1, keepdims=True)
    scale = np.where(max_abs > 0, 127.0 / max_abs, 0.0)
    return np.clip(np.round(matrix * scale), -127, 127).astype(np.int8).tobytes()


def build_catalogue_sqlite(
    staging_dir: Path,
    *,
    embedding_dim: int,
    embedding_count: int,
    quantize_int8: bool = False,
) -> bytes:
    """Build and return canonical ``catalogue.sqlite`` bytes from ``staging_dir``."""
    products_by_id = _load_staged_products(staging_dir / "products.jsonl")
    ids = _load_faiss_ids(staging_dir / "vector" / "state.json", embedding_count)
    embeddings = (staging_dir / "vector" / "embeddings.f32").read_bytes()
    f32_row_bytes = embedding_dim * _FLOAT32_BYTES
    if len(embeddings) != len(ids) * f32_row_bytes:
        raise ValueError(
            f"embeddings.f32 has {len(embeddings)} bytes; expected {len(ids) * f32_row_bytes}"
        )
    if quantize_int8:
        vector_bytes = _quantize_embeddings_int8(embeddings, len(ids), embedding_dim)
        row_bytes = embedding_dim
    else:
        vector_bytes = embeddings
        row_bytes = f32_row_bytes
    rows = [
        _product_row(
            row_idx,
            product_id,
            products_by_id.get(product_id),
            vector_bytes,
            row_bytes,
            compact=quantize_int8 and row_idx >= 720,
        )
        for row_idx, product_id in enumerate(ids)
    ]
    return _write_canonical_sqlite(rows)


def _load_staged_products(products_path: Path) -> dict[str, Product]:
    products: dict[str, Product] = {}
    for line in products_path.read_text(encoding="utf-8").split("\n"):
        if line.strip():
            product = Product.model_validate_json(line)
            products[product.id] = product
    return products


def _load_faiss_ids(state_path: Path, expected_count: int) -> list[str]:
    raw = json.loads(state_path.read_text(encoding="utf-8"))
    ids = raw.get("faiss_ids") if isinstance(raw, dict) else None
    if not isinstance(ids, list) or len(ids) != expected_count:
        raise ValueError(f"vector/state.json faiss_ids length != {expected_count}")
    return [str(item) for item in ids]


def _resolve_row_tags(product: Product, *, compact: bool) -> list[str]:
    if not compact:
        return product.tags
    if product.tags:
        return [t[:12] for t in product.tags[:1]]
    return [product.category.split()[0].lower()] if product.category else []


def _product_row(
    row_idx: int,
    product_id: str,
    product: Product | None,
    embeddings: bytes,
    row_bytes: int,
    *,
    compact: bool = False,
) -> tuple[int, str, str, str, str, str, str, str, float, float, float, str, bytes]:
    resolved = product or Product(id=product_id, title="", category="")
    start = row_idx * row_bytes
    vector_blob = embeddings[start : start + row_bytes]
    title = resolved.title[:52].strip() if compact else resolved.title
    description = "" if compact else resolved.description
    tags = _resolve_row_tags(resolved, compact=compact)
    brand = resolved.brand[:14].strip() if compact else resolved.brand
    return (
        row_idx,
        product_id,
        title,
        description,
        resolved.category,
        " ".join(tags),
        json.dumps(tags, ensure_ascii=False, separators=(",", ":")),
        brand,
        float(resolved.price or 0.0),
        float(resolved.popularity_score),
        float(resolved.freshness_score),
        resolved.image_url,
        vector_blob,
    )


def _write_canonical_sqlite(
    rows: list[tuple[int, str, str, str, str, str, str, str, float, float, float, str, bytes]],
) -> bytes:
    with tempfile.TemporaryDirectory(prefix="edgereco-sqlite-") as tmp:
        db_path = Path(tmp) / CATALOGUE_SQLITE_NAME
        with closing(sqlite3.connect(db_path)) as conn:
            conn.execute("PRAGMA page_size = 4096")
            conn.execute("PRAGMA journal_mode = DELETE")
            with conn:
                for statement in _SCHEMA_STATEMENTS:
                    conn.execute(statement)
                conn.executemany(_INSERT_PRODUCT_SQL, rows)
                conn.execute("INSERT INTO products_fts(products_fts) VALUES ('rebuild')")
                conn.execute("INSERT INTO products_fts(products_fts) VALUES ('optimize')")
        return canonicalize_sqlite(db_path)
