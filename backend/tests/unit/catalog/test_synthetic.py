"""The synthetic demo catalog: deterministic, owned outright, and free of real brands.

The Nimbus storefront used to ship a subset of a third-party Amazon dataset whose
upstream grants no license. It now ships a catalog generated from committed
vocabulary (``synthetic_vocab.json``) by ``edgereco.catalog.synthetic``. These tests
pin the three promises that replacement makes: same seed gives the same bytes, the
committed csv IS that output, and no real brand or old-dataset id is in it.
"""

from __future__ import annotations

import csv
import io
import re
from collections import Counter
from pathlib import Path
from typing import Final

import pytest

from edgereco.catalog.preprocessor import BREADCRUMB_SEP, scraped_row_to_product
from edgereco.catalog.synthetic import (
    CSV_COLUMNS,
    DEFAULT_SEED,
    generate_rows,
    load_vocab,
    render_csv,
)

COMMITTED_CSV: Final = Path(__file__).resolve().parents[3] / "examples/source/catalog.csv"

#: Unambiguous real brand and product-line names. Matched as whole words, anywhere.
DENY_ANYWHERE: Final = (
    "Amazon",
    "Kaggle",
    "McAuley",
    "Apple",
    "iPhone",
    "AirPods",
    "Samsung",
    "Galaxy",
    "Google",
    "Pixel",
    "Android",
    "Sony",
    "Bose",
    "JBL",
    "Anker",
    "Logitech",
    "Razer",
    "Nike",
    "Adidas",
    "Timberland",
    "Levi's",
    "Hanes",
    "Carhartt",
    "Colgate",
    "Oral-B",
    "Philips",
    "Dyson",
    "Cuisinart",
    "KitchenAid",
    "Pyrex",
    "Ziploc",
    "Rubbermaid",
    "Sharpie",
    "Post-it",
    "DeWalt",
    "Makita",
    "Black+Decker",
    "Purina",
    "Yeti",
    "Hydro Flask",
    "Coleman",
    "Garmin",
    "Fitbit",
    "Microsoft",
    "Lenovo",
    "Canon",
    "Nikon",
    "Fujifilm",
    "Instax",
    "Polaroid",
    "Arlo",
    "Wyze",
    "Cricut",
    "Crayola",
    "Prismacolor",
    "Fiskars",
    "Meguiar's",
    "Michelin",
    "Bosch",
    "Energizer",
    "Duracell",
    "Theragun",
    "mDesign",
)
#: Real brands that are also ordinary words ("key ring", "crest of a wave"). These
#: may appear in prose but never as a product's brand.
DENY_AS_BRAND: Final = ("Ring", "Nest", "Crest", "Pilot", "Scotch", "Stanley", "Kong", "Lodge")
#: The old dataset's id shape: a 10-character ASIN starting "B0".
ASIN: Final = re.compile(r"\bB0[0-9A-Z]{8}\b")
#: Products the relevance golden set's `negative` segment asserts are NOT in the store.
ABSENT_PRODUCTS: Final = ("treadmill", "ukulele", "trampoline", "toboggan")


def _rows(text: str) -> list[dict[str, str]]:
    return list(csv.DictReader(io.StringIO(text)))


@pytest.fixture(scope="module")
def generated() -> str:
    return render_csv(generate_rows(DEFAULT_SEED))


def test_same_seed_gives_byte_identical_output(generated: str) -> None:
    assert render_csv(generate_rows(DEFAULT_SEED)) == generated


def test_a_different_seed_gives_a_different_catalog(generated: str) -> None:
    assert render_csv(generate_rows(DEFAULT_SEED + 1)) != generated


def test_the_committed_csv_is_the_generator_output(generated: str) -> None:
    """Hand edits to catalog.csv are drift; regenerate with scripts/generate_catalog.py."""
    assert COMMITTED_CSV.read_text(encoding="utf-8") == generated


def test_shape_matches_the_build_pipeline(generated: str) -> None:
    rows = _rows(generated)
    assert tuple(rows[0].keys()) == CSV_COLUMNS
    assert len(rows) == 720
    assert len({r["asin"] for r in rows}) == 720
    assert len({r["title"] for r in rows}) == 720


def test_every_category_holds_sixty_products(generated: str) -> None:
    roots = Counter(r["breadcrumbs"].split(BREADCRUMB_SEP)[0].strip() for r in _rows(generated))
    assert len(roots) == 12
    assert set(roots.values()) == {60}


def test_rows_parse_into_plausible_products(generated: str) -> None:
    for row in _rows(generated):
        product = scraped_row_to_product(row, pop_min=0, pop_max=1, fresh_min=0, fresh_max=1)
        assert product.price is not None
        assert 0.99 <= product.price <= 999.99
        assert 3.8 <= float(row["rating_stars"]) <= 4.9
        assert int(row["rating_count"]) >= 10
        assert product.description.count(":") >= 4  # "HEADER: sentence." bullets
        assert product.subcategories


def test_prices_stay_inside_each_leaf_range(generated: str) -> None:
    bounds = {
        BREADCRUMB_SEP.join([c.name, *leaf.path]): leaf.price
        for c in load_vocab().categories
        for leaf in c.leaves
    }
    for row in _rows(generated):
        low, high = bounds[row["breadcrumbs"].replace(f" {BREADCRUMB_SEP} ", BREADCRUMB_SEP)]
        assert low <= float(row["price_value"]) <= high


@pytest.mark.parametrize("name", DENY_ANYWHERE)
def test_no_real_brand_name_appears_anywhere(generated: str, name: str) -> None:
    assert not re.search(rf"(?<![\w-]){re.escape(name)}(?![\w-])", generated, re.IGNORECASE)


def test_no_brand_is_an_ordinary_word_real_brand(generated: str) -> None:
    brands = {r["brand_name"].casefold() for r in _rows(generated)}
    assert not brands & {b.casefold() for b in DENY_AS_BRAND}


def test_no_old_dataset_id_or_image_url_survives(generated: str) -> None:
    assert not ASIN.search(generated)
    assert "media-amazon" not in generated
    assert "amazon.com" not in generated.lower()


def test_golden_set_negatives_stay_absent(generated: str) -> None:
    for word in ABSENT_PRODUCTS:
        assert word not in generated.lower()


def test_denylist_guard_can_fail() -> None:
    """The brand guard is only evidence if a real brand makes it red."""
    poisoned = "id,title\nNB-00001,Timberland Waterproof Boot\n"
    assert re.search(r"(?<![\w-])Timberland(?![\w-])", poisoned, re.IGNORECASE)
    assert ASIN.search("B07Q6CKRQL")
