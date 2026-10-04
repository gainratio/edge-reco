"""Vector index — now backed by EdgeProc's FaissVectorIndex (the shared lego).

edge-reco's historical API is synchronous and returns inner-product *similarity*
(higher = nearer). EdgeProc's ``FaissVectorIndex`` is async and returns cosine
*distance* (lower = nearer). This thin adapter bridges both: it runs the async
calls to completion (every edge-reco call site is synchronous) and converts
distance back to similarity, so behavior is identical to the previous in-house
index while the FAISS work is owned by EdgeProc.

On disk, ``vector/`` is EdgeReco's SIGNED BUNDLE format, not edge-proc's persistence
format: exactly ``index.faiss`` + ``state.json`` + ``embeddings.f32``, flat and
deterministic. edge-proc >=0.4.1 persists to crash-atomic ``snapshots/`` generations
(random names, a lock file) and migrates a writable legacy pair into them on load,
deleting the pair. The browser tier reads ``vector/state.json`` and ``embeddings.f32``
straight out of the bundle, so this adapter writes the flat layout itself and loads it
from a private copy, never touching the source directory.
"""

from __future__ import annotations

import asyncio
import tempfile
from pathlib import Path
from typing import Final

import faiss
import numpy as np
from edgeproc.localvec.faiss_index import FaissVectorIndex
from edgeproc_core.vector_mgmt.core.types import IndexConfig, VectorEmbedding
from numpy.typing import NDArray

from edgereco.safe_io import copy_regular_file, write_atomic

_INDEX_NAME = "edgereco"

#: Raw, L2-normalized ``float32`` matrix (``ntotal x dim``, row-major) written next
#: to ``index.faiss``/``state.json`` so a Python-faiss-less tier (the browser) can do
#: cosine search directly. Row ``i`` ↔ ``state.json`` ``faiss_ids[i]`` ↔ product id.
EMBEDDINGS_FILE: Final[str] = "embeddings.f32"
#: The FAISS index and its id-map sidecar, flat beside ``embeddings.f32``.
INDEX_FILE: Final[str] = "index.faiss"
STATE_FILE: Final[str] = "state.json"
#: Upper bound on one ``vector/`` file read by :meth:`VectorIndex.load`. The committed
#: 720 x 384 catalog is about 1.1 MB; 1 GiB leaves room for ~700k rows at 384 dims.
MAX_VECTOR_FILE_BYTES: int = 1024 * 1024 * 1024


class VectorIndex:
    """Synchronous similarity index — a sync facade over EdgeProc's FaissVectorIndex."""

    def __init__(self, inner: FaissVectorIndex) -> None:
        self._inner = inner

    @classmethod
    def build(cls, embeddings: NDArray[np.float32], ids: list[str], *, dim: int) -> VectorIndex:
        inner = FaissVectorIndex(_INDEX_NAME, IndexConfig(dimension=dim))
        items = [
            VectorEmbedding(entity_id=entity_id, embedding=row.tolist())
            for entity_id, row in zip(ids, embeddings, strict=True)
        ]
        asyncio.run(inner.insert(items))
        return cls(inner)

    @property
    def ntotal(self) -> int:
        return asyncio.run(self._inner.get_stats()).vector_count

    def search(self, query: NDArray[np.float32], k: int = 10) -> list[tuple[str, float]]:
        hits = asyncio.run(self._inner.search(query.tolist(), k))
        return [(entity_id, 1.0 - distance) for entity_id, distance in hits]

    def nearest(self, product_id: str, k: int = 10) -> list[tuple[str, float]]:
        """Top-``k`` products nearest the seed's stored vector, seed excluded.

        Reconstructs the seed row (the same L2-normalized vector the browser uses),
        searches ``k+1`` to leave room to drop the seed, and returns descending
        ``(id, cosine)`` pairs. Raises ``KeyError`` if the seed is not indexed.
        """
        seed_vec = self.raw_matrix()[self._row_of(product_id)]
        hits = self.search(seed_vec, k=k + 1)
        return [(pid, score) for pid, score in hits if pid != product_id][:k]

    def _row_of(self, product_id: str) -> int:
        """Row index of ``product_id`` in id-map order (``KeyError`` if absent)."""
        faiss_ids: list[str] = self._inner._faiss_ids
        try:
            return faiss_ids.index(product_id)
        except ValueError as exc:
            raise KeyError(product_id) from exc

    def raw_matrix(self) -> NDArray[np.float32]:
        """Reconstruct the stored vectors as a contiguous ``ntotal x dim`` float32
        matrix in id-map order: row ``i`` is the vector for ``faiss_ids[i]``.

        The inputs are L2-normalized at encode time and ``IndexFlatIP`` stores them
        verbatim, so the reconstruction is the same normalized matrix the browser
        does cosine search over.
        """
        faiss_index = self._inner._faiss  # sync facade owns the inner index
        ntotal = int(faiss_index.ntotal)
        if ntotal == 0:
            return np.empty((0, self._inner.config.dimension), dtype=np.float32)
        matrix = faiss_index.reconstruct_n(0, ntotal)
        return np.ascontiguousarray(matrix, dtype=np.float32)

    def save(self, directory: Path) -> None:
        """Write the flat bundle layout: ``index.faiss``, ``state.json``, ``embeddings.f32``.

        The same bytes edge-proc <=0.4.0 wrote for a saved index, so the committed seed
        bundle, older servers, and the browser all read it unchanged. Deterministic:
        the same index always saves to the same bytes. Each file is written to an
        exclusive, no-follow temp beside it, fsynced, then renamed into place, so a
        planted symlink is replaced rather than written through and a crash never
        leaves a torn file. A symlinked ``directory`` itself is refused.
        """
        if directory.is_symlink():
            raise ValueError(f"refusing to save a vector index into a symlink: {directory}")
        directory.mkdir(parents=True, exist_ok=True)
        index_bytes = faiss.serialize_index(self._inner._faiss).tobytes()
        state = self._inner._persisted_state().model_dump_json().encode("utf-8")
        write_atomic(directory / INDEX_FILE, index_bytes)
        write_atomic(directory / STATE_FILE, state)
        write_atomic(directory / EMBEDDINGS_FILE, self.raw_matrix().tobytes())

    @classmethod
    def load(cls, directory: Path) -> VectorIndex:
        """Load a flat ``vector/`` without modifying it.

        edge-proc migrates the legacy pair it is handed, so it is handed a private
        copy; the index lives in memory afterwards and the copy is discarded. Each
        source is opened once, no-follow, must be a regular file no larger than
        ``MAX_VECTOR_FILE_BYTES``, and is copied from that same descriptor.
        """
        with tempfile.TemporaryDirectory(prefix="edgereco-vector-") as scratch:
            for name in (INDEX_FILE, STATE_FILE):
                copy_regular_file(
                    directory / name,
                    Path(scratch) / name,
                    label=f"vector/{name}",
                    max_bytes=MAX_VECTOR_FILE_BYTES,
                )
            return cls(FaissVectorIndex.load(_INDEX_NAME, Path(scratch)))
