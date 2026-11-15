"""Build the signed 1,000,000-product 64-shard ``IVF-TurboQuant`` catalog bundle.

Reads the 720 shelf exemplars + 99,280 real-item embeddings and metadata, partitions
into 64 coarse spherical-k-means IVF cells, expands deterministically to 1,000,000
unique SKUs across ``shards/shard_00.sqlite`` .. ``shards/shard_63.sqlite``, and signs
``examples/catalog`` (``v1``) plus ``examples/catalog-delta`` (``v2``).
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import sqlite3
import tempfile
import time
from collections import Counter
from concurrent.futures import ProcessPoolExecutor
from contextlib import closing
from dataclasses import dataclass
from pathlib import Path
from typing import Final

import numpy as np
import zstandard as zstd
from numpy.typing import NDArray

from edgereco.catalog.product_image import ImageMode
from edgereco.catalog.publish import publish_bundle
from edgereco.catalog.sharded_bundle import (
    IVF_CENTROIDS_NAME,
    ProductRow,
    build_shard_sqlite,
    product_id_for_shard,
    shard_relpath,
)
from edgereco.catalog.turboquant import partition_ivf_shards

BACKEND_ROOT: Final[Path] = Path(__file__).resolve().parent.parent
REPO_ROOT: Final[Path] = BACKEND_ROOT.parent
CATALOG_DIR: Final[Path] = BACKEND_ROOT / "examples" / "catalog"
DELTA_DIR: Final[Path] = BACKEND_ROOT / "examples" / "catalog-delta"
FIXTURE_CATALOG: Final[Path] = (
    REPO_ROOT / "frontend/packages/edgereco-browser/src/engine/__fixtures__/bundle/catalog"
)
KEY_PATH: Final[Path] = BACKEND_ROOT / "examples" / "keys" / "private.key"
CATALOG_ID: Final[str] = "amazon-demo"
EMBEDDING_MODEL: Final[str] = "sentence-transformers/all-MiniLM-L6-v2"
DIM: Final[int] = 384
N_SHARDS: Final[int] = 64
EXEMPLAR_COUNT: Final[int] = 720
TARGET_TOTAL: Final[int] = 1_000_000
EDITIONS: Final[tuple[str, ...]] = (
    "",
    "Blk",
    "Slv",
    "Blu",
    "Grn",
    "Wht",
    "2Pk",
    "Pro",
    "Max",
    "Set",
    "Lux",
)


@dataclass(frozen=True)
class BaseRow:
    product_id: str
    title: str
    description: str
    category: str
    tags_json: str
    brand: str
    price: float
    popularity: float
    freshness: float
    image_url: str


def _materialize_from(origin: Path, relpath: str) -> bytes:
    latest = json.loads((origin / "latest").read_text(encoding="utf-8"))
    manifest = json.loads((origin / "manifest" / latest["manifest_hash"]).read_bytes())
    entry = next(f for f in manifest["files"] if f["path"] == relpath)
    dctx = zstd.ZstdDecompressor()
    blob = b"".join(
        dctx.decompress((origin / "chunk" / c["hash"]).read_bytes()) for c in entry["chunks"]
    )
    if hashlib.sha256(blob).hexdigest() != entry["file_sha256"]:
        raise ValueError(f"{relpath} failed sha256 verification")
    return blob


def _next_safe_sequence() -> int:
    seqs: list[int] = []
    for folder in (CATALOG_DIR, DELTA_DIR):
        latest_path = folder / "latest"
        if latest_path.is_file():
            raw = json.loads(latest_path.read_text(encoding="utf-8"))
            if isinstance(raw.get("sequence"), int):
                seqs.append(int(raw["sequence"]))
    return max(seqs, default=0) + 1


def _load_exemplar_f32_vectors() -> NDArray[np.float32]:
    raw = _materialize_from(FIXTURE_CATALOG, "vector/embeddings.f32")
    vecs = np.frombuffer(raw, dtype=np.float32).reshape(-1, DIM)[:EXEMPLAR_COUNT].copy()
    norms = np.linalg.norm(vecs, axis=1, keepdims=True)
    return (vecs / np.maximum(norms, 1e-12)).astype(np.float32)


def _load_base_100k() -> tuple[list[BaseRow], NDArray[np.float32]]:
    sqlite_bytes = _materialize_from(CATALOG_DIR, "catalogue.sqlite")
    with tempfile.NamedTemporaryFile(suffix=".sqlite") as tmp:
        tmp.write(sqlite_bytes)
        tmp.flush()
        with closing(sqlite3.connect(tmp.name)) as conn:
            raw_rows = conn.execute(
                "SELECT id, title, description, category, tags_json, brand, price, "
                "popularity_score, freshness_score, image_url, embedding "
                "FROM products ORDER BY rowid ASC"
            ).fetchall()
    items = [BaseRow(*r[:10]) for r in raw_rows]
    int8_mat = np.vstack([np.frombuffer(r[10], dtype=np.int8) for r in raw_rows]).astype(np.float32)
    norms = np.linalg.norm(int8_mat, axis=1, keepdims=True)
    unit = (int8_mat / np.maximum(norms, 1e-12)).astype(np.float32)
    unit[:EXEMPLAR_COUNT] = _load_exemplar_f32_vectors()
    return items, unit


def _compact_tags(tags_json: str, category: str) -> tuple[str, str]:
    parsed = json.loads(tags_json)
    tag = str(parsed[0])[:10] if parsed else (category.split()[0].lower() if category else "")
    tags_list = [tag] if tag else []
    return tag, json.dumps(tags_list, ensure_ascii=False, separators=(",", ":"))


def _variant_product_row(
    rowid: int,
    base: BaseRow,
    shard_idx: int,
    variant: int,
) -> ProductRow:
    pid = product_id_for_shard(base.product_id, shard_idx, variant)
    stem = (
        base.title[:38].strip()
        if variant == 0
        else f"{base.title[:34].strip()} {EDITIONS[variant]}"
    )
    tag_str, tag_json = _compact_tags(base.tags_json, base.category)
    price = (
        base.price
        if variant == 0
        else round(max(0.99, base.price * (1.0 + 0.03 * ((variant % 5) - 2))), 2)
    )
    pop = round(min(1.0, max(0.0, base.popularity - 0.004 * variant)), 4)
    fresh = round(min(1.0, max(0.0, base.freshness + 0.003 * ((variant % 4) - 1))), 4)
    return (
        rowid,
        pid,
        stem,
        "",
        base.category,
        tag_str,
        tag_json,
        base.brand[:12].strip(),
        price,
        pop,
        fresh,
        base.image_url,
        b"",
    )


def _exemplar_product_row(
    rowid: int, base: BaseRow, price_override: float | None = None
) -> ProductRow:
    tags_list = [str(t) for t in json.loads(base.tags_json)]
    return (
        rowid,
        base.product_id,
        base.title,
        base.description,
        base.category,
        " ".join(tags_list),
        json.dumps(tags_list, ensure_ascii=False, separators=(",", ":")),
        base.brand,
        price_override if price_override is not None else base.price,
        base.popularity,
        base.freshness,
        base.image_url,
        b"",
    )


def _variant_vector(
    base_vec: NDArray[np.float32],
    centroid: NDArray[np.float32],
    variant: int,
) -> NDArray[np.float32]:
    if variant == 0:
        return base_vec
    shifted = np.roll(base_vec, variant * 17)
    blended = 0.95 * base_vec + 0.04 * centroid + 0.01 * shifted
    norm = float(np.linalg.norm(blended))
    return (blended / max(norm, 1e-12)).astype(np.float32)


def _compile_one_shard(
    args: tuple[int, list[ProductRow], NDArray[np.float32], dict[str, int] | None],
) -> tuple[int, bytes]:
    shard_idx, rows, matrix, counts = args
    return shard_idx, build_shard_sqlite(rows, matrix, global_counts=counts)


def _partition_1m(
    items: list[BaseRow],
    unit_vecs: NDArray[np.float32],
) -> tuple[NDArray[np.float32], list[list[ProductRow]], list[NDArray[np.float32]], dict[str, int]]:
    amazon_items = items[EXEMPLAR_COUNT:]
    amazon_vecs = unit_vecs[EXEMPLAR_COUNT:]
    centroids, labels = partition_ivf_shards(amazon_vecs, n_shards=N_SHARDS, max_iter=15, seed=42)
    shard_rows: list[list[ProductRow]] = [[] for _ in range(N_SHARDS)]
    shard_vecs: list[list[NDArray[np.float32]]] = [[] for _ in range(N_SHARDS)]
    cat_counts: Counter[str] = Counter()
    for idx in range(EXEMPLAR_COUNT):
        shard_rows[0].append(_exemplar_product_row(idx, items[idx]))
        shard_vecs[0].append(unit_vecs[idx])
        cat_counts[items[idx].category] += 1
    extra_cutoff = TARGET_TOTAL - EXEMPLAR_COUNT - len(amazon_items) * 10
    for idx, base in enumerate(amazon_items):
        shard_idx = int(labels[idx])
        variants = 11 if idx < extra_cutoff else 10
        for variant in range(variants):
            rowid = len(shard_rows[shard_idx])
            shard_rows[shard_idx].append(_variant_product_row(rowid, base, shard_idx, variant))
            shard_vecs[shard_idx].append(
                _variant_vector(amazon_vecs[idx], centroids[shard_idx], variant)
            )
            cat_counts[base.category] += 1
    counts = {"": sum(cat_counts.values()), **dict(cat_counts)}
    matrices = [np.vstack(v).astype(np.float32) for v in shard_vecs]
    return centroids, shard_rows, matrices, counts


def _stage_common_assets(staging: Path) -> None:
    (staging / "shards").mkdir(parents=True, exist_ok=True)
    (staging / "images").mkdir(parents=True, exist_ok=True)
    for name in ("ranking_config.json", "cooccurrence.json"):
        (staging / name).write_bytes(_materialize_from(CATALOG_DIR, name))
    latest = json.loads((CATALOG_DIR / "latest").read_text(encoding="utf-8"))
    manifest = json.loads((CATALOG_DIR / "manifest" / latest["manifest_hash"]).read_bytes())
    for entry in manifest["files"]:
        path = str(entry["path"])
        if path.startswith("images/"):
            (staging / path).write_bytes(_materialize_from(CATALOG_DIR, path))


def _discounted_price(price: float) -> float:
    discounted = max(1, int(price * 0.8)) + 0.99
    return round(max(0.99, price - 2.0), 2) if discounted == price else discounted


def _rebuild_delta_shard0(
    items: list[BaseRow],
    shard0_rows: list[ProductRow],
    shard0_matrix: NDArray[np.float32],
    counts: dict[str, int],
) -> bytes:
    updated = list(shard0_rows)
    for idx in range(4):
        updated[idx] = _exemplar_product_row(idx, items[idx], _discounted_price(items[idx].price))
    return build_shard_sqlite(updated, shard0_matrix, global_counts=counts)


def _assert_caps_and_report(origin: Path, label: str) -> tuple[int, int]:
    latest = json.loads((origin / "latest").read_text(encoding="utf-8"))
    manifest = json.loads((origin / "manifest" / latest["manifest_hash"]).read_bytes())
    files = manifest["files"]
    total_uncompressed = sum(int(f["size"]) for f in files)
    refs = [c["hash"] for f in files for c in f["chunks"]]
    distinct = len(set(refs))
    compressed_bytes = sum(p.stat().st_size for p in (origin / "chunk").iterdir())
    print(
        f"[{label}] files={len(files)} uncompressed={total_uncompressed / (1024**2):.2f} MiB "
        f"compressed={compressed_bytes / 1e6:.2f} MB distinct_chunks={distinct} refs={len(refs)}"
    )
    assert len(files) <= 1024, f"file count {len(files)} > 1024"
    assert total_uncompressed < 512 * 1024 * 1024, f"uncompressed {total_uncompressed} >= 512 MiB"
    assert distinct <= 4096, f"distinct chunks {distinct} > 4096"
    assert len(refs) <= 8192, f"chunk refs {len(refs)} > 8192"
    return distinct, compressed_bytes


def _drop_scratch(origin: Path) -> None:
    for sub in ("chunks", "manifests"):
        shutil.rmtree(origin / sub, ignore_errors=True)
    (origin / "active").unlink(missing_ok=True)
    (origin / ".publish.lock").unlink(missing_ok=True)


def _write_delta_overlay(delta_origin: Path) -> tuple[int, int]:
    shutil.rmtree(DELTA_DIR, ignore_errors=True)
    (DELTA_DIR / "manifest").mkdir(parents=True, exist_ok=True)
    (DELTA_DIR / "chunk").mkdir(parents=True, exist_ok=True)
    shutil.copy2(delta_origin / "latest", DELTA_DIR / "latest")
    for mf in (delta_origin / "manifest").iterdir():
        shutil.copy2(mf, DELTA_DIR / "manifest" / mf.name)
    base_chunks = {p.name for p in (CATALOG_DIR / "chunk").iterdir()}
    new_chunks = 0
    new_bytes = 0
    for cf in (delta_origin / "chunk").iterdir():
        if cf.name not in base_chunks:
            shutil.copy2(cf, DELTA_DIR / "chunk" / cf.name)
            new_chunks += 1
            new_bytes += cf.stat().st_size
    return new_chunks, new_bytes


def main() -> None:
    t0 = time.perf_counter()
    v1_seq = _next_safe_sequence()
    v2_seq = v1_seq + 1
    items, unit_vecs = _load_base_100k()
    centroids, shard_rows, matrices, counts = _partition_1m(items, unit_vecs)
    assert counts[""] == TARGET_TOTAL
    staging = CATALOG_DIR.parent / "_staging_1m"
    delta_origin = CATALOG_DIR.parent / "_delta_1m"
    shutil.rmtree(staging, ignore_errors=True)
    shutil.rmtree(delta_origin, ignore_errors=True)
    _stage_common_assets(staging)
    (staging / IVF_CENTROIDS_NAME).write_bytes(centroids.astype("<f4").tobytes())
    tasks = [(s, shard_rows[s], matrices[s], counts if s == 0 else None) for s in range(N_SHARDS)]
    workers = min(N_SHARDS, os.cpu_count() or 8)
    with ProcessPoolExecutor(max_workers=workers) as pool:
        for shard_idx, payload in pool.map(_compile_one_shard, tasks):
            (staging / shard_relpath(shard_idx)).write_bytes(payload)
    print(
        f"compiled {N_SHARDS} shards ({TARGET_TOTAL:,} products) in {time.perf_counter() - t0:.1f}s"
    )
    for sub in ("manifest", "chunk"):
        shutil.rmtree(CATALOG_DIR / sub, ignore_errors=True)
    (CATALOG_DIR / "latest").unlink(missing_ok=True)
    KEY_PATH.chmod(0o600)
    publish_bundle(
        staging_dir=staging,
        origin_dir=CATALOG_DIR,
        private_key_path=KEY_PATH,
        catalog_id=CATALOG_ID,
        version="v1",
        embedding_model=EMBEDDING_MODEL,
        embedding_dim=DIM,
        embedding_count=TARGET_TOTAL,
        product_count=TARGET_TOTAL,
        sequence=v1_seq,
        image_mode=ImageMode.LOCAL,
        sqlite_only=True,
        ivf_shards=N_SHARDS,
    )
    _assert_caps_and_report(CATALOG_DIR, f"v1 seq={v1_seq}")
    (staging / shard_relpath(0)).write_bytes(
        _rebuild_delta_shard0(items, shard_rows[0], matrices[0], counts)
    )
    publish_bundle(
        staging_dir=staging,
        origin_dir=delta_origin,
        private_key_path=KEY_PATH,
        catalog_id=CATALOG_ID,
        version="v2",
        embedding_model=EMBEDDING_MODEL,
        embedding_dim=DIM,
        embedding_count=TARGET_TOTAL,
        product_count=TARGET_TOTAL,
        sequence=v2_seq,
        image_mode=ImageMode.LOCAL,
        sqlite_only=True,
        ivf_shards=N_SHARDS,
    )
    _assert_caps_and_report(delta_origin, f"v2 seq={v2_seq}")
    delta_chunks, delta_bytes = _write_delta_overlay(delta_origin)
    print(f"[delta] new_chunks={delta_chunks} new_bytes={delta_bytes} B")
    if delta_chunks > 3 or delta_bytes >= 60_000:
        raise ValueError(f"delta too big: {delta_chunks} chunks, {delta_bytes} B")
    _drop_scratch(CATALOG_DIR)
    shutil.rmtree(delta_origin, ignore_errors=True)
    shutil.rmtree(staging, ignore_errors=True)
    print(f"done in {time.perf_counter() - t0:.1f}s")


if __name__ == "__main__":
    main()
