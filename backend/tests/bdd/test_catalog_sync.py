"""Step impls for features/catalog_sync.feature (signed chunked-bundle sync)."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from edgeproc.bundles.adapters import FilesystemAdapter
from edgeproc.bundles.cas import FilesystemCacheStore
from edgeproc.bundles.signing import Ed25519Verifier, SignatureError, generate_keypair
from edgeproc.bundles.sync import SyncResult, sync_index
from pytest_bdd import given, scenarios, then, when

from edgereco.catalog.publish import publish_bundle
from tests.signing import save_seed

scenarios("catalog_sync.feature")


@dataclass
class StepContext:
    """Mutable state shared across catalog-sync BDD steps."""

    tmp_path: Path
    key_path: Path
    public: Ed25519PublicKey
    origin: Path | None = None
    origin2: Path | None = None
    store: FilesystemCacheStore | None = None
    result: SyncResult | None = None
    first: SyncResult | None = None
    error: SignatureError | None = None


# A multi-chunk payload: GearCDC needs >= MIN_SIZE (16 KiB) to cut, so make the
# products line long enough that a tail-only edit leaves head chunks identical.
_PADDING = "x" * (300 * 1024)


def _products(tag: str) -> str:
    return f'{{"id":"P1","title":"T {tag}","category":"C","description":"{_PADDING}"}}\n'


def _publish(ctx: StepContext, *, tag: str, version: str, sequence: int = 1) -> Path:
    """Stage products + a dummy vector/ dir and publish a signed origin."""
    staging = ctx.tmp_path / f"staging-{version}"
    (staging / "vector").mkdir(parents=True)
    (staging / "products.jsonl").write_text(_products(tag), encoding="utf-8")
    (staging / "vector" / "index.faiss").write_bytes(b"\x00FAISS\x01")
    origin = ctx.tmp_path / f"origin-{version}"
    publish_bundle(
        staging_dir=staging,
        origin_dir=origin,
        private_key_path=ctx.key_path,
        catalog_id="bdd-origin",
        version=version,
        embedding_model="model",
        embedding_dim=384,
        embedding_count=1,
        product_count=1,
        sequence=sequence,
    )
    return origin


@pytest.fixture
def ctx(tmp_path: Path) -> StepContext:
    private, public = generate_keypair()
    key_path = tmp_path / "private.key"
    save_seed(private.private_bytes_raw(), key_path)
    return StepContext(tmp_path=tmp_path, key_path=key_path, public=public)


@given("a signed bundle origin published with a known key")
def _origin(ctx: StepContext) -> None:
    ctx.origin = _publish(ctx, tag="v1", version="v1")


def _sync(ctx: StepContext, origin: Path, verifier: Ed25519Verifier) -> SyncResult:
    return sync_index(
        base_url=str(origin),
        store=ctx.store,
        adapter=FilesystemAdapter(),
        verifier=verifier,
    )


@when("I sync the bundle into a fresh cache")
def _sync_fresh(ctx: StepContext) -> None:
    ctx.store = FilesystemCacheStore(ctx.tmp_path / "cache")
    ctx.result = _sync(ctx, ctx.origin, Ed25519Verifier(ctx.public))


@given("I have already synced it once into a cache")
def _already_synced(ctx: StepContext) -> None:
    ctx.store = FilesystemCacheStore(ctx.tmp_path / "cache")
    ctx.first = _sync(ctx, ctx.origin, Ed25519Verifier(ctx.public))


@when("the origin republishes a bundle that shares most of its content")
def _republish(ctx: StepContext) -> None:
    ctx.origin2 = _publish(ctx, tag="v2", version="v2", sequence=2)


@when("I sync the new version into the same cache")
def _sync_again(ctx: StepContext) -> None:
    ctx.result = _sync(ctx, ctx.origin2, Ed25519Verifier(ctx.public))


@when("I sync the bundle with the wrong public key")
def _sync_wrong_key(ctx: StepContext) -> None:
    ctx.store = FilesystemCacheStore(ctx.tmp_path / "cache")
    _, wrong_public = generate_keypair()
    try:
        _sync(ctx, ctx.origin, Ed25519Verifier(wrong_public))
    except SignatureError as exc:
        ctx.error = exc


@then("every chunk is fetched and none reused")
def _all_fetched(ctx: StepContext) -> None:
    result: SyncResult = ctx.result
    assert result.chunks_fetched >= 1
    assert result.chunks_reused == 0


@then("the active version is promoted")
def _promoted(ctx: StepContext) -> None:
    pointer = ctx.store.read_active()
    assert pointer is not None
    assert pointer.version == "v1"


@then("at least one chunk is reused from the prior sync")
def _reused(ctx: StepContext) -> None:
    result: SyncResult = ctx.result
    assert result.chunks_reused >= 1, result
    assert result.version == "v2"


@then("a signature error is raised")
def _sig_error(ctx: StepContext) -> None:
    assert isinstance(ctx.error, SignatureError)


@then("no version is promoted")
def _not_promoted(ctx: StepContext) -> None:
    assert ctx.store.read_active() is None
