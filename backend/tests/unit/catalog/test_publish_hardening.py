"""Hardening of the publisher's rollback floor: locking, strict parsing, provenance.

The served ``latest`` is the only thing the producer reads to pick the next signed
``sequence``. So the read must happen under the same lock as the write (two
publishers must not both sign N+1, and a slow N+1 must not land over an N+2). It
must also be parsed strictly and trusted only when it carries the publisher's own
signature for this catalog.
"""

from __future__ import annotations

import json
import os
import threading
import time
from collections.abc import Callable
from pathlib import Path

import pytest
from edgeproc.bundles.manifest import VersionPointer
from edgeproc.bundles.signing import generate_keypair
from tests.signing import save_seed
from typer.testing import CliRunner

import edgereco.catalog.publish as publish_module
from edgereco.catalog.publish import (
    MAX_SEQUENCE,
    SequenceNotIncreasingError,
    publish_bundle,
)
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


def _key(tmp_path: Path, name: str = "private.key") -> Path:
    private, _ = generate_keypair()
    key_path = tmp_path / name
    save_seed(private.private_bytes_raw(), key_path)
    return key_path


def _publish(
    tmp_path: Path,
    key_path: Path,
    origin: Path,
    title: str,
    sequence: int | None,
    catalog_id: str = "amazon-demo",
) -> None:
    publish_bundle(
        staging_dir=_staging(tmp_path, title),
        origin_dir=origin,
        private_key_path=key_path,
        catalog_id=catalog_id,
        version="v1",
        embedding_model="m",
        embedding_dim=384,
        embedding_count=1,
        product_count=1,
        sequence=sequence,
    )


def _served(origin: Path) -> int | None:
    return VersionPointer.model_validate_json((origin / "latest").read_bytes()).sequence


def _stall_first_build(monkeypatch: pytest.MonkeyPatch, other_started: threading.Event) -> None:
    """Hold the FIRST build_bundle call until the other publisher has had time to race."""
    real = publish_module.build_bundle
    calls = {"n": 0}
    guard = threading.Lock()

    def stalled(**kwargs: object) -> VersionPointer:
        with guard:
            calls["n"] += 1
            first = calls["n"] == 1
        if first:
            assert other_started.wait(timeout=10)
            time.sleep(0.5)  # an unlocked publisher reads `latest` inside this window
        return real(**kwargs)

    monkeypatch.setattr(publish_module, "build_bundle", stalled)


def _race(
    tmp_path: Path,
    first: Callable[[], None],
    second: Callable[[], None],
    other_started: threading.Event,
) -> list[str]:
    errors: list[str] = []

    def run(job: Callable[[], None]) -> None:
        try:
            job()
        except SequenceNotIncreasingError as exc:
            errors.append(str(exc))

    one = threading.Thread(target=run, args=(first,))
    one.start()
    time.sleep(0.2)  # let the first publisher take the lock and stall in its build
    two = threading.Thread(target=run, args=(second,))
    other_started.set()
    two.start()
    one.join(timeout=30)
    two.join(timeout=30)
    return errors


def test_two_concurrent_publishers_never_both_sign_the_next_sequence(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    key_path = _key(tmp_path)
    origin = tmp_path / "origin"
    _publish(tmp_path, key_path, origin, "seed", 5)
    other_started = threading.Event()
    signed: list[int | None] = []
    real = publish_module.build_bundle

    def recording(**kwargs: object) -> VersionPointer:
        pointer = real(**kwargs)
        signed.append(pointer.sequence)
        return pointer

    monkeypatch.setattr(publish_module, "build_bundle", recording)
    _stall_first_build(monkeypatch, other_started)

    errors = _race(
        tmp_path,
        lambda: _publish(tmp_path, key_path, origin, "A", None),
        lambda: _publish(tmp_path, key_path, origin, "B", None),
        other_started,
    )

    assert errors == []
    assert sorted(signed) == [6, 7]
    assert _served(origin) == 7


def test_a_slow_publisher_cannot_land_an_older_sequence_over_a_newer_one(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    key_path = _key(tmp_path)
    origin = tmp_path / "origin"
    _publish(tmp_path, key_path, origin, "seed", 5)
    other_started = threading.Event()
    _stall_first_build(monkeypatch, other_started)

    _race(
        tmp_path,
        lambda: _publish(tmp_path, key_path, origin, "slow", 6),
        lambda: _publish(tmp_path, key_path, origin, "fast", 7),
        other_started,
    )

    assert _served(origin) == 7


def test_publish_lock_file_does_not_linger_in_the_origin(tmp_path: Path) -> None:
    key_path = _key(tmp_path)
    origin = tmp_path / "origin"
    _publish(tmp_path, key_path, origin, "A", None)
    assert not (origin / ".publish.lock").exists()


def test_publish_refuses_a_symlinked_publish_lock(tmp_path: Path) -> None:
    key_path = _key(tmp_path)
    origin = tmp_path / "origin"
    origin.mkdir()
    (origin / ".publish.lock").symlink_to(tmp_path / "elsewhere.lock")

    with pytest.raises(SequenceNotIncreasingError, match="symlink"):
        _publish(tmp_path, key_path, origin, "A", None)
    assert not (tmp_path / "elsewhere.lock").exists()


def _rewrite_latest(origin: Path, **fields: object) -> None:
    pointer = json.loads((origin / "latest").read_bytes())
    pointer.update(fields)
    (origin / "latest").write_text(json.dumps(pointer), encoding="utf-8")


@pytest.mark.parametrize(
    "sequence",
    [True, 5.0, "5", -1, 2**53, None],
    ids=["bool", "float", "string", "negative", "unsafe-int", "null"],
)
def test_served_sequence_must_be_a_plain_safe_integer(tmp_path: Path, sequence: object) -> None:
    key_path = _key(tmp_path)
    origin = tmp_path / "origin"
    _publish(tmp_path, key_path, origin, "A", 5)
    _rewrite_latest(origin, sequence=sequence)

    with pytest.raises(SequenceNotIncreasingError, match="cannot read"):
        _publish(tmp_path, key_path, origin, "B", None)


def test_served_pointer_whose_signature_does_not_verify_is_refused(tmp_path: Path) -> None:
    """A tampered ``latest`` claiming a HUGE sequence must not become the floor."""
    key_path = _key(tmp_path)
    origin = tmp_path / "origin"
    _publish(tmp_path, key_path, origin, "A", 5)
    _rewrite_latest(origin, sequence=2**40)

    with pytest.raises(SequenceNotIncreasingError, match="cannot read"):
        _publish(tmp_path, key_path, origin, "B", None)


def test_served_pointer_signed_by_another_key_is_refused(tmp_path: Path) -> None:
    origin = tmp_path / "origin"
    _publish(tmp_path, _key(tmp_path, "other.key"), origin, "A", 5)

    with pytest.raises(SequenceNotIncreasingError, match="cannot read"):
        _publish(tmp_path, _key(tmp_path), origin, "B", None)


def test_served_pointer_for_another_catalog_is_refused(tmp_path: Path) -> None:
    key_path = _key(tmp_path)
    origin = tmp_path / "origin"
    _publish(tmp_path, key_path, origin, "A", 5, catalog_id="other-catalog")

    with pytest.raises(SequenceNotIncreasingError, match="cannot read"):
        _publish(tmp_path, key_path, origin, "B", None)


def test_served_latest_that_is_not_a_regular_file_is_refused(tmp_path: Path) -> None:
    key_path = _key(tmp_path)
    origin = tmp_path / "origin"
    origin.mkdir()
    os.mkfifo(origin / "latest")  # a FIFO would block a naive open forever

    with pytest.raises(SequenceNotIncreasingError, match="cannot read"):
        _publish(tmp_path, key_path, origin, "A", None)


@pytest.mark.parametrize("sequence", [0, MAX_SEQUENCE + 1])
def test_library_refuses_an_out_of_range_sequence(tmp_path: Path, sequence: int) -> None:
    with pytest.raises(ValueError, match="between 1 and"):
        _publish(tmp_path, _key(tmp_path), tmp_path / "origin", "A", sequence)


def test_next_sequence_past_the_safe_range_is_refused(tmp_path: Path) -> None:
    key_path = _key(tmp_path)
    origin = tmp_path / "origin"
    _publish(tmp_path, key_path, origin, "A", MAX_SEQUENCE)

    with pytest.raises(ValueError, match="between 1 and"):
        _publish(tmp_path, key_path, origin, "B", None)


@pytest.mark.parametrize("sequence", ["0", str(2**53)])
def test_cli_bounds_the_sequence_option(tmp_path: Path, sequence: str) -> None:
    result = runner.invoke(
        app,
        [
            "bundle",
            str(_staging(tmp_path, "A")),
            str(tmp_path / "origin"),
            str(_key(tmp_path)),
            "--sequence",
            sequence,
        ],
    )
    assert result.exit_code == 2
    assert not (tmp_path / "origin" / "latest").exists()
