"""Regenerate the C2b vector-search parity fixture.

Materializes the real signed bundle under ``examples/catalog/`` (the same files
the browser syncs), reconstructs the L2-normalized ``embeddings.f32`` matrix and
the ``state.json`` row->id map, builds edge-reco's ``VectorIndex`` over them, and
records a normalized synthetic query vector together with the ordered top-k
``(id, cosine score)`` that Python returns. The TS engine test loads this fixture
and asserts its in-browser ``search`` produces the same ordering — proving
TS<->Python search parity over the real index.

Run from backend/, then let Biome settle the JSON formatting::

    .venv/bin/python3 scripts/gen_search_fixture.py
    (cd ../frontend && pnpm exec biome check --write \
        packages/edgereco-browser/src/engine/__fixtures__/search_parity.json)
"""

from __future__ import annotations

import glob
import hashlib
import json
from pathlib import Path

import numpy as np
import zstandard as zstd

from edgereco.embeddings.index import VectorIndex

BACKEND_ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = BACKEND_ROOT.parent
CATALOG = REPO_ROOT / "frontend/packages/edgereco-browser/src/engine/__fixtures__/bundle/catalog"
FIXTURE = (
    REPO_ROOT / "frontend/packages/edgereco-browser/src/engine/__fixtures__/search_parity.json"
)
DIM = 384
TOP_K = 10
SEED = 42


def _materialize(path: str) -> bytes:
    """Reassemble a bundle file from its zstd chunks, checking its sha256."""
    manifest = json.loads(Path(glob.glob(str(CATALOG / "manifest" / "*"))[0]).read_bytes())
    entry = next(f for f in manifest["files"] if f["path"] == path)
    dctx = zstd.ZstdDecompressor()
    parts = [
        dctx.decompress((CATALOG / "chunk" / ref["hash"]).read_bytes()) for ref in entry["chunks"]
    ]
    blob = b"".join(parts)
    if hashlib.sha256(blob).hexdigest() != entry["file_sha256"]:
        raise ValueError(f"{path} failed reassembly check")
    return blob


def _load_index() -> tuple[VectorIndex, list[str], np.ndarray]:
    state = json.loads(_materialize("vector/state.json"))
    faiss_ids: list[str] = state["faiss_ids"]
    matrix = np.frombuffer(_materialize("vector/embeddings.f32"), dtype=np.float32)
    embeddings = matrix.reshape(len(faiss_ids), DIM).copy()
    return VectorIndex.build(embeddings, faiss_ids, dim=DIM), faiss_ids, embeddings


def _query_vector(embeddings: np.ndarray) -> np.ndarray:
    """A normalized synthetic direction blended from two rows plus noise.

    Not identical to any stored row, so the parity check is non-trivial.
    """
    rng = np.random.default_rng(SEED)
    raw = (
        0.6 * embeddings[10]
        + 0.4 * embeddings[200]
        + 0.05 * rng.standard_normal(DIM).astype(np.float32)
    )
    return (raw / np.linalg.norm(raw)).astype(np.float32)


def main() -> None:
    index, _faiss_ids, embeddings = _load_index()
    query = _query_vector(embeddings)
    hits = index.search(query, k=TOP_K)
    fixture = {
        "description": (
            "C2b vector-search parity fixture: a normalized synthetic query vector and the "
            "ordered top-k (id, cosine score) that edge-reco Python VectorSearcher returns over "
            "the real examples/catalog embeddings.f32. "
            "Regenerate with scripts/gen_search_fixture.py."
        ),
        "embedding_dim": DIM,
        "k": TOP_K,
        "query_vector": query.tolist(),
        "expected": [{"id": pid, "score": float(score)} for pid, score in hits],
    }
    FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    # Tab-indented + trailing newline so the committed fixture already matches the
    # frontend Biome formatter (tab indent style) and stays stable on regeneration.
    FIXTURE.write_text(json.dumps(fixture, indent="\t") + "\n")
    print(f"wrote {FIXTURE.relative_to(REPO_ROOT)} ({FIXTURE.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
