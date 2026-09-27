"""Generate the Phase-3 co-occurrence recommendation parity fixture.

Replays ``reco.recommend`` over the REAL committed bundle in ``examples/catalog`` —
the same ``products.jsonl`` + signed ``ranking_config.json`` + ``cooccurrence.json``
the browser syncs — for each co-occurrence strategy (``also_bought``,
``frequently_bought_together``) around a FIXED seed product, recording the ordered
top-k ``(id, score)`` Python returns. The TS engine test loads this and asserts its
in-browser ``recommend({strategy, seed})`` reproduces each strategy's top-k, proving
server<->browser parity for the co-occurrence path.

The seed is chosen to have several neighbours so ``frequently_bought_together``'s
tighter cut (top 3) differs from ``also_bought``'s full neighbour list. Profiles are
empty (cold start) so the fixture is deterministic.

Run from backend/, then let Biome settle the JSON formatting::

    .venv/bin/python3 scripts/gen_cooccurrence_fixture.py
    (cd ../frontend && pnpm exec biome check --write \
        packages/edgereco-browser/src/engine/__fixtures__/cooccurrence_parity.json)
"""

from __future__ import annotations

import glob
import hashlib
import json
from pathlib import Path

import numpy as np

from edgereco.catalog.models import Product, SearchResult, SessionProfile
from edgereco.embeddings.index import VectorIndex
from edgereco.reco.cooccurrence import CooccurrenceMatrix
from edgereco.reco.ranking_config import RankingConfig
from edgereco.reco.recommend import recommend
from edgereco.search.vector import VectorSearcher

BACKEND_ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = BACKEND_ROOT.parent
CATALOG = BACKEND_ROOT / "examples" / "catalog"
FIXTURE = (
    REPO_ROOT
    / "frontend/packages/edgereco-browser/src/engine/__fixtures__/cooccurrence_parity.json"
)
DIM = 384
LIMIT = 10
SEED_PRODUCT = "NB-00593"  # a stable seed with several co-occurrence neighbours
STRATEGIES = ("also_bought", "frequently_bought_together")


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


def _load() -> tuple[list[Product], RankingConfig, CooccurrenceMatrix, VectorSearcher]:
    products = [
        Product.model_validate_json(line)
        for line in _materialize("products.jsonl").splitlines()
        if line.strip()
    ]
    config = RankingConfig.model_validate_json(_materialize("ranking_config.json"))
    cooc = CooccurrenceMatrix.model_validate_json(_materialize("cooccurrence.json"))
    return products, config, cooc, _vector()


def _vector() -> VectorSearcher:
    """Reconstruct the bundle's vector index (unused by co-occurrence, kept for the call)."""
    state = json.loads(_materialize("vector/state.json"))
    faiss_ids: list[str] = state["faiss_ids"]
    matrix = np.frombuffer(_materialize("vector/embeddings.f32"), dtype=np.float32)
    embeddings = matrix.reshape(len(faiss_ids), DIM).copy()
    return VectorSearcher(VectorIndex.build(embeddings, faiss_ids, dim=DIM))


def _case(
    strategy: str,
    products: list[Product],
    by_id: dict[str, Product],
    config: RankingConfig,
    cooc: CooccurrenceMatrix,
    vector: VectorSearcher,
) -> dict[str, object]:
    ranked: list[SearchResult] = recommend(
        catalog=products,
        by_id=by_id,
        profile=SessionProfile(),
        config=config,
        vector=vector,
        cooccurrence=cooc,
        strategy=strategy,
        seed=SEED_PRODUCT,
        limit=LIMIT,
    )
    return {
        "strategy": strategy,
        "seed": SEED_PRODUCT,
        "expected": [{"id": r.product.id, "score": r.score} for r in ranked],
    }


def main() -> None:
    products, config, cooc, vector = _load()
    by_id = {p.id: p for p in products}
    fixture = {
        "description": (
            "Phase-3 co-occurrence recommendation parity fixture: for each co-occurrence "
            "strategy around a fixed seed, the ordered top-k (id, score) edge-reco Python "
            "recommend() returns over the real examples/catalog bundle + its signed "
            "cooccurrence.json. Regenerate with scripts/gen_cooccurrence_fixture.py."
        ),
        "limit": LIMIT,
        "seed_product": SEED_PRODUCT,
        "cases": [_case(s, products, by_id, config, cooc, vector) for s in STRATEGIES],
    }
    FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE.write_text(json.dumps(fixture, indent="\t") + "\n")
    print(f"wrote {FIXTURE.relative_to(REPO_ROOT)} ({FIXTURE.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
