"""Tests for the deterministic, license-clean product-card SVG generator."""

from __future__ import annotations

import re

import pytest
from defusedxml.minidom import parseString

from edgereco.catalog.models import Product
from edgereco.catalog.product_icons import icon_body
from edgereco.catalog.product_image import (
    generate_product_image,
    image_relpath,
    local_image_url,
)


def _product(**overrides: object) -> Product:
    base: dict[str, object] = {
        "id": "NB-00001",
        "title": "Crafthollow Craft Storage Organizer, Clear, With Handle",
        "category": "Home & Kitchen",
        "brand": "Crafthollow",
        "price": 16.49,
    }
    base.update(overrides)
    return Product.model_validate(base)


def test_local_image_url_is_root_relative() -> None:
    # The frontend's isLocalImage() only trusts root-relative, same-origin paths.
    assert local_image_url("NB-00001") == "/images/NB-00001.svg"


def test_image_relpath_is_bundle_relative() -> None:
    assert image_relpath("NB-00001") == "images/NB-00001.svg"


def test_generation_is_deterministic() -> None:
    # Same catalog input -> byte-identical SVG -> stable bundle hash.
    product = _product()
    assert generate_product_image(product) == generate_product_image(product)


def test_output_is_well_formed_svg() -> None:
    svg = generate_product_image(_product())
    parsed = parseString(svg)  # raises on malformed XML
    assert parsed.documentElement.tagName == "svg"
    assert "http://www.w3.org/2000/svg" in svg


def test_no_placeholder_emoji_tile() -> None:
    # The whole point: a real, intentional card, not the emoji fallback tile.
    svg = generate_product_image(_product())
    assert "✨" not in svg  # the DEFAULT_STYLE sparkle glyph
    assert "\U0001f50c" not in svg  # electronics plug glyph


def test_distinct_products_get_distinct_backgrounds() -> None:
    # Colour comes from the product id, so neighbours on one shelf still differ.
    a = generate_product_image(_product(id="NB-00001"))
    b = generate_product_image(_product(id="NB-00002"))
    assert _fill_stops(a) != _fill_stops(b)


def test_background_is_stable_for_one_product() -> None:
    a = generate_product_image(_product(id="NB-00042", title="One"))
    b = generate_product_image(_product(id="NB-00042", title="Two"))
    assert _fill_stops(a) == _fill_stops(b)


def test_card_shows_the_icon_for_the_product_shelf() -> None:
    product = _product(
        category="Electronics",
        subcategories=["Headphones, Earbuds & Accessories", "Over-Ear Headphones"],
    )
    svg = generate_product_image(product)
    assert icon_body("headphones") in svg
    assert 'data-icon="headphones"' in svg


def test_card_is_a_picture_not_a_monogram() -> None:
    # The old card was initials on a gradient, which read as a missing photo.
    svg = generate_product_image(_product(brand="Crafthollow"))
    assert ">C<" not in svg
    assert 'font-size="96"' not in svg


def test_card_names_the_product_for_assistive_tech() -> None:
    svg = generate_product_image(_product(title="Vantrel Foldable Headphones"))
    assert 'aria-label="Vantrel Foldable Headphones"' in svg


def test_card_stays_small() -> None:
    # 720 of these ship in the signed bundle; the old card averaged ~1.66 KB.
    svg = generate_product_image(_product())
    assert len(svg.encode("utf-8")) < 1600


def test_renders_the_brand_small() -> None:
    # Title and price are page text beside the card; only the brand stays in the art.
    svg = generate_product_image(_product(brand="Crafthollow", price=16.49))
    assert "Crafthollow" in svg
    assert "16.49" not in svg


def test_escapes_xml_hostile_text() -> None:
    # Titles carry ampersands, angle brackets, quotes, and emoji in the real
    # Amazon catalog; the SVG must stay well-formed and inject nothing.
    svg = generate_product_image(
        _product(title='Wax & Seal <Kit> "Deluxe" \U0001f381', brand="A&B")
    )
    parseString(svg)  # must still parse
    assert "<Kit>" not in svg
    assert "&amp;" in svg


@pytest.mark.parametrize("bad_id", ["../etc/passwd", "a/b", "a\\b", "", "a b"])
def test_rejects_unsafe_ids(bad_id: str) -> None:
    with pytest.raises(ValueError, match="unsafe product id"):
        image_relpath(bad_id)
    with pytest.raises(ValueError, match="unsafe product id"):
        local_image_url(bad_id)


def _fill_stops(svg: str) -> list[str]:
    return re.findall(r'stop-color="([^"]+)"', svg)
