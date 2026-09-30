"""Generate the Phase-2 per-strategy recommendation parity fixture.

Replays ``reco.recommend`` over the REAL committed bundle in ``examples/catalog`` —
the same files the browser syncs, and the same signed ``ranking_config.json`` (with
its strategy map) both tiers read — for every named strategy, recording the ordered
top-k ``(id, score)`` Python returns. The vector strategies use a FIXED seed product
so the kNN is deterministic. The TS engine test loads this and asserts its in-browser
``recommend({strategy, seed})`` reproduces each strategy's top-k, proving
server<->browser parity for the whole multi-strategy path.

The vector index is reconstructed from the stored ``embeddings.f32`` matrix (NOT by
re-encoding), so Python and the browser rank byte-identical vectors. Profiles are
empty (cold start) so the fixture is deterministic and uplink-free.

Run from backend/, then let Biome settle the JSON formatting::

    .venv/bin/python3 scripts/gen_strategy_fixture.py
    (cd ../frontend && pnpm exec biome check --write \
        packages/edgereco-browser/src/engine/__fixtures__/strategy_parity.json)
"""

from __future__ import annotations

import glob
import hashlib
import json
from pathlib import Path

import numpy as np

from edgereco.catalog.models import Product, SearchResult, SessionProfile
from edgereco.embeddings.index import VectorIndex
from edgereco.reco.ranking_config import RankingConfig
from edgereco.reco.recommend import recommend
from edgereco.search.vector import VectorSearcher

BACKEND_ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = BACKEND_ROOT.parent
CATALOG = BACKEND_ROOT / "examples" / "catalog"
FIXTURE = (
    REPO_ROOT / "frontend/packages/edgereco-browser/src/engine/__fixtures__/strategy_parity.json"
)
DIM = 384
LIMIT = 10
SEED_PRODUCT = "NB-00011"  # faiss row 10 — a stable seed for the vector strategies
STRATEGIES = ("for_you", "trending", "new_arrivals", "similar_items", "because_viewed")


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


def _load() -> tuple[list[Product], VectorSearcher, RankingConfig]:
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
    config = RankingConfig.model_validate_json(_materialize("ranking_config.json"))
    return products, VectorSearcher(index), config


def _case(
    strategy: str,
    products: list[Product],
    by_id: dict[str, Product],
    vector: VectorSearcher,
    config: RankingConfig,
) -> dict[str, object]:
    seed = (
        SEED_PRODUCT
        if config.strategies[strategy].candidate_policy == "vector_similarity"
        else None
    )
    ranked: list[SearchResult] = recommend(
        catalog=products,
        by_id=by_id,
        profile=SessionProfile(),
        config=config,
        vector=vector,
        strategy=strategy,
        seed=seed,
        limit=LIMIT,
    )
    return {
        "strategy": strategy,
        "seed": seed,
        "expected": [{"id": r.product.id, "score": r.score} for r in ranked],
    }


def main() -> None:
    products, vector, config = _load()
    by_id = {p.id: p for p in products}
    fixture = {
        "description": (
            "Phase-2 multi-strategy recommendation parity fixture: for each named strategy "
            "(vector strategies use a fixed seed) the ordered top-k (id, score) edge-reco "
            "Python recommend() returns over the real examples/catalog bundle + its signed "
            "strategy-map ranking_config. Regenerate with scripts/gen_strategy_fixture.py."
        ),
        "limit": LIMIT,
        "seed_product": SEED_PRODUCT,
        "cases": [_case(s, products, by_id, vector, config) for s in STRATEGIES],
    }
    FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE.write_text(json.dumps(fixture, indent="\t") + "\n")
    print(f"wrote {FIXTURE.relative_to(REPO_ROOT)} ({FIXTURE.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
