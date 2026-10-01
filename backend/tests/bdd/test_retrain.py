"""Step impls for features/retrain.feature (flywheel popularity retrain)."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import pytest
from edgeproc.bundles.signing import Ed25519Verifier, generate_keypair
from pytest_bdd import given, scenarios, then, when

from edgereco.api.deps import sync_and_materialize
from edgereco.catalog.loader import dump_jsonl, load_jsonl
from edgereco.catalog.models import Product
from edgereco.catalog.publish import publish_bundle
from edgereco.reco.retrain import EngagementStat
from edgereco.republish import RetrainResult, retrain_and_republish
from tests.signing import save_seed

scenarios("retrain.feature")

_EQUAL_POPULARITY = 0.3


@dataclass
class StepContext:
    """Mutable state shared across retrain BDD steps."""

    tmp_path: Path
    key_path: Path
    verifier: Ed25519Verifier
    origin: Path | None = None
    engagement: dict[str, EngagementStat] | None = None
    result: RetrainResult | None = None
    republished: dict[str, Product] | None = None


@pytest.fixture
def ctx(tmp_path: Path) -> StepContext:
    private, public = generate_keypair()
    key_path = tmp_path / "private.key"
    save_seed(private.private_bytes_raw(), key_path)
    return StepContext(tmp_path=tmp_path, key_path=key_path, verifier=Ed25519Verifier(public))


@given("a signed catalog bundle with two products of equal popularity")
def _seed_bundle(ctx: StepContext) -> None:
    staging = ctx.tmp_path / "staging"
    (staging / "vector").mkdir(parents=True)
    dump_jsonl(
        staging / "products.jsonl",
        [
            Product(id="P1", title="A", category="C", popularity_score=_EQUAL_POPULARITY),
            Product(id="P2", title="B", category="C", popularity_score=_EQUAL_POPULARITY),
        ],
    )
    (staging / "vector" / "index.faiss").write_bytes(b"\x00FAISS\x01")
    ctx.origin = ctx.tmp_path / "origin"
    publish_bundle(
        staging_dir=staging,
        origin_dir=ctx.origin,
        private_key_path=ctx.key_path,
        catalog_id="retrain-bdd",
        version="v1",
        embedding_model="model",
        embedding_dim=384,
        embedding_count=2,
        product_count=2,
    )


@given("collected engagement that favours one product")
def _engagement(ctx: StepContext) -> None:
    ctx.engagement = {"P1": EngagementStat(product_id="P1", event_count=6, weighted_score=6.0)}


@when("the cloud retrains and republishes the bundle")
def _retrain(ctx: StepContext) -> None:
    ctx.result = retrain_and_republish(
        bundle_base_url=str(ctx.origin),
        origin_dir=ctx.origin,
        private_key_path=ctx.key_path,
        verifier=ctx.verifier,
        engagement=ctx.engagement,
        alpha=0.5,
        cache_root=ctx.tmp_path / "cache",
    )


@then("the republished bundle verifies under the pinned key")
def _verifies(ctx: StepContext) -> None:
    materialized = sync_and_materialize(
        base_url=str(ctx.origin),
        cache_root=ctx.tmp_path / "verify",
        verifier=ctx.verifier,
    )
    ctx.republished = {p.id: p for p in load_jsonl(materialized / "products.jsonl")}
    assert ctx.result.version == "v2"


@then("the favoured product's popularity has increased")
def _favoured_up(ctx: StepContext) -> None:
    assert ctx.republished["P1"].popularity_score > _EQUAL_POPULARITY


@then("the other product's popularity is unchanged")
def _other_unchanged(ctx: StepContext) -> None:
    assert ctx.republished["P2"].popularity_score == _EQUAL_POPULARITY
