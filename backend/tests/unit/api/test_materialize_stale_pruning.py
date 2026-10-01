"""Materialization must not retain stale files from a previous bundle version.

``sync_and_materialize`` reassembles the active manifest into the FIXED dir
``cache_root / "materialized"``. Publishing v2 to the same origin and re-syncing
into the same ``cache_root`` must leave the materialized tree EXACTLY equal to
v2's manifest file set — files only v1 carried, and any strays another process
left behind, are pruned. The edgeproc CAS layout under ``cache_root`` (chunks,
manifests, pointer) must survive untouched: only the derived cache is rebuilt.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
from edgeproc.bundles.signing import Ed25519Verifier, generate_keypair
from tests.signing import save_seed

from edgereco.api.deps import _sync_and_load_manifest, sync_and_materialize
from edgereco.catalog.models import Product
from edgereco.catalog.publish import publish_bundle
from edgereco.embeddings.index import VectorIndex

_DIM = 8
_PRODUCTS = [
    Product(id="P1", title="Wireless Headphones", category="Electronics"),
    Product(id="P2", title="Running Shoes", category="Sports"),
]


def _stage(tmp_path: Path, name: str) -> Path:
    """A tiny staging dir: products.jsonl + a real (synthetic-embedding) vector/."""
    staging = tmp_path / name
    staging.mkdir()
    rng = np.random.default_rng(0)
    embeddings = rng.standard_normal((len(_PRODUCTS), _DIM)).astype(np.float32)
    VectorIndex.build(embeddings, [p.id for p in _PRODUCTS], dim=_DIM).save(staging / "vector")
    (staging / "products.jsonl").write_text(
        "\n".join(p.model_dump_json() for p in _PRODUCTS) + "\n", encoding="utf-8"
    )
    return staging


def _publish(
    staging: Path, origin: Path, key_path: Path, version: str, *, sequence: int = 1
) -> None:
    publish_bundle(
        staging_dir=staging,
        origin_dir=origin,
        private_key_path=key_path,
        catalog_id="prune-origin",
        version=version,
        embedding_model="sentence-transformers/all-MiniLM-L6-v2",
        embedding_dim=_DIM,
        embedding_count=len(_PRODUCTS),
        product_count=len(_PRODUCTS),
        sequence=sequence,
    )


def _file_tree(root: Path) -> set[str]:
    return {p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file()}


def test_rematerialize_prunes_files_dropped_by_new_version(tmp_path: Path) -> None:
    """The materialized tree is exactly the ACTIVE manifest's file set — no leftovers."""
    private, public = generate_keypair()
    key_path = tmp_path / "private.key"
    save_seed(private.private_bytes_raw(), key_path)
    verifier = Ed25519Verifier(public)
    origin = tmp_path / "origin"
    cache_root = tmp_path / "cache"

    # v1 carries an extra file that v2 will drop.
    staging_v1 = _stage(tmp_path, "staging_v1")
    (staging_v1 / "vector" / "extra.bin").write_bytes(b"\x01v1-only")
    _publish(staging_v1, origin, key_path, version="v1")
    local = sync_and_materialize(base_url=str(origin), cache_root=cache_root, verifier=verifier)
    assert "vector/extra.bin" in _file_tree(local)

    # A stray file another process left behind must also be swept.
    (local / "stale.json").write_text("{}", encoding="utf-8")

    # v2 (no extra.bin) republished to the same origin; CAS files must survive.
    _publish(_stage(tmp_path, "staging_v2"), origin, key_path, version="v2", sequence=2)
    cas_before = {
        p
        for p in cache_root.rglob("*")
        if p.is_file() and "materialized" not in p.relative_to(cache_root).parts
    }
    local = sync_and_materialize(base_url=str(origin), cache_root=cache_root, verifier=verifier)

    _probe_store, manifest = _sync_and_load_manifest(
        base_url=str(origin), cache_root=tmp_path / "probe", verifier=verifier
    )
    assert _file_tree(local) == {entry.path for entry in manifest.files}
    assert all(p.is_file() for p in cas_before), "pruning must not touch the CAS store"
