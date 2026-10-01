"""Integration test: retrain_and_republish end-to-end over a local origin.

Builds a tiny signed origin (dummy ``vector/`` — the retrain reuses it verbatim
and never loads FAISS, so no encoder/model is needed), folds in stubbed
engagement, republishes, then re-syncs the republished origin to prove (a) it is
validly signed (fail-closed verifier passes) and (b) the recomputed popularity
round-tripped through the bundle.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from edgeproc.bundles.manifest import VersionPointer
from edgeproc.bundles.signing import Ed25519Verifier, generate_keypair

from edgereco.api.deps import sync_and_materialize
from edgereco.catalog.loader import dump_jsonl, load_jsonl
from edgereco.catalog.models import Product
from edgereco.catalog.publish import publish_bundle
from edgereco.reco.retrain import EngagementStat
from edgereco.republish import retrain_and_republish
from tests.signing import save_seed


def _seed_origin(tmp: Path, key_path: Path) -> Path:
    """Publish a tiny signed v1 bundle (dummy vector/) to an origin dir."""
    staging = tmp / "seed-staging"
    (staging / "vector").mkdir(parents=True)
    dump_jsonl(
        staging / "products.jsonl",
        [
            Product(id="P1", title="Alpha", category="Electronics", popularity_score=0.2),
            Product(id="P2", title="Beta", category="Electronics", popularity_score=0.5),
        ],
    )
    (staging / "vector" / "embeddings.f32").write_bytes(b"\x00" * 16)
    (staging / "vector" / "state.json").write_text('{"faiss_ids": ["P1", "P2"]}')
    origin = tmp / "origin"
    publish_bundle(
        staging_dir=staging,
        origin_dir=origin,
        private_key_path=key_path,
        catalog_id="retrain-test",
        version="v1",
        embedding_model="sentence-transformers/all-MiniLM-L6-v2",
        embedding_dim=384,
        embedding_count=2,
        product_count=2,
    )
    return origin


@pytest.fixture
def keypair(tmp_path: Path) -> tuple[Path, Ed25519Verifier]:
    private, public = generate_keypair()
    key_path = tmp_path / "private.key"
    save_seed(private.private_bytes_raw(), key_path)
    return key_path, Ed25519Verifier(public)


def test_retrain_republishes_signed_bundle_with_boosted_popularity(
    tmp_path: Path, keypair: tuple[Path, Ed25519Verifier]
) -> None:
    key_path, verifier = keypair
    origin = _seed_origin(tmp_path, key_path)

    result = retrain_and_republish(
        bundle_base_url=str(origin),
        origin_dir=origin,
        private_key_path=key_path,
        verifier=verifier,
        engagement={"P1": EngagementStat(product_id="P1", event_count=5, weighted_score=5.0)},
        alpha=0.5,
        cache_root=tmp_path / "cache",
    )

    # Version bumped, and only the engaged product is reported as changed.
    assert result.version == "v2"
    assert result.product_count == 2
    assert [d.product_id for d in result.changed] == ["P1"]
    assert result.changed[0].before == 0.2
    assert result.changed[0].after == 0.7
    pointer = VersionPointer.model_validate_json((origin / "latest").read_bytes())
    assert pointer.sequence == 2

    # Re-sync the republished origin: a passing verifier proves it is validly
    # signed (fail-closed intact); the catalog carries the recomputed popularity.
    materialized = sync_and_materialize(
        base_url=str(origin), cache_root=tmp_path / "verify-cache", verifier=verifier
    )
    by_id = {p.id: p for p in load_jsonl(materialized / "products.jsonl")}
    assert by_id["P1"].popularity_score == 0.7
    assert by_id["P2"].popularity_score == 0.5  # untouched


def test_retrain_sequence_climbs_past_what_the_target_origin_already_serves(
    tmp_path: Path, keypair: tuple[Path, Ed25519Verifier]
) -> None:
    """Syncing from one origin and republishing into another must still climb.

    The synced source is at sequence 1, but the target origin already serves sequence
    7 (an earlier retrain, or a rebuild). ``active + 1`` would sign sequence 2 there —
    a release every returning shopper refuses as a rollback — so the next sequence is
    one more than the HIGHER of the two.
    """
    key_path, verifier = keypair
    source = _seed_origin(tmp_path, key_path)
    target = tmp_path / "target"
    staging = tmp_path / "target-staging"
    (staging / "vector").mkdir(parents=True)
    dump_jsonl(staging / "products.jsonl", [Product(id="P1", title="Old", category="Books")])
    (staging / "vector" / "embeddings.f32").write_bytes(b"\x00" * 16)
    publish_bundle(
        staging_dir=staging,
        origin_dir=target,
        private_key_path=key_path,
        catalog_id="retrain-test",
        version="v9",
        embedding_model="sentence-transformers/all-MiniLM-L6-v2",
        embedding_dim=384,
        embedding_count=1,
        product_count=1,
        sequence=7,
    )

    retrain_and_republish(
        bundle_base_url=str(source),
        origin_dir=target,
        private_key_path=key_path,
        verifier=verifier,
        engagement={},
        alpha=0.5,
        cache_root=tmp_path / "cache",
    )

    pointer = VersionPointer.model_validate_json((target / "latest").read_bytes())
    assert pointer.sequence == 8


def test_retrain_recomputes_cooccurrence_into_bundle(
    tmp_path: Path, keypair: tuple[Path, Ed25519Verifier]
) -> None:
    """Sessions passed to retrain produce a signed ``cooccurrence.json`` in the bundle."""
    from edgereco.reco.cooccurrence import CooccurrenceMatrix

    key_path, verifier = keypair
    origin = _seed_origin(tmp_path, key_path)

    retrain_and_republish(
        bundle_base_url=str(origin),
        origin_dir=origin,
        private_key_path=key_path,
        verifier=verifier,
        engagement={},
        alpha=0.5,
        cache_root=tmp_path / "cache",
        sessions=[[("P1", "cart"), ("P2", "cart")], [("P1", "click"), ("P2", "click")]],
    )

    materialized = sync_and_materialize(
        base_url=str(origin), cache_root=tmp_path / "verify-cache", verifier=verifier
    )
    cooc = CooccurrenceMatrix.model_validate_json((materialized / "cooccurrence.json").read_bytes())
    # P1 and P2 co-occur in both sessions → each is the other's neighbour.
    assert {n.id for n in cooc.neighbors["P1"]} == {"P2"}
    assert {n.id for n in cooc.neighbors["P2"]} == {"P1"}


def test_retrain_preserves_tuned_ranking_config(
    tmp_path: Path, keypair: tuple[Path, Ed25519Verifier]
) -> None:
    """A retrain of a bundle whose ranking_config was tuned must republish the SAME
    tuned weights — never silently revert to DEFAULT_RANKING_CONFIG."""
    from edgereco.reco.ranking_config import DEFAULT_RANKING_CONFIG, RankingConfig

    key_path, verifier = keypair
    # Seed a bundle carrying a tuned ranking_config.json.
    staging = tmp_path / "seed-staging"
    (staging / "vector").mkdir(parents=True)
    dump_jsonl(
        staging / "products.jsonl",
        [Product(id="P1", title="Alpha", category="Electronics", popularity_score=0.2)],
    )
    (staging / "vector" / "embeddings.f32").write_bytes(b"\x00" * 16)
    (staging / "vector" / "state.json").write_text('{"faiss_ids": ["P1"]}')
    tuned = DEFAULT_RANKING_CONFIG.model_copy(deep=True)
    tuned.scoring_weights.popularity = 0.55
    (staging / "ranking_config.json").write_text(tuned.model_dump_json(), encoding="utf-8")
    origin = tmp_path / "origin"
    publish_bundle(
        staging_dir=staging,
        origin_dir=origin,
        private_key_path=key_path,
        catalog_id="retrain-test",
        version="v1",
        embedding_model="m",
        embedding_dim=384,
        embedding_count=1,
        product_count=1,
    )

    retrain_and_republish(
        bundle_base_url=str(origin),
        origin_dir=origin,
        private_key_path=key_path,
        verifier=verifier,
        engagement={},
        alpha=0.5,
        cache_root=tmp_path / "cache",
    )

    materialized = sync_and_materialize(
        base_url=str(origin), cache_root=tmp_path / "verify-cache", verifier=verifier
    )
    republished = RankingConfig.model_validate_json(
        (materialized / "ranking_config.json").read_bytes()
    )
    assert republished == tuned
    assert republished != DEFAULT_RANKING_CONFIG


def test_retrain_without_sessions_stages_empty_cooccurrence(
    tmp_path: Path, keypair: tuple[Path, Ed25519Verifier]
) -> None:
    """No sessions → an empty co-occurrence matrix (popularity-only retrain still works)."""
    from edgereco.reco.cooccurrence import CooccurrenceMatrix

    key_path, verifier = keypair
    origin = _seed_origin(tmp_path, key_path)

    retrain_and_republish(
        bundle_base_url=str(origin),
        origin_dir=origin,
        private_key_path=key_path,
        verifier=verifier,
        engagement={},
        alpha=0.5,
        cache_root=tmp_path / "cache",
    )

    materialized = sync_and_materialize(
        base_url=str(origin), cache_root=tmp_path / "verify-cache", verifier=verifier
    )
    cooc = CooccurrenceMatrix.model_validate_json((materialized / "cooccurrence.json").read_bytes())
    assert cooc == CooccurrenceMatrix()
