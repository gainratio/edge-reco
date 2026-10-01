"""Unit tests for the bundle PRODUCER (edge-proc ``build_bundle`` wrapper).

A tiny synthetic staging dir stands in for a real built catalog (no model
download): a small ``products.jsonl`` plus a ``vector/`` dir of dummy bytes. The
producer is content-agnostic, so dummy FAISS artifacts exercise the full path.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from avow import content_hash, verify_signature
from edgeproc.bundles.adapters import FilesystemAdapter
from edgeproc.bundles.cas import FilesystemCacheStore
from edgeproc.bundles.manifest import IndexManifest, VersionPointer
from edgeproc.bundles.signing import (
    Ed25519Verifier,
    SignatureError,
    generate_keypair,
)
from edgeproc.bundles.sync import materialize_file, sync_index
from tests.signing import save_seed
from typer.testing import CliRunner

from edgereco.catalog.product_image import ImageMode
from edgereco.catalog.publish import BUNDLE_FILES, CURRENT_META_SCHEMA, publish_bundle
from edgereco.cli import app
from edgereco.reco.cooccurrence import CooccurrenceMatrix, Neighbor
from edgereco.reco.ranking_config import DEFAULT_RANKING_CONFIG, RankingConfig
from edgereco.reco.score_receipt import RANKING_RECEIPT_NAME, RankingReceipt

runner = CliRunner()

_PRODUCTS = '{"id":"P1","title":"Widget","category":"Electronics"}\n'
#: What the producer signs: every product's ``image_url`` points at its local card.
_LOCALIZED_PRODUCTS = (
    '{"id":"P1","title":"Widget","category":"Electronics","image_url":"/images/P1.svg"}\n'
)
_FAISS_INDEX = b"\x00FAISS-INDEX-BYTES\x01"
_FAISS_STATE = b'{"id_map": ["P1"]}'
_EMBEDDINGS = b"\x00\x00\x80\x3f" * 4  # 4 float32 1.0s — opaque to the producer


def _staging(tmp_path: Path) -> Path:
    """A tiny built-catalog staging dir: products.jsonl + vector/<dummy files>."""
    staging = tmp_path / "staging"
    (staging / "vector").mkdir(parents=True)
    (staging / "products.jsonl").write_text(_PRODUCTS, encoding="utf-8")
    (staging / "vector" / "index.faiss").write_bytes(_FAISS_INDEX)
    (staging / "vector" / "state.json").write_bytes(_FAISS_STATE)
    (staging / "vector" / "embeddings.f32").write_bytes(_EMBEDDINGS)
    return staging


def _active_manifest(cache: FilesystemCacheStore) -> IndexManifest:
    """Load the manifest for the store's freshly-promoted active pointer."""
    pointer = cache.read_active()
    assert pointer is not None  # sync_index promotes an active version or raises
    return cache._load_manifest(pointer.manifest_hash)


def test_produces_consumable_signed_origin(tmp_path: Path) -> None:
    staging = _staging(tmp_path)
    origin = tmp_path / "origin"
    private, public = generate_keypair()
    key_path = tmp_path / "private.key"
    save_seed(private.private_bytes_raw(), key_path)

    publish_bundle(
        staging_dir=staging,
        origin_dir=origin,
        private_key_path=key_path,
        catalog_id="amazon-demo",
        version="2026-05-27T00:00:00Z",
        embedding_model="sentence-transformers/all-MiniLM-L6-v2",
        embedding_dim=384,
        embedding_count=1,
        product_count=1,
    )

    pointer = VersionPointer.model_validate_json((origin / "latest").read_bytes())
    assert pointer.bundle_id == "amazon-demo"
    assert pointer.channel == "stable"
    assert pointer.sequence == 1

    cache = FilesystemCacheStore(tmp_path / "cache")
    sync_index(
        base_url=str(origin),
        store=cache,
        adapter=FilesystemAdapter(),
        verifier=Ed25519Verifier(public),
    )
    manifest = _active_manifest(cache)

    assert materialize_file(cache, manifest, "products.jsonl") == _LOCALIZED_PRODUCTS.encode(
        "utf-8"
    )
    assert materialize_file(cache, manifest, "vector/index.faiss") == _FAISS_INDEX
    assert materialize_file(cache, manifest, "vector/state.json") == _FAISS_STATE
    assert materialize_file(cache, manifest, "vector/embeddings.f32") == _EMBEDDINGS
    meta = json.loads(materialize_file(cache, manifest, "catalog_meta.json"))
    assert {
        "products.jsonl",
        "vector/index.faiss",
        "vector/state.json",
        "vector/embeddings.f32",
        "catalog_meta.json",
        "ranking_config.json",
        "ranking_receipt.json",
        "cooccurrence.json",
        # The producer bakes one card per product and signs it alongside the catalog.
        "images/P1.svg",
    } == {entry.path for entry in manifest.files}
    assert meta["catalog_id"] == "amazon-demo"


def test_republish_at_the_same_sequence_with_new_content_is_a_client_rollback(
    tmp_path: Path,
) -> None:
    """Republishing changed content at an UNCHANGED sequence bricks existing clients.

    A synced client refuses an incoming pointer whose sequence EQUALS its stored one
    but whose manifest hash differs — that shape is a publisher equivocating at a single
    sequence, so ``sync.ts`` calls it a rollback and throws
    ``refusing sequence N over active sequence N``. Promotion only ever moves the
    sequence UP, so a client bricked that way can never recover on its own.

    This pins the publisher side of that contract: content change MUST come with a
    sequence bump. It is the exact defect that stranded returning visitors on
    edge-reco.com after the bundle was rebuilt in place at sequence 1.
    """
    private, _ = generate_keypair()
    key_path = tmp_path / "private.key"
    save_seed(private.private_bytes_raw(), key_path)

    def publish(products: str, sequence: int, origin: Path) -> VersionPointer:
        staging = _staging(tmp_path / f"s{sequence}{origin.name}")
        (staging / "products.jsonl").write_text(products, encoding="utf-8")
        publish_bundle(
            staging_dir=staging,
            origin_dir=origin,
            private_key_path=key_path,
            catalog_id="amazon-demo",
            version="v1",
            embedding_model="m",
            embedding_dim=384,
            embedding_count=1,
            product_count=1,
            sequence=sequence,
        )
        return VersionPointer.model_validate_json((origin / "latest").read_bytes())

    first = publish(_PRODUCTS, 1, tmp_path / "o1")
    changed = publish(
        '{"id":"P1","title":"Widget MK2","category":"Electronics"}\n', 1, tmp_path / "o2"
    )

    # Same sequence, different identity == the shape a client refuses.
    assert changed.sequence == first.sequence
    assert changed.manifest_hash != first.manifest_hash

    # The supported fix is a strictly greater sequence, which promotes cleanly.
    bumped = publish(
        '{"id":"P1","title":"Widget MK2","category":"Electronics"}\n', 2, tmp_path / "o3"
    )
    assert bumped.sequence > first.sequence


_REMOTE_PRODUCTS = (
    '{"id":"P1","title":"Widget","category":"Electronics",'
    '"image_url":"https://m.media-amazon.com/images/I/71abc.jpg"}\n'
)


def test_remote_mode_leaves_the_catalog_urls_untouched(tmp_path: Path) -> None:
    """In REMOTE mode the producer must NOT rewrite ``image_url``.

    Path A serves the third-party photo directly, which only works if the raw CDN url
    survives publish AND the deployed CSP lists that host. Rewriting it to a local
    card here is exactly what would make the mode look broken (placeholders forever),
    so the no-rewrite is the property under test.
    """
    staging = _staging(tmp_path)
    (staging / "products.jsonl").write_text(_REMOTE_PRODUCTS, encoding="utf-8")
    origin = tmp_path / "origin"
    private, public = generate_keypair()
    key_path = tmp_path / "private.key"
    save_seed(private.private_bytes_raw(), key_path)

    publish_bundle(
        staging_dir=staging,
        origin_dir=origin,
        private_key_path=key_path,
        catalog_id="amazon-demo",
        version="v1",
        embedding_model="m",
        embedding_dim=384,
        embedding_count=1,
        product_count=1,
        image_mode=ImageMode.REMOTE,
    )

    cache = FilesystemCacheStore(tmp_path / "cache")
    sync_index(
        base_url=str(origin),
        store=cache,
        adapter=FilesystemAdapter(),
        verifier=Ed25519Verifier(public),
    )
    manifest = _active_manifest(cache)
    record = json.loads(materialize_file(cache, manifest, "products.jsonl").decode("utf-8"))

    assert record["image_url"] == "https://m.media-amazon.com/images/I/71abc.jpg"
    # And no placeholder card was invented for a product that renders remotely.
    assert not any(entry.path.startswith("images/") for entry in manifest.files)


def test_local_mode_is_the_default(tmp_path: Path) -> None:
    """Omitting the switch must give the PRIVACY-preserving mode.

    The storefront's headline claim is that nothing leaves the browser; a remote photo
    request on page load hands every visitor's IP to a third party. So the safe mode is
    the one you get by default, and REMOTE has to be asked for explicitly.
    """
    staging = _staging(tmp_path)
    (staging / "products.jsonl").write_text(_REMOTE_PRODUCTS, encoding="utf-8")
    origin = tmp_path / "origin"
    private, public = generate_keypair()
    key_path = tmp_path / "private.key"
    save_seed(private.private_bytes_raw(), key_path)

    publish_bundle(  # no image_mode argument
        staging_dir=staging,
        origin_dir=origin,
        private_key_path=key_path,
        catalog_id="amazon-demo",
        version="v1",
        embedding_model="m",
        embedding_dim=384,
        embedding_count=1,
        product_count=1,
    )

    cache = FilesystemCacheStore(tmp_path / "cache")
    sync_index(
        base_url=str(origin),
        store=cache,
        adapter=FilesystemAdapter(),
        verifier=Ed25519Verifier(public),
    )
    manifest = _active_manifest(cache)
    record = json.loads(materialize_file(cache, manifest, "products.jsonl").decode("utf-8"))
    assert record["image_url"] == "/images/P1.svg"


def test_publish_prefers_a_staged_real_photo_over_the_generated_card(tmp_path: Path) -> None:
    """A REAL product photo staged by the build must survive publish and own the url.

    The generated SVG card is the FALLBACK, not the default: when the build step has
    localized an actual product photo into ``images/<id>.<ext>``, the producer must
    point ``image_url`` at that file and leave its bytes alone — not overwrite it with
    a placeholder and not emit a competing ``.svg`` for the same product.
    """
    staging = _staging(tmp_path)
    photo = b"\xff\xd8\xff\xe0" + b"real-jpeg-body" * 8  # JPEG magic + body
    (staging / "images").mkdir()
    (staging / "images" / "P1.jpg").write_bytes(photo)
    origin = tmp_path / "origin"
    private, public = generate_keypair()
    key_path = tmp_path / "private.key"
    save_seed(private.private_bytes_raw(), key_path)

    publish_bundle(
        staging_dir=staging,
        origin_dir=origin,
        private_key_path=key_path,
        catalog_id="amazon-demo",
        version="v1",
        embedding_model="m",
        embedding_dim=384,
        embedding_count=1,
        product_count=1,
    )

    cache = FilesystemCacheStore(tmp_path / "cache")
    sync_index(
        base_url=str(origin),
        store=cache,
        adapter=FilesystemAdapter(),
        verifier=Ed25519Verifier(public),
    )
    manifest = _active_manifest(cache)
    record = json.loads(materialize_file(cache, manifest, "products.jsonl").decode("utf-8"))
    paths = {entry.path for entry in manifest.files}

    assert record["image_url"] == "/images/P1.jpg"
    assert "images/P1.svg" not in paths, "a placeholder must not shadow the real photo"
    # The PHOTO BYTES are deliberately NOT in the signed set: `syncIndex` reassembles
    # and hash-verifies every manifest file on every sync, so signing them would push
    # ~16 MB onto every visitor for bytes the SPA never reads back out of the bundle
    # (it loads /images/<id> as ordinary same-origin static assets, lazily).
    assert "images/P1.jpg" not in paths


def test_a_failed_download_falls_back_per_product_not_per_build(tmp_path: Path) -> None:
    """One product's missing photo must not cost the others theirs.

    The build downloads 720 photos from a third party; some WILL fail. The contract is
    per-product degradation: whoever got a photo keeps it, whoever did not gets the
    generated card, and the publish still succeeds. A build-wide failure (or a build
    that silently drops the un-downloaded products) is the thing this rules out.
    """
    staging = _staging(tmp_path)
    (staging / "products.jsonl").write_text(
        '{"id":"P1","title":"Has photo","category":"Electronics"}\n'
        '{"id":"P2","title":"Download failed","category":"Electronics"}\n',
        encoding="utf-8",
    )
    (staging / "images").mkdir()
    (staging / "images" / "P1.jpg").write_bytes(b"\xff\xd8\xff\xe0photo")  # P2 absent
    origin = tmp_path / "origin"
    private, public = generate_keypair()
    key_path = tmp_path / "private.key"
    save_seed(private.private_bytes_raw(), key_path)

    publish_bundle(
        staging_dir=staging,
        origin_dir=origin,
        private_key_path=key_path,
        catalog_id="amazon-demo",
        version="v1",
        embedding_model="m",
        embedding_dim=384,
        embedding_count=2,
        product_count=2,
    )

    cache = FilesystemCacheStore(tmp_path / "cache")
    sync_index(
        base_url=str(origin),
        store=cache,
        adapter=FilesystemAdapter(),
        verifier=Ed25519Verifier(public),
    )
    manifest = _active_manifest(cache)
    raw = materialize_file(cache, manifest, "products.jsonl").decode("utf-8")
    urls = {
        json.loads(line)["id"]: json.loads(line)["image_url"]
        for line in raw.split("\n")
        if line.strip()
    }

    assert urls == {"P1": "/images/P1.jpg", "P2": "/images/P2.svg"}
    # The fallback card is real, renderable bytes — not an empty placeholder file.
    assert materialize_file(cache, manifest, "images/P2.svg").startswith(b"<svg")


def test_publish_localizes_remote_product_image_urls(tmp_path: Path) -> None:
    """A catalog whose products carry REMOTE CDN image urls must publish as a bundle
    whose ``image_url`` values are root-relative and whose cards ship inside the
    signature.

    This is the PROPERTY the storefront depends on, not the shape of a staging dir.
    ``ProductImage`` renders an ``<img>`` only for a root-relative, same-origin url
    (``isLocalImage``), and production ships ``img-src 'self' data:`` — so a bundle
    that keeps ``https://m.media-amazon.com/...`` renders NO product image at all
    AND would leak every visitor's IP to a third party if it did. Localizing only in
    the demo rebuild script left every other publisher on the broken path.
    """
    staging = _staging(tmp_path)
    (staging / "products.jsonl").write_text(
        '{"id":"P1","title":"Widget","category":"Electronics",'
        '"image_url":"https://m.media-amazon.com/images/I/71abc.jpg"}\n',
        encoding="utf-8",
    )
    origin = tmp_path / "origin"
    private, public = generate_keypair()
    key_path = tmp_path / "private.key"
    save_seed(private.private_bytes_raw(), key_path)

    publish_bundle(
        staging_dir=staging,
        origin_dir=origin,
        private_key_path=key_path,
        catalog_id="amazon-demo",
        version="v1",
        embedding_model="m",
        embedding_dim=384,
        embedding_count=1,
        product_count=1,
    )

    cache = FilesystemCacheStore(tmp_path / "cache")
    sync_index(
        base_url=str(origin),
        store=cache,
        adapter=FilesystemAdapter(),
        verifier=Ed25519Verifier(public),
    )
    manifest = _active_manifest(cache)
    record = json.loads(materialize_file(cache, manifest, "products.jsonl").decode("utf-8"))

    assert record["image_url"] == "/images/P1.svg", (
        "publish must localize remote image urls; the storefront renders no <img> "
        "for an off-origin url and production CSP (img-src 'self') would block it"
    )
    # The card the rewritten url points at must actually be in the signed bundle.
    assert "images/P1.svg" in {entry.path for entry in manifest.files}
    assert materialize_file(cache, manifest, "images/P1.svg").startswith(b"<svg")


def test_republishing_the_same_staging_dir_is_byte_identical(tmp_path: Path) -> None:
    """Publishing twice from ONE staging dir must produce the SAME manifest hash.

    This is the invariant the whole change rests on: the producer now rewrites
    products.jsonl and re-renders cards on EVERY publish, so if either step were not
    idempotent every republish would move the bundle hash and the committed demo
    bundle could never be reproduced. Pinning it here means a future renderer change
    that smuggles in a timestamp, a random id, or a lossy line split trips a test
    instead of silently churning every consumer's sync.
    """
    staging = _staging(tmp_path)
    (staging / "products.jsonl").write_text(
        '{"id":"P1","title":"Widget","category":"Electronics",'
        '"image_url":"https://m.media-amazon.com/images/I/71abc.jpg"}\n',
        encoding="utf-8",
    )
    private, _ = generate_keypair()
    key_path = tmp_path / "private.key"
    save_seed(private.private_bytes_raw(), key_path)

    def publish_to(origin: Path) -> str:
        publish_bundle(
            staging_dir=staging,
            origin_dir=origin,
            private_key_path=key_path,
            catalog_id="amazon-demo",
            version="v1",
            embedding_model="m",
            embedding_dim=384,
            embedding_count=1,
            product_count=1,
        )
        pointer = VersionPointer.model_validate_json((origin / "latest").read_bytes())
        return pointer.manifest_hash

    # The second publish reads back exactly what the first one wrote.
    assert publish_to(tmp_path / "origin-a") == publish_to(tmp_path / "origin-b")


def test_localize_survives_unicode_line_separators(tmp_path: Path) -> None:
    """A product carrying U+2028 / U+2029 / U+0085 must round-trip a publish.

    ``json.dumps(ensure_ascii=False)`` emits all three RAW, and ``str.splitlines()``
    treats every one as a line terminator — so splitting the catalog that way writes a
    products.jsonl the producer cannot re-read, and which the browser consumer (which
    splits on ``\\n``) would parse into different records than the producer intended.
    """
    staging = _staging(tmp_path)
    # Written as escapes on purpose: a raw U+2028/U+2029/U+0085 in source is
    # invisible and easily mangled by an editor, which would silently defang this.
    title = "Wid\u2028get\u2029 Pro\u0085X"
    (staging / "products.jsonl").write_text(
        json.dumps({"id": "P1", "title": title, "category": "Electronics"}, ensure_ascii=False)
        + "\n",
        encoding="utf-8",
    )
    origin = tmp_path / "origin"
    private, public = generate_keypair()
    key_path = tmp_path / "private.key"
    save_seed(private.private_bytes_raw(), key_path)

    publish_bundle(
        staging_dir=staging,
        origin_dir=origin,
        private_key_path=key_path,
        catalog_id="amazon-demo",
        version="v1",
        embedding_model="m",
        embedding_dim=384,
        embedding_count=1,
        product_count=1,
    )

    cache = FilesystemCacheStore(tmp_path / "cache")
    sync_index(
        base_url=str(origin),
        store=cache,
        adapter=FilesystemAdapter(),
        verifier=Ed25519Verifier(public),
    )
    manifest = _active_manifest(cache)
    raw = materialize_file(cache, manifest, "products.jsonl").decode("utf-8")

    # Exactly ONE record survives, title intact, splitting the way the browser does.
    records = [line for line in raw.split("\n") if line.strip()]
    assert len(records) == 1
    assert json.loads(records[0])["title"] == title


def test_publish_refuses_symlinked_images_dir(tmp_path: Path) -> None:
    """A symlink planted at the ``images/`` DIR must be refused before any card write.

    ``O_NOFOLLOW`` only guards the FINAL path component, and ``mkdir(exist_ok=True)``
    accepts a symlink that already resolves to a directory — so without an explicit
    check on the dir itself, ``images -> /elsewhere`` turns the producer's per-product
    card writes into an arbitrary-file WRITE primitive.
    """
    staging = _staging(tmp_path)
    victim = tmp_path / "victim_dir"
    victim.mkdir()
    (staging / "images").symlink_to(victim, target_is_directory=True)

    origin = tmp_path / "origin"
    private, _ = generate_keypair()
    key_path = tmp_path / "private.key"
    save_seed(private.private_bytes_raw(), key_path)

    with pytest.raises(ValueError, match="symlink"):
        publish_bundle(
            staging_dir=staging,
            origin_dir=origin,
            private_key_path=key_path,
            catalog_id="amazon-demo",
            version="v1",
            embedding_model="m",
            embedding_dim=384,
            embedding_count=1,
            product_count=1,
        )

    # Nothing was written through the link, and no signed origin was built.
    assert list(victim.iterdir()) == []
    assert not origin.exists()


def test_bundle_covers_staged_product_images(tmp_path: Path) -> None:
    """Staged ``images/*.svg`` are read into the bundle, listed in the manifest, and
    reassemble verbatim after sync — i.e. they are inside the ed25519 signature.

    Uses an id the catalog does NOT contain: cards for catalog products are owned and
    regenerated by the producer (see ``test_publish_localizes_remote_product_image_urls``),
    while any other staged image is still carried verbatim inside the signature.
    """
    staging = _staging(tmp_path)
    (staging / "images").mkdir()
    svg = b'<svg xmlns="http://www.w3.org/2000/svg"/>'
    (staging / "images" / "EXTRA1.svg").write_bytes(svg)
    origin = tmp_path / "origin"
    private, public = generate_keypair()
    key_path = tmp_path / "private.key"
    save_seed(private.private_bytes_raw(), key_path)

    publish_bundle(
        staging_dir=staging,
        origin_dir=origin,
        private_key_path=key_path,
        catalog_id="amazon-demo",
        version="v1",
        embedding_model="m",
        embedding_dim=384,
        embedding_count=1,
        product_count=1,
    )

    cache = FilesystemCacheStore(tmp_path / "cache")
    sync_index(
        base_url=str(origin),
        store=cache,
        adapter=FilesystemAdapter(),
        verifier=Ed25519Verifier(public),
    )
    manifest = _active_manifest(cache)
    assert "images/EXTRA1.svg" in {entry.path for entry in manifest.files}
    assert materialize_file(cache, manifest, "images/EXTRA1.svg") == svg


def test_bundle_carries_signed_cooccurrence(tmp_path: Path) -> None:
    """A built bundle contains a signed ``cooccurrence.json`` that round-trips; an
    empty matrix is the default when the staging dir provides none."""
    staging = _staging(tmp_path)
    cooc = CooccurrenceMatrix(neighbors={"P1": [Neighbor(id="P2", score=0.42)]})
    (staging / "cooccurrence.json").write_text(cooc.model_dump_json(), encoding="utf-8")
    origin = tmp_path / "origin"
    private, public = generate_keypair()
    key_path = tmp_path / "private.key"
    save_seed(private.private_bytes_raw(), key_path)

    publish_bundle(
        staging_dir=staging,
        origin_dir=origin,
        private_key_path=key_path,
        catalog_id="amazon-demo",
        version="v1",
        embedding_model="m",
        embedding_dim=384,
        embedding_count=1,
        product_count=1,
    )

    cache = FilesystemCacheStore(tmp_path / "cache")
    sync_index(
        base_url=str(origin),
        store=cache,
        adapter=FilesystemAdapter(),
        verifier=Ed25519Verifier(public),
    )
    manifest = _active_manifest(cache)
    raw = materialize_file(cache, manifest, "cooccurrence.json")
    assert CooccurrenceMatrix.model_validate_json(raw) == cooc


def test_bundle_defaults_empty_cooccurrence_when_absent(tmp_path: Path) -> None:
    """A staging dir with no ``cooccurrence.json`` gets an empty matrix (older bundles)."""
    staging = _staging(tmp_path)
    origin = tmp_path / "origin"
    private, public = generate_keypair()
    key_path = tmp_path / "private.key"
    save_seed(private.private_bytes_raw(), key_path)

    publish_bundle(
        staging_dir=staging,
        origin_dir=origin,
        private_key_path=key_path,
        catalog_id="amazon-demo",
        version="v1",
        embedding_model="m",
        embedding_dim=384,
        embedding_count=1,
        product_count=1,
    )

    cache = FilesystemCacheStore(tmp_path / "cache")
    sync_index(
        base_url=str(origin),
        store=cache,
        adapter=FilesystemAdapter(),
        verifier=Ed25519Verifier(public),
    )
    manifest = _active_manifest(cache)
    raw = materialize_file(cache, manifest, "cooccurrence.json")
    assert CooccurrenceMatrix.model_validate_json(raw) == CooccurrenceMatrix()


def test_bundle_carries_signed_ranking_config(tmp_path: Path) -> None:
    """A built bundle contains a signed ``ranking_config.json`` that round-trips
    to ``DEFAULT_RANKING_CONFIG`` when the staging dir provides none."""
    staging = _staging(tmp_path)
    origin = tmp_path / "origin"
    private, public = generate_keypair()
    key_path = tmp_path / "private.key"
    save_seed(private.private_bytes_raw(), key_path)

    publish_bundle(
        staging_dir=staging,
        origin_dir=origin,
        private_key_path=key_path,
        catalog_id="amazon-demo",
        version="v1",
        embedding_model="m",
        embedding_dim=384,
        embedding_count=1,
        product_count=1,
    )

    cache = FilesystemCacheStore(tmp_path / "cache")
    sync_index(
        base_url=str(origin),
        store=cache,
        adapter=FilesystemAdapter(),
        verifier=Ed25519Verifier(public),
    )
    manifest = _active_manifest(cache)
    raw = materialize_file(cache, manifest, "ranking_config.json")
    assert RankingConfig.model_validate_json(raw) == DEFAULT_RANKING_CONFIG


def test_bundle_carries_verifiable_ranking_receipt(tmp_path: Path) -> None:
    """Every publish seals the STAGED weights as a signed ranking attestation
    (``ranking_receipt.json``) an offline verifier can check under the SAME
    publisher key that signs the bundle — one pinned identity for both."""
    staging = _staging(tmp_path)
    tuned = DEFAULT_RANKING_CONFIG.model_copy(deep=True)
    tuned.scoring_weights.popularity = 0.55
    (staging / "ranking_config.json").write_text(tuned.model_dump_json(), encoding="utf-8")
    origin = tmp_path / "origin"
    private, public = generate_keypair()
    key_path = tmp_path / "private.key"
    save_seed(private.private_bytes_raw(), key_path)

    publish_bundle(
        staging_dir=staging,
        origin_dir=origin,
        private_key_path=key_path,
        catalog_id="amazon-demo",
        version="v1",
        embedding_model="m",
        embedding_dim=384,
        embedding_count=1,
        product_count=1,
    )

    cache = FilesystemCacheStore(tmp_path / "cache")
    sync_index(
        base_url=str(origin),
        store=cache,
        adapter=FilesystemAdapter(),
        verifier=Ed25519Verifier(public),
    )
    manifest = _active_manifest(cache)
    raw = materialize_file(cache, manifest, RANKING_RECEIPT_NAME)
    receipt = RankingReceipt.model_validate_json(raw)
    verify_signature(receipt, expected_public_key=public.public_bytes_raw().hex())
    governed = content_hash(tuned.model_dump(mode="json"))
    assert receipt.payload.ranking_config_hash == governed
    assert tuple(probe.id for probe in receipt.payload.formula_probes) == (
        "search",
        *sorted(tuned.strategies),
    )


def test_bundle_canonicalizes_staged_ranking_config(tmp_path: Path) -> None:
    """The signed config and proof share Pydantic's one canonical typed shape."""
    staging = _staging(tmp_path)
    tuned = DEFAULT_RANKING_CONFIG.model_copy(deep=True)
    tuned.scoring_weights.popularity = 0.55
    noncanonical = json.loads(tuned.model_dump_json())
    noncanonical["unexpected_top_level"] = 1
    del noncanonical["strategies"]["for_you"]["co_occurrence_top_k"]
    (staging / "ranking_config.json").write_text(json.dumps(noncanonical), encoding="utf-8")
    origin = tmp_path / "origin"
    private, public = generate_keypair()
    key_path = tmp_path / "private.key"
    save_seed(private.private_bytes_raw(), key_path)

    publish_bundle(
        staging_dir=staging,
        origin_dir=origin,
        private_key_path=key_path,
        catalog_id="amazon-demo",
        version="v1",
        embedding_model="m",
        embedding_dim=384,
        embedding_count=1,
        product_count=1,
    )

    cache = FilesystemCacheStore(tmp_path / "cache")
    sync_index(
        base_url=str(origin),
        store=cache,
        adapter=FilesystemAdapter(),
        verifier=Ed25519Verifier(public),
    )
    manifest = _active_manifest(cache)
    raw = materialize_file(cache, manifest, "ranking_config.json")
    restored = RankingConfig.model_validate_json(raw)
    assert raw == tuned.model_dump_json().encode()
    assert restored == tuned
    assert restored != DEFAULT_RANKING_CONFIG


def test_catalog_meta_carries_current_schema_version(tmp_path: Path) -> None:
    """A freshly published bundle stamps the current meta schema_version, so a
    consumer can tell a current bundle from a pre-feature one."""
    from edgereco.catalog.publish import CatalogMeta

    staging = _staging(tmp_path)
    origin = tmp_path / "origin"
    private, public = generate_keypair()
    key_path = tmp_path / "private.key"
    save_seed(private.private_bytes_raw(), key_path)
    publish_bundle(
        staging_dir=staging,
        origin_dir=origin,
        private_key_path=key_path,
        catalog_id="amazon-demo",
        version="v1",
        embedding_model="m",
        embedding_dim=384,
        embedding_count=1,
        product_count=1,
    )
    cache = FilesystemCacheStore(tmp_path / "cache")
    sync_index(
        base_url=str(origin),
        store=cache,
        adapter=FilesystemAdapter(),
        verifier=Ed25519Verifier(public),
    )
    manifest = _active_manifest(cache)
    meta = CatalogMeta.model_validate_json(materialize_file(cache, manifest, "catalog_meta.json"))
    assert meta.schema_version == CURRENT_META_SCHEMA


def test_legacy_catalog_meta_without_schema_version_reads_as_one() -> None:
    """A pre-feature catalog_meta.json (no schema_version) parses as schema 1 — the
    committed bundle stays byte-stable and is treated as legacy."""
    from edgereco.catalog.publish import CatalogMeta

    legacy_json = (
        '{"catalog_id":"x","version":"v1","embedding_model":"m",'
        '"embedding_dim":8,"embedding_count":1,"product_count":1}'
    )
    meta = CatalogMeta.model_validate_json(legacy_json)
    assert meta.schema_version == 1


def test_republish_requires_feature_files_and_raises_when_missing(tmp_path: Path) -> None:
    """Republishing a CURRENT bundle (require_feature_files=True) with a staging dir
    missing ranking_config.json raises — never silently bakes legacy weights in."""
    staging = _staging(tmp_path)  # has no ranking_config.json
    (staging / "cooccurrence.json").write_text(
        CooccurrenceMatrix().model_dump_json(), encoding="utf-8"
    )
    origin = tmp_path / "origin"
    private, _ = generate_keypair()
    key_path = tmp_path / "private.key"
    save_seed(private.private_bytes_raw(), key_path)
    with pytest.raises(FileNotFoundError):
        publish_bundle(
            staging_dir=staging,
            origin_dir=origin,
            private_key_path=key_path,
            catalog_id="amazon-demo",
            version="v2",
            embedding_model="m",
            embedding_dim=384,
            embedding_count=1,
            product_count=1,
            require_feature_files=True,
        )


def test_fresh_build_still_defaults_feature_files(tmp_path: Path) -> None:
    """A genuine fresh build (require_feature_files=False, the default) still gets
    DEFAULT_RANKING_CONFIG + empty cooccurrence written — backward compat preserved."""
    staging = _staging(tmp_path)
    origin = tmp_path / "origin"
    private, public = generate_keypair()
    key_path = tmp_path / "private.key"
    save_seed(private.private_bytes_raw(), key_path)
    publish_bundle(
        staging_dir=staging,
        origin_dir=origin,
        private_key_path=key_path,
        catalog_id="amazon-demo",
        version="v1",
        embedding_model="m",
        embedding_dim=384,
        embedding_count=1,
        product_count=1,
    )
    cache = FilesystemCacheStore(tmp_path / "cache")
    sync_index(
        base_url=str(origin),
        store=cache,
        adapter=FilesystemAdapter(),
        verifier=Ed25519Verifier(public),
    )
    manifest = _active_manifest(cache)
    raw = materialize_file(cache, manifest, "ranking_config.json")
    assert RankingConfig.model_validate_json(raw) == DEFAULT_RANKING_CONFIG


def test_catalog_meta_content(tmp_path: Path) -> None:
    staging = _staging(tmp_path)
    origin = tmp_path / "origin"
    private, public = generate_keypair()
    key_path = tmp_path / "private.key"
    save_seed(private.private_bytes_raw(), key_path)

    publish_bundle(
        staging_dir=staging,
        origin_dir=origin,
        private_key_path=key_path,
        catalog_id="amazon-demo",
        version="2026-05-27T00:00:00Z",
        embedding_model="sentence-transformers/all-MiniLM-L6-v2",
        embedding_dim=384,
        embedding_count=1,
        product_count=1,
    )

    cache = FilesystemCacheStore(tmp_path / "cache")
    sync_index(
        base_url=str(origin),
        store=cache,
        adapter=FilesystemAdapter(),
        verifier=Ed25519Verifier(public),
    )
    manifest = _active_manifest(cache)
    meta = json.loads(materialize_file(cache, manifest, "catalog_meta.json"))

    assert meta == {
        "catalog_id": "amazon-demo",
        "version": "2026-05-27T00:00:00Z",
        "embedding_model": "sentence-transformers/all-MiniLM-L6-v2",
        "embedding_dim": 384,
        "embedding_count": 1,
        "product_count": 1,
        "schema_version": CURRENT_META_SCHEMA,
    }


def test_publish_rejects_symlinked_staging_entry(tmp_path: Path) -> None:
    """A symlink under the staging dir must be REFUSED, never followed: reading it
    would inline an arbitrary host file into the SIGNED bundle (arbitrary-file read).
    """
    staging = _staging(tmp_path)
    secret = tmp_path / "outside_secret.txt"
    secret.write_text("ATTACKER-CONTROLLED SECRET", encoding="utf-8")
    (staging / "vector" / "leak.faiss").symlink_to(secret)

    origin = tmp_path / "origin"
    private, _ = generate_keypair()
    key_path = tmp_path / "private.key"
    save_seed(private.private_bytes_raw(), key_path)

    with pytest.raises(ValueError, match="symlink"):
        publish_bundle(
            staging_dir=staging,
            origin_dir=origin,
            private_key_path=key_path,
            catalog_id="amazon-demo",
            version="v1",
            embedding_model="m",
            embedding_dim=384,
            embedding_count=1,
            product_count=1,
        )

    # The secret bytes never made it into a signed origin (build never ran).
    assert not origin.exists()


def test_publish_rejects_symlinked_top_level_entry(tmp_path: Path) -> None:
    """A symlinked TOP-LEVEL entry (e.g. ``products.jsonl``) must be REFUSED too, not
    only entries under ``vector/``: ``read_bytes()`` on a fixed-name staged file follows
    the link and inlines an arbitrary host file into the SIGNED bundle (arbitrary read).
    """
    staging = _staging(tmp_path)
    secret = tmp_path / "outside_secret.txt"
    secret.write_text("ATTACKER-CONTROLLED SECRET", encoding="utf-8")
    products = staging / "products.jsonl"
    products.unlink()  # drop the real staged catalog...
    products.symlink_to(secret)  # ...and point its name at a host file outside the tree

    origin = tmp_path / "origin"
    private, _ = generate_keypair()
    key_path = tmp_path / "private.key"
    save_seed(private.private_bytes_raw(), key_path)

    with pytest.raises(ValueError, match="symlink"):
        publish_bundle(
            staging_dir=staging,
            origin_dir=origin,
            private_key_path=key_path,
            catalog_id="amazon-demo",
            version="v1",
            embedding_model="m",
            embedding_dim=384,
            embedding_count=1,
            product_count=1,
        )

    # The secret bytes never made it into a signed origin (build never ran).
    assert not origin.exists()


def test_publish_refuses_symlinked_meta_write_target(tmp_path: Path) -> None:
    """A symlink pre-planted at the ``catalog_meta.json`` WRITE path must be REFUSED,
    never followed: the producer ALWAYS (re)writes ``catalog_meta.json``, and a plain
    ``write_text`` follows a symlink there and clobbers whatever it targets — an
    arbitrary host-file WRITE-through. Fail closed before the target is touched.
    """
    staging = _staging(tmp_path)  # products.jsonl + vector/, no catalog_meta.json yet
    secret = tmp_path / "outside_secret.txt"
    original = "ATTACKER-VICTIM FILE — MUST NOT BE OVERWRITTEN"
    secret.write_text(original, encoding="utf-8")
    (staging / "catalog_meta.json").symlink_to(secret)  # hostile symlink at write path

    origin = tmp_path / "origin"
    private, _ = generate_keypair()
    key_path = tmp_path / "private.key"
    save_seed(private.private_bytes_raw(), key_path)

    with pytest.raises(ValueError, match="symlink"):
        publish_bundle(
            staging_dir=staging,
            origin_dir=origin,
            private_key_path=key_path,
            catalog_id="amazon-demo",
            version="v1",
            embedding_model="m",
            embedding_dim=384,
            embedding_count=1,
            product_count=1,
        )

    # The producer's write was refused: the victim target keeps its original bytes.
    assert secret.read_text(encoding="utf-8") == original
    # And no signed origin was built.
    assert not origin.exists()


def test_bundle_files_contract() -> None:
    assert BUNDLE_FILES == (
        "products.jsonl",
        "vector",
        "catalog_meta.json",
        "ranking_config.json",
        "ranking_receipt.json",
        "cooccurrence.json",
        "images",
    )


def test_signature_fail_closed(tmp_path: Path) -> None:
    staging = _staging(tmp_path)
    origin = tmp_path / "origin"
    private, _ = generate_keypair()
    key_path = tmp_path / "private.key"
    save_seed(private.private_bytes_raw(), key_path)

    publish_bundle(
        staging_dir=staging,
        origin_dir=origin,
        private_key_path=key_path,
        catalog_id="amazon-demo",
        version="v1",
        embedding_model="m",
        embedding_dim=384,
        embedding_count=1,
        product_count=1,
    )

    _, wrong_public = generate_keypair()  # different keypair
    cache = FilesystemCacheStore(tmp_path / "cache")
    with pytest.raises(SignatureError):
        sync_index(
            base_url=str(origin),
            store=cache,
            adapter=FilesystemAdapter(),
            verifier=Ed25519Verifier(wrong_public),
        )


def test_cli_bundle_end_to_end(tmp_path: Path) -> None:
    staging = _staging(tmp_path)
    origin = tmp_path / "origin"
    private, public = generate_keypair()
    key_path = tmp_path / "private.key"
    save_seed(private.private_bytes_raw(), key_path)

    result = runner.invoke(
        app,
        [
            "bundle",
            str(staging),
            str(origin),
            str(key_path),
            "--catalog-id",
            "amazon-demo",
            "--version",
            "v1",
            "--embedding-model",
            "sentence-transformers/all-MiniLM-L6-v2",
            "--embedding-dim",
            "384",
            "--embedding-count",
            "1",
            "--product-count",
            "1",
        ],
    )

    assert result.exit_code == 0, result.output
    cache = FilesystemCacheStore(tmp_path / "cache")
    sync_index(
        base_url=str(origin),
        store=cache,
        adapter=FilesystemAdapter(),
        verifier=Ed25519Verifier(public),
    )
    assert cache.read_active() is not None
