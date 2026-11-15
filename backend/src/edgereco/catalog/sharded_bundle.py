"""Build canonical 2-bit ``IVF-TurboQuant`` SQLite shards and coarse centroid tables.

Partitions large catalogs (up to 1,000,000 products) into ``K`` self-contained SQLite
shards (``shards/shard_00.sqlite`` .. ``shards/shard_{K-1:02d}.sqlite``) behind one
``ivf_centroids.f32`` float32 router:

- Shard ``0`` holds curated ``NB-*`` shelf exemplars plus Voronoi cell ``0`` items, and
  carries ``_edgereco_global_counts`` so ``browseSql`` reports exact global and
  per-department counts at cold boot before any extra shard is fetched.
- Every non-``NB`` item in shard ``s`` carries the deterministic ``S{s:02d}-`` ID prefix
  so ``productsByIds``, PDP deep links, and ``nearest(id, k)`` resolve the target shard
  in ``O(1)`` with zero extra lookup-table bytes.
"""

from __future__ import annotations

import re
import sqlite3
import tempfile
from collections.abc import Mapping, Sequence
from contextlib import closing
from pathlib import Path
from typing import Final

import numpy as np
from edgeproc.bundles.sqlite import canonicalize_sqlite
from numpy.typing import NDArray

from edgereco.catalog.sqlite_bundle import _INSERT_PRODUCT_SQL, _SCHEMA_STATEMENTS
from edgereco.catalog.turboquant import populate_turboquant_shadow

IVF_CENTROIDS_NAME: Final[str] = "ivf_centroids.f32"
SHARDS_SUBDIR: Final[str] = "shards"
GLOBAL_COUNTS_TABLE: Final[str] = "_edgereco_global_counts"

type ProductRow = tuple[int, str, str, str, str, str, str, float, float, float, str, bytes]


def shard_relpath(shard_idx: int) -> str:
    """Return the manifest-relative path for ``shard_idx`` (``shards/shard_XX.sqlite``)."""
    if shard_idx < 0:
        raise ValueError(f"shard_idx must be >= 0, got {shard_idx}")
    return f"{SHARDS_SUBDIR}/shard_{shard_idx:02d}.sqlite"


def product_id_for_shard(base_id: str, shard_idx: int, variant: int = 0) -> str:
    """Stamp deterministic shard routing prefix onto non-``NB`` product IDs."""
    if base_id.startswith("NB-") and variant == 0:
        return base_id
    suffix = "" if variant == 0 else f"-{variant}"
    return f"S{shard_idx:02d}-{base_id}{suffix}"


_SHARD_PREFIX_RE: Final[re.Pattern[str]] = re.compile(r"^S(\d{2})-")


def shard_for_product_id(product_id: str, n_shards: int = 64) -> int:
    """Resolve the owning shard index ``0 .. n_shards-1`` in ``O(1)`` from ``product_id``."""
    match = _SHARD_PREFIX_RE.match(product_id) if n_shards > 1 else None
    if match is None:
        return 0
    idx = int(match.group(1))
    return idx if idx < n_shards else 0


def _write_global_counts(conn: sqlite3.Connection, global_counts: Mapping[str, int]) -> None:
    conn.execute(
        "CREATE TABLE _edgereco_global_counts (category TEXT PRIMARY KEY, total INTEGER NOT NULL)"
    )
    conn.executemany(
        "INSERT INTO _edgereco_global_counts VALUES (?, ?)",
        sorted(global_counts.items()),
    )


def _populate_shard_connection(
    conn: sqlite3.Connection,
    rows: Sequence[ProductRow],
    embeddings: NDArray[np.float32],
    global_counts: Mapping[str, int] | None,
) -> None:
    conn.execute("PRAGMA page_size = 4096")
    conn.execute("PRAGMA journal_mode = DELETE")
    with conn:
        for statement in _SCHEMA_STATEMENTS:
            conn.execute(statement)
        conn.executemany(_INSERT_PRODUCT_SQL, rows)
        conn.execute("INSERT INTO products_fts(products_fts) VALUES ('rebuild')")
        conn.execute("INSERT INTO products_fts(products_fts) VALUES ('optimize')")
        populate_turboquant_shadow(conn, embeddings, strip_raw_embeddings=True)
        if global_counts is not None:
            _write_global_counts(conn, global_counts)


def build_shard_sqlite(
    rows: Sequence[ProductRow],
    embeddings: NDArray[np.float32],
    *,
    global_counts: Mapping[str, int] | None = None,
) -> bytes:
    """Build and canonicalize one pre-quantized 2-bit ``IVF-TurboQuant`` SQLite shard."""
    if len(rows) != len(embeddings):
        raise ValueError(f"row count {len(rows)} != embedding count {len(embeddings)}")
    with tempfile.TemporaryDirectory(prefix="edgereco-shard-") as tmp:
        db_path = Path(tmp) / "shard.sqlite"
        with closing(sqlite3.connect(db_path)) as conn:
            _populate_shard_connection(conn, rows, embeddings, global_counts)
        return canonicalize_sqlite(db_path)
