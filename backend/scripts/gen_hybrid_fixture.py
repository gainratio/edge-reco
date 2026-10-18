"""Generate the C3a end-to-end hybrid-search parity fixture.

Replays /search (backend/src/edgereco/api/routes/search.py) over the REAL
committed bundle in backend/examples/catalog — the same files the browser
syncs — for a set of query strings, and records the ordered top-k product ids
plus fused RRF scores Python returns. The TS engine.search(queryString) test
loads this and asserts its in-browser pipeline (transformers.js embed -> BM25
+ vector -> RRF -> empty-profile rerank) reproduces the same top-k, proving
server<->browser parity for the whole hybrid path, not just the embedder.

The vector index is reconstructed from the stored embeddings.f32 matrix (NOT by
re-encoding products) so Python and the browser search byte-identical vectors;
the only cross-engine difference is the query embedder, which C3a's Step-1 gate
pins at cosine ~ 1.

Run from backend/::

    .venv/bin/python3 scripts/gen_hybrid_fixture.py
    (cd ../frontend && pnpm exec biome check --write \
        packages/edgereco-browser/src/engine/__fixtures__/hybrid_parity.json)
"""

from __future__ import annotations

import glob
import hashlib
import json
import os
from pathlib import Path

import numpy as np

from edgereco.catalog.models import Product, SearchResult, SessionProfile
from edgereco.embeddings.encoder import ProductEncoder
from edgereco.embeddings.index import VectorIndex
from edgereco.reco.reranker import rerank_search, retrieval_evidence
from edgereco.search.hybrid import reciprocal_rank_fusion
from edgereco.search.keyword import KeywordSearcher
from edgereco.search.vector import VectorSearcher

BACKEND_ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = BACKEND_ROOT.parent
CATALOG = REPO_ROOT / "frontend/packages/edgereco-browser/src/engine/__fixtures__/bundle/catalog"
FIXTURE = (
    REPO_ROOT / "frontend/packages/edgereco-browser/src/engine/__fixtures__/hybrid_parity.json"
)
DIM = 384
LIMIT = 10
QUERIES = [
    "polo shirt",
    "men's running shoes",
    "cotton t-shirt",
    "moisture wicking golf polo",
]


def _materialize(path: str) -> bytes:
    manifest = json.loads(Path(glob.glob(str(CATALOG / "manifest" / "*"))[0]).read_bytes())
    entry = next(f for f in manifest["files"] if f["path"] == path)
    import zstandard as zstd

    dctx = zstd.ZstdDecompressor()
    parts = [dctx.decompress((CATALOG / "chunk" / r["hash"]).read_bytes()) for r in entry["chunks"]]
    blob = b"".join(parts)
    if hashlib.sha256(blob).hexdigest() != entry["file_sha256"]:
        raise ValueError(f"{path} failed reassembly check")
    return blob


def _load() -> tuple[list[Product], VectorSearcher, KeywordSearcher, ProductEncoder]:
    state = json.loads(_materialize("vector/state.json"))
    faiss_ids: list[str] = state["faiss_ids"]
    matrix = np.frombuffer(_materialize("vector/embeddings.f32"), dtype=np.float32)
    embeddings = matrix.reshape(len(faiss_ids), DIM).copy()
    index = VectorIndex.build(embeddings, faiss_ids, dim=DIM)
    products = [
        Product.model_validate_json(line)
        for line in _materialize("products.jsonl").splitlines()
        if line.strip()
    ]
    return products, VectorSearcher(index), KeywordSearcher.build(products), ProductEncoder()


def _search(
    query: str,
    products: list[Product],
    vector: VectorSearcher,
    keyword: KeywordSearcher,
    encoder: ProductEncoder,
) -> tuple[list[SearchResult], int]:
    by_id = {p.id: p for p in products}
    k = max(LIMIT * 3, 30)
    keyword_hits = keyword.search(query, k=k)
    vector_hits = vector.search(encoder.encode_query(query), k=k)
    fused = reciprocal_rank_fusion(keyword_hits, vector_hits)
    results = [
        SearchResult(product=by_id[pid], score=score) for pid, score in fused if pid in by_id
    ]
    # /search blends normalized RRF retrieval into the session rerank behind an
    # absolute relevance floor (rerank_search, api/routes/search.py) — the fixture
    # must replay THAT path, which is also what the browser engine mirrors. `total`
    # counts survivors of the floor, exactly as the route reports it.
    results = rerank_search(
        results, SessionProfile(), retrieval_evidence(keyword_hits, vector_hits)
    )
    return results[:LIMIT], len(results)


def main() -> None:
    # Build-machine opt-in (edge-proc >=0.4.0 never downloads a model implicitly):
    # this generator embeds with the real sentence-transformers weights, so it may
    # fetch them once. A configured EDGEPROC_MODEL_PATH still wins, and loads offline.
    os.environ.setdefault("EDGEPROC_ALLOW_MODEL_DOWNLOAD", "1")
    products, vector, keyword, encoder = _load()
    cases = []
    for query in QUERIES:
        results, total = _search(query, products, vector, keyword, encoder)
        cases.append(
            {
                "query": query,
                "total": total,
                "expected": [{"id": r.product.id, "score": r.score} for r in results],
            }
        )
    fixture = {
        "description": (
            "C3a hybrid-search parity fixture: edge-reco /search top-k (id, "
            "reranked score) over examples/catalog for each query, with an empty "
            "session profile. Regenerate with scripts/gen_hybrid_fixture.py."
        ),
        "limit": LIMIT,
        "cases": cases,
    }
    FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE.write_text(json.dumps(fixture, indent="\t") + "\n")
    print(f"wrote {FIXTURE.relative_to(REPO_ROOT)} ({FIXTURE.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
