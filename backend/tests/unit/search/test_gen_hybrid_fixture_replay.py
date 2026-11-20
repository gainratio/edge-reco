"""Regression: the C3a hybrid fixture generator must replay /search's scoring.

The parity gate went red on hybrid_parity.json
because scripts/gen_hybrid_fixture.py called the retrieval-less ``rerank`` while
the /search route (api/routes/search.py) — and the browser engine the fixture
arbitrates against — blend normalized RRF retrieval via ``rerank_search``. The
generator must produce byte-for-byte the scoring path it documents replaying.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path
from types import ModuleType

import numpy as np
from numpy.typing import NDArray

from edgereco.catalog.models import Product, SearchResult, SessionProfile
from edgereco.reco.reranker import rerank_search, retrieval_evidence
from edgereco.search.hybrid import weighted_reciprocal_rank_fusion

_SCRIPT = Path(__file__).parents[3] / "scripts" / "gen_hybrid_fixture.py"


def _load_script() -> ModuleType:
    spec = importlib.util.spec_from_file_location("gen_hybrid_fixture", _SCRIPT)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class _StubEncoder:
    """encode_query stand-in; the stub vector searcher ignores the vector."""

    def encode_query(self, query: str) -> NDArray[np.float32]:
        del query
        return np.zeros(4, dtype=np.float32)


class _StubKeyword:
    def __init__(self, hits: list[tuple[str, float]]) -> None:
        self._hits = hits

    def search(self, query: str, *, k: int) -> list[tuple[str, float]]:
        del query
        return self._hits[:k]


class _StubVector:
    def __init__(self, hits: list[tuple[str, float]]) -> None:
        self._hits = hits

    def search(self, query_embedding: NDArray[np.float32], *, k: int) -> list[tuple[str, float]]:
        del query_embedding
        return self._hits[:k]


def _product(pid: str, popularity: float, freshness: float) -> Product:
    return Product(
        id=pid,
        title=f"product {pid}",
        category="apparel",
        popularity_score=popularity,
        freshness_score=freshness,
    )


def test_search_replays_the_route_reranker() -> None:
    """_search must equal RRF + rerank_search — the /search scoring path.

    The data is built so retrieval blending changes the ORDER, not just the
    scores: "b" holds the top fused RRF rank but the lower product prior, so a
    retrieval-less rerank puts "a" first while the route's blend puts "b" first.
    """
    products = [_product("a", 0.9, 0.5), _product("b", 0.8, 0.3)]
    keyword_hits = [("b", 3.0)]
    vector_hits = [("b", 0.99), ("a", 0.61)]

    script = _load_script()
    # _search is the script-internal seam under test.
    got_results, got_total = script._search(
        "polo shirt",
        products,
        _StubVector(vector_hits),
        _StubKeyword(keyword_hits),
        _StubEncoder(),
    )

    by_id = {p.id: p for p in products}
    fused = weighted_reciprocal_rank_fusion(keyword_hits, vector_hits)
    pool = [SearchResult(product=by_id[pid], score=score) for pid, score in fused]
    evidence = retrieval_evidence(keyword_hits, vector_hits)
    expected = rerank_search(pool, SessionProfile(), evidence)[: script.LIMIT]

    # `total` is the post-floor survivor count the route reports, not the fused count.
    assert got_total == len(expected)
    assert [r.product.id for r in got_results] == [r.product.id for r in expected]
    assert [r.score for r in got_results] == [r.score for r in expected]
