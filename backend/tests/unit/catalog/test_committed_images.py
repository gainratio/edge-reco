"""Every product in the committed bundle has its picture, in both places it is served.

The signed bundle carries ``images/<id>.svg`` and the static origin serves the same
file from ``frontend/app/public/images``. If either copy is missing the shopper sees
a broken tile; if the two differ, the site shows art the signature does not cover.
And if the committed cards are not what the renderer makes today, someone changed
the renderer without re-signing (``scripts/rebuild_example_bundle.py``).
"""

from __future__ import annotations

import glob
import hashlib
import json
from functools import cache
from pathlib import Path
from typing import Final

import zstandard as zstd

from edgereco.catalog.models import Product
from edgereco.catalog.product_image import generate_product_image, local_image_url

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


@cache
def _products() -> list[Product]:
    raw = _materialize("products.jsonl").decode("utf-8")
    return [Product.model_validate_json(line) for line in raw.split("\n") if line.strip()]


def test_the_manifest_resolves_under_a_glob_too() -> None:
    # Guard the guard: exactly one manifest, and it is the one `latest` names.
    assert len(glob.glob(str(_CATALOG / "manifest" / "*"))) == 1


def test_every_product_points_at_its_own_local_card() -> None:
    products = _products()
    assert len(products) == 720
    wrong = [p.id for p in products if p.image_url != local_image_url(p.id)]
    assert wrong == []


def test_every_product_card_is_signed_into_the_bundle() -> None:
    missing = [p.id for p in _products() if f"images/{p.id}.svg" not in _manifest()]
    assert missing == []


def test_every_product_card_is_served_by_the_static_origin() -> None:
    missing = [p.id for p in _products() if not (_PUBLIC_IMAGES / f"{p.id}.svg").is_file()]
    assert missing == []


def test_static_origin_serves_exactly_the_signed_bytes() -> None:
    differ = [
        p.id
        for p in _products()
        if hashlib.sha256((_PUBLIC_IMAGES / f"{p.id}.svg").read_bytes()).hexdigest()
        != _manifest()[f"images/{p.id}.svg"]["file_sha256"]
    ]
    assert differ == []


def test_static_origin_has_no_orphan_images() -> None:
    ids = {p.id for p in _products()}
    orphans = sorted(f.name for f in _PUBLIC_IMAGES.iterdir() if f.stem not in ids)
    assert orphans == []


def test_committed_cards_are_what_the_renderer_makes_today() -> None:
    stale = [
        p.id
        for p in _products()
        if _materialize(f"images/{p.id}.svg") != generate_product_image(p).encode("utf-8")
    ]
    assert stale == []
