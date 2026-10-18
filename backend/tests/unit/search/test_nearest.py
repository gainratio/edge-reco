"""Seed-based vector kNN: ``VectorIndex.nearest`` / ``VectorSearcher.nearest``.

The Phase-2 ``vector_similarity`` candidate policy needs the nearest products to a
*given* product (a seed on the PDP / "because you viewed this" rail), not to a free
query vector. ``nearest`` reconstructs the seed's stored vector, searches, and drops
the seed itself, returning ``(id, cosine)`` pairs. These tests pin the contract on a
tiny synthetic index and over the real committed ``examples/catalog`` vectors.
"""

from __future__ import annotations

import glob
import hashlib
import json
from pathlib import Path

import numpy as np
import pytest
import zstandard as zstd

from edgereco.embeddings.index import VectorIndex
from edgereco.search.vector import VectorSearcher

_CATALOG = (
    Path(__file__).resolve().parents[4]
    / "frontend"
    / "packages"
    / "edgereco-browser"
    / "src"
    / "engine"
    / "__fixtures__"
    / "bundle"
    / "catalog"
)
_DIM = 384


def _materialize(path: str) -> bytes:
    manifest = json.loads(Path(glob.glob(str(_CATALOG / "manifest" / "*"))[0]).read_bytes())
    entry = next(f for f in manifest["files"] if f["path"] == path)
    dctx = zstd.ZstdDecompressor()
    parts = [
        dctx.decompress((_CATALOG / "chunk" / r["hash"]).read_bytes()) for r in entry["chunks"]
    ]
    blob = b"".join(parts)
    if hashlib.sha256(blob).hexdigest() != entry["file_sha256"]:
        raise ValueError(f"{path} failed reassembly check")
    return blob


def _real_index() -> tuple[VectorIndex, list[str]]:
    state = json.loads(_materialize("vector/state.json"))
    faiss_ids: list[str] = state["faiss_ids"]
    matrix = np.frombuffer(_materialize("vector/embeddings.f32"), dtype=np.float32)
    embeddings = matrix.reshape(len(faiss_ids), _DIM).copy()
    return VectorIndex.build(embeddings, faiss_ids, dim=_DIM), faiss_ids


def test_nearest_excludes_the_seed_itself() -> None:
    dim = 4
    embeddings = np.eye(3, dim, dtype=np.float32)
    index = VectorIndex.build(embeddings, ["a", "b", "c"], dim=dim)
    hits = index.nearest("a", k=2)
    assert "a" not in [pid for pid, _ in hits]
    assert len(hits) == 2


def test_nearest_returns_descending_cosine() -> None:
    dim = 4
    embeddings = np.eye(3, dim, dtype=np.float32)
    index = VectorIndex.build(embeddings, ["a", "b", "c"], dim=dim)
    scores = [score for _, score in index.nearest("a", k=2)]
    assert scores == sorted(scores, reverse=True)


def test_nearest_unknown_seed_raises() -> None:
    index = VectorIndex.build(np.eye(2, 4, dtype=np.float32), ["a", "b"], dim=4)
    with pytest.raises(KeyError):
        index.nearest("missing", k=1)


def test_nearest_over_real_catalog_self_is_top_match_excluded() -> None:
    index, faiss_ids = _real_index()
    seed = faiss_ids[10]
    hits = index.nearest(seed, k=5)
    ids = [pid for pid, _ in hits]
    assert seed not in ids
    assert len(ids) == 5
    # cosine similarities are in [-1, 1] and descending
    scores = [s for _, s in hits]
    assert scores == sorted(scores, reverse=True)
    assert all(-1.01 <= s <= 1.01 for s in scores)


def test_vector_searcher_nearest_delegates() -> None:
    index = VectorIndex.build(np.eye(3, 4, dtype=np.float32), ["a", "b", "c"], dim=4)
    searcher = VectorSearcher(index)
    assert searcher.nearest("a", k=2) == index.nearest("a", k=2)
