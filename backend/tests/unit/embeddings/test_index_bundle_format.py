"""``vector/`` is EdgeReco's signed bundle format, not edge-proc's persistence format.

edge-proc 0.4.1 moved ``FaissVectorIndex.save`` to crash-atomic generations under
``snapshots/`` (random generation names plus a ``.snapshot.lock``), and its ``load``
MIGRATES a writable legacy ``index.faiss`` + ``state.json`` pair into that layout,
deleting the pair. Both are right for a mutable local index and wrong for a bundle:

- the browser tier reads ``vector/state.json`` (``faiss_ids``) and
  ``vector/embeddings.f32``, so a bundle without them fails closed on every device;
- random generation names make the signed bundle non-reproducible;
- a load that rewrites the materialized ``vector/`` would corrupt the synced copy a
  consumer reads, leaving a layout the browser cannot read.

So ``VectorIndex`` writes the flat, deterministic layout itself and loads it without
touching the directory. These tests pin that, including byte-for-byte against the
committed seed bundle.
"""

from __future__ import annotations

import glob
import hashlib
import json
import os
from pathlib import Path

import numpy as np
import pytest
import zstandard as zstd

import edgereco.embeddings.index as index_module
from edgereco.embeddings.index import EMBEDDINGS_FILE, VectorIndex

_CATALOG = Path(__file__).resolve().parents[3] / "examples" / "catalog"
_VECTOR_FILES = ("vector/index.faiss", "vector/state.json", "vector/embeddings.f32")


def _materialize(path: str) -> bytes:
    manifest = json.loads(Path(glob.glob(str(_CATALOG / "manifest" / "*"))[0]).read_bytes())
    entry = next(f for f in manifest["files"] if f["path"] == path)
    dctx = zstd.ZstdDecompressor()
    blob = b"".join(
        dctx.decompress((_CATALOG / "chunk" / ref["hash"]).read_bytes()) for ref in entry["chunks"]
    )
    assert hashlib.sha256(blob).hexdigest() == entry["file_sha256"]
    return blob


def _snapshot(directory: Path) -> dict[str, bytes]:
    return {
        path.relative_to(directory).as_posix(): path.read_bytes()
        for path in sorted(directory.rglob("*"))
        if path.is_file()
    }


def _tiny(tmp_path: Path) -> Path:
    directory = tmp_path / "vector"
    VectorIndex.build(np.eye(3, 4, dtype=np.float32), ["x", "y", "z"], dim=4).save(directory)
    return directory


def test_save_writes_exactly_the_flat_bundle_layout(tmp_path: Path) -> None:
    directory = _tiny(tmp_path)
    assert sorted(_snapshot(directory)) == ["embeddings.f32", "index.faiss", "state.json"]
    assert json.loads((directory / "state.json").read_bytes())["faiss_ids"] == ["x", "y", "z"]


def test_save_is_deterministic(tmp_path: Path) -> None:
    assert _snapshot(_tiny(tmp_path / "a")) == _snapshot(_tiny(tmp_path / "b"))


def test_load_leaves_the_directory_untouched(tmp_path: Path) -> None:
    directory = _tiny(tmp_path)
    before = _snapshot(directory)

    loaded = VectorIndex.load(directory)

    assert _snapshot(directory) == before
    assert loaded.search(np.eye(3, 4, dtype=np.float32)[1], k=1)[0][0] == "y"


def test_committed_seed_vectors_round_trip_byte_for_byte(tmp_path: Path) -> None:
    """Load the committed bundle's ``vector/`` and save it again: identical bytes.

    This is the compatibility proof in both directions: today's code reads what the
    committed bundle carries, and a republish writes exactly what every tier (and
    the committed seed) already expects.
    """
    source = tmp_path / "synced" / "vector"
    source.mkdir(parents=True)
    committed = {path: _materialize(path) for path in _VECTOR_FILES}
    for path, data in committed.items():
        (tmp_path / "synced" / path).write_bytes(data)

    VectorIndex.load(source).save(tmp_path / "again" / "vector")

    again = _snapshot(tmp_path / "again" / "vector")
    assert again == {path.removeprefix("vector/"): data for path, data in committed.items()}
    assert EMBEDDINGS_FILE in again


def test_load_refuses_a_symlinked_vector_file(tmp_path: Path) -> None:
    directory = _tiny(tmp_path)
    real = tmp_path / "elsewhere.json"
    (directory / "state.json").rename(real)
    (directory / "state.json").symlink_to(real)

    with pytest.raises(ValueError, match="symlinked"):
        VectorIndex.load(directory)


def test_load_refuses_a_fifo_without_blocking(tmp_path: Path) -> None:
    directory = _tiny(tmp_path)
    (directory / "state.json").unlink()
    os.mkfifo(directory / "state.json")

    with pytest.raises(ValueError, match="regular file"):
        VectorIndex.load(directory)


def test_load_refuses_an_oversized_vector_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    directory = _tiny(tmp_path)
    monkeypatch.setattr(index_module, "MAX_VECTOR_FILE_BYTES", 16)

    with pytest.raises(ValueError, match="larger than 16 bytes"):
        VectorIndex.load(directory)


def test_save_replaces_a_planted_symlink_instead_of_writing_through_it(tmp_path: Path) -> None:
    directory = tmp_path / "vector"
    directory.mkdir()
    outside = tmp_path / "outside.json"
    outside.write_text("do not touch", encoding="utf-8")
    (directory / "state.json").symlink_to(outside)

    VectorIndex.build(np.eye(3, 4, dtype=np.float32), ["x", "y", "z"], dim=4).save(directory)

    assert outside.read_text(encoding="utf-8") == "do not touch"
    assert not (directory / "state.json").is_symlink()
    assert json.loads((directory / "state.json").read_bytes())["faiss_ids"] == ["x", "y", "z"]


def test_save_refuses_a_symlinked_vector_directory(tmp_path: Path) -> None:
    real = tmp_path / "real"
    real.mkdir()
    (tmp_path / "vector").symlink_to(real, target_is_directory=True)

    with pytest.raises(ValueError, match="symlink"):
        VectorIndex.build(np.eye(3, 4, dtype=np.float32), ["x", "y", "z"], dim=4).save(
            tmp_path / "vector"
        )
    assert list(real.iterdir()) == []
