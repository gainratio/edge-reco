"""Every product picture must show what the product IS.

The storefront's cards used to be a monogram on a gradient, which reads as a missing
photo. ``edgereco.catalog.product_icons`` maps a product's shelf (category and
subcategory path) to a Lucide icon. These tests pin the promise that makes that worth
shipping: every product in the committed catalog gets an icon chosen for its own shelf,
never the per-category fallback and never the generic box.
"""

from __future__ import annotations

import csv
import json
from importlib import resources
from pathlib import Path
from typing import Final

import pytest

from edgereco.catalog.models import Product
from edgereco.catalog.preprocessor import BREADCRUMB_SEP
from edgereco.catalog.product_icons import (
    CATEGORY_ICONS,
    GENERIC_ICON,
    ICON_SOURCE,
    ICON_VERSION,
    IconTier,
    icon_body,
    icon_for,
    referenced_icon_names,
    vendored_icon_names,
)
from edgereco.catalog.synthetic import load_vocab

COMMITTED_CSV: Final = Path(__file__).resolve().parents[3] / "examples/source/catalog.csv"


def _catalog() -> list[Product]:
    csv.field_size_limit(10**7)
    with COMMITTED_CSV.open(newline="", encoding="utf-8") as handle:
        return [_row_product(row) for row in csv.DictReader(handle)]


def _row_product(row: dict[str, str]) -> Product:
    category, *subcategories = [crumb.strip() for crumb in row["breadcrumbs"].split(BREADCRUMB_SEP)]
    return Product(
        id=row["asin"], title=row["title"], category=category, subcategories=subcategories
    )


def _leaf_products() -> list[Product]:
    """One stand-in product per shelf in the vocabulary, the source of every leaf."""
    products = []
    for category in load_vocab().categories:
        for leaf in category.leaves:
            products.append(
                Product(id="X", title="x", category=category.name, subcategories=list(leaf.path))
            )
    return products


def test_every_committed_product_gets_an_icon_for_its_own_shelf() -> None:
    products = _catalog()
    assert len(products) == 720
    fallbacks = [
        (p.id, p.category, p.subcategories)
        for p in products
        if icon_for(p).tier is not IconTier.LEAF
    ]
    assert fallbacks == []


def test_every_vocabulary_shelf_is_mapped_explicitly() -> None:
    # The vocabulary is what the generator draws from, so a new shelf added there
    # must fail here until it has an icon, not silently ship the category fallback.
    unmapped = [
        (p.category, p.subcategories)
        for p in _leaf_products()
        if icon_for(p).tier is not IconTier.LEAF
    ]
    assert unmapped == []


def test_every_catalog_category_has_its_own_fallback_icon() -> None:
    categories = {p.category for p in _catalog()}
    assert categories == set(CATEGORY_ICONS)
    assert GENERIC_ICON not in CATEGORY_ICONS.values()


def test_unknown_shelf_in_a_known_category_falls_back_to_the_category_icon() -> None:
    product = Product(id="X", title="x", category="Electronics", subcategories=["Robots"])
    choice = icon_for(product)
    assert (choice.tier, choice.name) == (IconTier.CATEGORY, CATEGORY_ICONS["Electronics"])


def test_unknown_category_falls_back_to_the_generic_icon() -> None:
    choice = icon_for(Product(id="X", title="x", category="Moon Rocks"))
    assert (choice.tier, choice.name) == (IconTier.GENERIC, GENERIC_ICON)


def test_deepest_known_shelf_wins() -> None:
    # "Cell Phones" is a leaf of its own AND the parent of nothing here; a
    # deeper unknown shelf must still resolve through the known ancestor.
    product = Product(
        id="X",
        title="x",
        category="Electronics",
        subcategories=["Headphones, Earbuds & Accessories", "Headphones & Earbuds", "Mystery"],
    )
    assert icon_for(product).name == "headphones"


def test_matching_ignores_case_and_surrounding_space() -> None:
    product = Product(
        id="X", title="x", category="Electronics", subcategories=[" usb flash drives "]
    )
    assert icon_for(product).name == "usb"


@pytest.mark.parametrize(
    ("category", "leaf", "icon"),
    [
        ("Electronics", "Over-Ear Headphones", "headphones"),
        ("Electronics", "Instant Cameras", "camera"),
        ("Electronics", "USB Flash Drives", "usb"),
        ("Office Products", "Desk Lamps", "lamp-desk"),
        ("Tools & Home Improvement", "Flush Mount Ceiling Lights", "lamp-ceiling"),
        ("Cell Phones & Accessories", "Basic Cases", "smartphone"),
        ("Arts, Crafts & Sewing", "Beads", "gem"),
        ("Patio, Lawn & Garden", "Ultrasonic Repellers", "squirrel"),
        ("Health & Household", "Ultrasonic Repellers", "bug-off"),
    ],
)
def test_representative_shelves(category: str, leaf: str, icon: str) -> None:
    product = Product(id="X", title="x", category=category, subcategories=[leaf])
    assert icon_for(product).name == icon


def test_every_referenced_icon_is_vendored() -> None:
    assert referenced_icon_names() - vendored_icon_names() == set()


def test_vendored_icons_are_exactly_the_referenced_ones() -> None:
    # No dead weight in the package, and no icon the mapping can't reach.
    assert vendored_icon_names() == referenced_icon_names()


def test_vendored_file_records_its_pinned_source_and_license() -> None:
    raw = resources.files("edgereco.catalog").joinpath("lucide_icons.json").read_text("utf-8")
    meta = json.loads(raw)
    assert meta["package"] == "lucide-static"
    assert meta["version"] == "1.48.0"
    assert meta["license"] == "ISC"
    assert meta["integrity"].startswith("sha512-")
    assert ICON_SOURCE == "lucide-static@1.48.0 (ISC)"


def test_icon_body_is_only_drawing_elements() -> None:
    # The body is spliced into our SVG; it must be plain shapes, never script or
    # an outer <svg> that would reset our transform.
    for name in referenced_icon_names():
        body = icon_body(name)
        assert body
        assert "<svg" not in body
        assert "script" not in body.lower()
        assert "on" + "load" not in body.lower()


def test_notice_carries_the_icon_licenses() -> None:
    # ISC requires the copyright + permission notice with every copy; the
    # Feather-derived icons carry MIT and need theirs too.
    notice = (Path(__file__).resolve().parents[4] / "NOTICE").read_text(encoding="utf-8")
    assert f"lucide-static {ICON_VERSION}" in notice
    assert "Copyright (c) 2026 Lucide Icons and Contributors" in notice
    assert "Permission to use, copy, modify, and/or distribute this software" in notice
    assert "Copyright (c) 2013-present Cole Bemis" in notice


def test_an_icon_that_is_not_vendored_fails_loudly() -> None:
    # A mapping edit without re-vendoring must stop the build, not draw a blank card.
    with pytest.raises(KeyError, match=r"not vendored; run scripts/vendor_lucide_icons\.py"):
        icon_body("definitely-not-a-lucide-icon")
