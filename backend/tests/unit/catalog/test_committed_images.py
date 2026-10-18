"""Every product in the committed bundle has its picture, in both places it is served.

The signed bundle carries ``images/<id>.svg`` and the static origin serves the same
file from ``frontend/app/public/images``. If either copy is missing the shopper sees
a broken tile; if the two differ, the site shows art the signature does not cover.
And if the committed cards are not what the renderer makes today, someone changed
the renderer without re-signing (``scripts/rebuild_example_bundle.py``).
"""

from __future__ import annotations

import csv
import glob
import hashlib
import json
import sqlite3
import tempfile
from contextlib import closing
from functools import cache
from pathlib import Path
from typing import Final

import zstandard as zstd

from edgereco.catalog.models import Product
from edgereco.catalog.preprocessor import BREADCRUMB_SEP
from edgereco.catalog.product_image import (
    MAX_SIGNED_CARDS,
    generate_product_image,
    local_image_url,
)

_BACKEND: Final = Path(__file__).resolve().parents[3]
_CATALOG: Final = _BACKEND / "examples" / "catalog"
_PUBLIC_IMAGES: Final = _BACKEND.parent / "frontend" / "app" / "public" / "images"


@cache
def _manifest() -> dict[str, dict[str, object]]:
    latest = json.loads((_CATALOG / "latest").read_text(encoding="utf-8"))
    raw = json.loads((_CATALOG / "manifest" / latest["manifest_hash"]).read_bytes())
    return {entry["path"]: entry for entry in raw["files"]}


def _materialize(path: str) -> bytes:
    entry = _manifest()[path]
    dctx = zstd.ZstdDecompressor()
    chunks = entry["chunks"]
    assert isinstance(chunks, list)
    blob = b"".join(dctx.decompress((_CATALOG / "chunk" / c["hash"]).read_bytes()) for c in chunks)
    assert hashlib.sha256(blob).hexdigest() == entry["file_sha256"]
    return blob


def _source_subcategories() -> dict[str, list[str]]:
    source_csv = _BACKEND / "examples" / "source" / "catalog.csv"
    if not source_csv.is_file():
        return {}
    out: dict[str, list[str]] = {}
    with source_csv.open(newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            crumbs = [
                c.strip() for c in row.get("breadcrumbs", "").split(BREADCRUMB_SEP) if c.strip()
            ]
            if len(crumbs) > 1:
                out[row["asin"]] = crumbs[1:]
    return out


@cache
def _products() -> list[Product]:
    manifest = _manifest()
    if "products.jsonl" in manifest:
        raw = _materialize("products.jsonl").decode("utf-8")
        return [Product.model_validate_json(line) for line in raw.split("\n") if line.strip()]
    subs_by_id = _source_subcategories()
    sqlite_bytes = _materialize("catalogue.sqlite")
    with tempfile.NamedTemporaryFile(suffix=".sqlite") as tmp:
        tmp.write(sqlite_bytes)
        tmp.flush()
        with closing(sqlite3.connect(tmp.name)) as conn:
            rows = conn.execute(
                "SELECT id, title, description, category, tags_json, brand, price, "
                "popularity_score, freshness_score, image_url FROM products ORDER BY rowid ASC"
            ).fetchall()
    return [
        Product(
            id=r[0],
            title=r[1],
            description=r[2],
            category=r[3],
            subcategories=subs_by_id.get(r[0], []),
            tags=json.loads(r[4]),
            brand=r[5],
            price=r[6],
            popularity_score=r[7],
            freshness_score=r[8],
            image_url=r[9],
        )
        for r in rows
    ]


def _signed_image_paths() -> list[str]:
    return [path for path in _manifest() if path.startswith("images/")]


def test_the_manifest_resolves_under_a_glob_too() -> None:
    # Guard the guard: exactly one manifest, and it is the one `latest` names.
    assert len(glob.glob(str(_CATALOG / "manifest" / "*"))) == 1


def test_every_product_points_at_its_own_local_card() -> None:
    products = _products()
    assert len(products) in (5040, 100000)
    by_id = {p.id: p for p in products}
    wrong_pass0 = [
        p.id for p in products[:MAX_SIGNED_CARDS] if p.image_url != local_image_url(p.id)
    ]
    assert wrong_pass0 == []
    mismatched_card = [
        p.id
        for p in products
        if not p.image_url.startswith("/images/") or Path(p.image_url).stem not in by_id
    ]
    assert mismatched_card == []


def test_every_product_card_is_signed_into_the_bundle() -> None:
    missing = [p.id for p in _products() if p.image_url.lstrip("/") not in _manifest()]
    assert missing == []


def test_every_product_card_is_served_by_the_static_origin() -> None:
    missing = [p.id for p in _products() if not (_PUBLIC_IMAGES / Path(p.image_url).name).is_file()]
    assert missing == []


def test_static_origin_serves_exactly_the_signed_bytes() -> None:
    differ = [
        relpath
        for relpath in _signed_image_paths()
        if hashlib.sha256((_PUBLIC_IMAGES / Path(relpath).name).read_bytes()).hexdigest()
        != _manifest()[relpath]["file_sha256"]
    ]
    assert differ == []


def test_static_origin_has_no_orphan_images() -> None:
    referenced = {Path(p.image_url).name for p in _products()}
    orphans = sorted(f.name for f in _PUBLIC_IMAGES.iterdir() if f.name not in referenced)
    assert orphans == []


def test_committed_cards_are_what_the_renderer_makes_today() -> None:
    by_id = {p.id: p for p in _products()}
    stale = [
        relpath
        for relpath in _signed_image_paths()
        if _materialize(relpath)
        != generate_product_image(by_id[Path(relpath).stem]).encode("utf-8")
    ]
    assert stale == []
