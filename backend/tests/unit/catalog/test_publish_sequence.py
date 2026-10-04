"""The publisher keeps the signed ``sequence`` strictly increasing per origin.

edge-proc 0.3.0 closed an anti-replay hole: an EQUAL version used to read as "fresh",
so a genuinely signed older pointer at the same label could replay onto a device. A
promote now needs a strictly greater ``sequence``, and ``@gainratio/browser`` has always
refused a lower or equal one over a different manifest (docs/DEPLOY.md). So the one
number a publisher must never get wrong is the next sequence. These tests pin that the
producer computes it from what the origin already serves and refuses to go backwards.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from edgeproc.bundles.adapters import FilesystemAdapter
from edgeproc.bundles.cas import FilesystemCacheStore, RollbackError
from edgeproc.bundles.manifest import VersionPointer
from edgeproc.bundles.signing import Ed25519Verifier, generate_keypair
from edgeproc.bundles.sync import sync_index
from tests.signing import save_seed
from typer.testing import CliRunner

from edgereco.catalog.publish import SequenceNotIncreasingError, publish_bundle
from edgereco.cli import app

runner = CliRunner()


def _staging(root: Path, title: str) -> Path:
    staging = root / f"staging-{title}"
    (staging / "vector").mkdir(parents=True, exist_ok=True)
    (staging / "products.jsonl").write_text(
        f'{{"id":"P1","title":"{title}","category":"Electronics"}}\n', encoding="utf-8"
    )
    (staging / "vector" / "embeddings.f32").write_bytes(b"\x00" * 16)
    return staging


def _key(tmp_path: Path) -> tuple[Path, Ed25519Verifier]:
    private, public = generate_keypair()
    key_path = tmp_path / "private.key"
    save_seed(private.private_bytes_raw(), key_path)
    return key_path, Ed25519Verifier(public)


def _publish(
    tmp_path: Path, key_path: Path, origin: Path, title: str, sequence: int | None
) -> VersionPointer:
    publish_bundle(
        staging_dir=_staging(tmp_path, title),
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


def test_default_sequence_is_one_on_a_fresh_origin(tmp_path: Path) -> None:
    key_path, _ = _key(tmp_path)
    assert _publish(tmp_path, key_path, tmp_path / "origin", "A", None).sequence == 1


def test_default_sequence_is_one_more_than_the_origin_serves(tmp_path: Path) -> None:
    key_path, _ = _key(tmp_path)
    origin = tmp_path / "origin"
    _publish(tmp_path, key_path, origin, "A", 5)
    assert _publish(tmp_path, key_path, origin, "B", None).sequence == 6


@pytest.mark.parametrize("sequence", [4, 5])
def test_publish_refuses_a_sequence_that_does_not_exceed_the_served_one(
    tmp_path: Path, sequence: int
) -> None:
    key_path, _ = _key(tmp_path)
    origin = tmp_path / "origin"
    served = _publish(tmp_path, key_path, origin, "A", 5)

    with pytest.raises(SequenceNotIncreasingError, match="strictly greater than 5"):
        _publish(tmp_path, key_path, origin, "B", sequence)

    # Fail closed: the origin still serves exactly what it served before.
    assert VersionPointer.model_validate_json((origin / "latest").read_bytes()) == served


def test_publish_refuses_an_origin_whose_latest_is_unreadable(tmp_path: Path) -> None:
    key_path, _ = _key(tmp_path)
    origin = tmp_path / "origin"
    origin.mkdir()
    (origin / "latest").write_text("not a pointer", encoding="utf-8")

    with pytest.raises(SequenceNotIncreasingError, match="cannot read"):
        _publish(tmp_path, key_path, origin, "A", None)


def test_publish_refuses_a_symlinked_latest(tmp_path: Path) -> None:
    key_path, _ = _key(tmp_path)
    elsewhere = _publish(tmp_path, key_path, tmp_path / "elsewhere", "A", 1)
    origin = tmp_path / "origin"
    origin.mkdir()
    (origin / "latest").symlink_to(tmp_path / "elsewhere" / "latest")

    with pytest.raises(SequenceNotIncreasingError, match="symlink"):
        _publish(tmp_path, key_path, origin, "B", elsewhere.sequence + 1)


def test_same_version_label_promotes_only_on_a_strictly_greater_sequence(
    tmp_path: Path,
) -> None:
    """edge-proc >=0.3.0 semantics end to end: same label, new content, higher sequence.

    The second release keeps version ``v1`` and changes content. A consumer promotes it
    because its sequence is strictly greater, then refuses a replay of the first release
    (a genuinely signed pointer, nothing forged) as a rollback.
    """
    key_path, verifier = _key(tmp_path)
    first_origin = tmp_path / "first"
    origin = tmp_path / "origin"
    _publish(tmp_path, key_path, first_origin, "A", 1)
    _publish(tmp_path, key_path, origin, "A", 1)
    second = _publish(tmp_path, key_path, origin, "B", None)
    cache = FilesystemCacheStore(tmp_path / "cache")

    def sync(base: Path) -> None:
        sync_index(base_url=str(base), store=cache, adapter=FilesystemAdapter(), verifier=verifier)

    sync(first_origin)
    sync(origin)
    assert cache.read_active() == second

    with pytest.raises(RollbackError):
        sync(first_origin)
    assert cache.read_active() == second


def test_cli_bundle_defaults_to_the_next_sequence(tmp_path: Path) -> None:
    key_path, _ = _key(tmp_path)
    origin = tmp_path / "origin"
    _publish(tmp_path, key_path, origin, "A", 3)

    result = runner.invoke(
        app, ["bundle", str(_staging(tmp_path, "B")), str(origin), str(key_path)]
    )

    assert result.exit_code == 0, result.output
    assert VersionPointer.model_validate_json((origin / "latest").read_bytes()).sequence == 4


def test_cli_bundle_refuses_a_stale_sequence_without_a_traceback(tmp_path: Path) -> None:
    key_path, _ = _key(tmp_path)
    origin = tmp_path / "origin"
    _publish(tmp_path, key_path, origin, "A", 3)

    result = runner.invoke(
        app,
        ["bundle", str(_staging(tmp_path, "B")), str(origin), str(key_path), "--sequence", "3"],
    )

    assert result.exit_code == 1
    assert "strictly greater than 3" in result.output
    assert result.exception is None or isinstance(result.exception, SystemExit)
