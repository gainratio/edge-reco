"""Deterministic generator for the synthetic Nimbus demo catalog (MIT, owned outright).

Every product is assembled from committed vocabulary (``synthetic_vocab.json``):
invented brands, product nouns, title variants and feature sentences written for this
repo, placed on plain descriptive category paths. No external data, no network, no
model calls.

Determinism does not depend on ``random``: every choice is a SHA-256 of
``(seed, product key, field)``, so the same seed yields byte-identical output on any
Python version or platform. The output columns match
``catalog.preprocessor.scraped_row_to_product``, so ``edgereco build-catalog``
consumes it unchanged.
"""

from __future__ import annotations

import csv
import hashlib
import io
from collections.abc import Sequence
from importlib import resources
from typing import Final

from pydantic import BaseModel, ConfigDict

from edgereco.catalog.preprocessor import BREADCRUMB_SEP

DEFAULT_SEED: Final = 20260926
BREADCRUMB_JOIN: Final = f" {BREADCRUMB_SEP} "
CSV_COLUMNS: Final = (
    "asin",
    "title",
    "about_item",
    "breadcrumbs",
    "brand_name",
    "price_value",
    "rating_stars",
    "rating_count",
    "recent_purchases",
    "all_images",
    "product_url",
)
#: Leaf features per product; one category-wide feature is appended after them.
FEATURES_PER_PRODUCT: Final = 4
#: Freshness is a recency rank in days since 2000-01-01 (2020-01-01 .. 2023-09-01).
FRESH_DAYS: Final = (7305, 8644)
#: Separates title parts. Not a comma: the keyword index splits on whitespace only, so
#: "Boot, Black" would index "boot," and a search for "boot" would never match it.
TITLE_SEP: Final = " | "
#: Brands a shelf draws from: a small window of the category's pool.
BRANDS_PER_LEAF: Final = 3


class _Frozen(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


class Leaf(_Frozen):
    """One shelf: a category path plus the words its products are made of."""

    path: tuple[str, ...]
    count: int
    price: tuple[float, float]
    nouns: tuple[str, ...]
    variants: tuple[tuple[str, ...], ...]
    features: tuple[str, ...]


class Category(_Frozen):
    """A top-level department with its invented brands and shared features."""

    name: str
    brands: tuple[str, ...]
    generic_features: tuple[str, ...]
    leaves: tuple[Leaf, ...]


class Vocab(_Frozen):
    """The whole committed vocabulary."""

    about: str
    categories: tuple[Category, ...]


class CatalogRow(_Frozen):
    """One output csv row, in the schema ``build-catalog`` reads."""

    asin: str
    title: str
    about_item: str
    breadcrumbs: str
    brand_name: str
    price_value: str
    rating_stars: str
    rating_count: str
    recent_purchases: str
    all_images: str
    product_url: str


class _Slot(_Frozen):
    """Where one product sits: its category, leaf and position on that leaf."""

    category: Category
    leaf_index: int
    ordinal: int


def load_vocab() -> Vocab:
    """Read and validate the committed vocabulary file."""
    raw = resources.files("edgereco.catalog").joinpath("synthetic_vocab.json").read_text("utf-8")
    return Vocab.model_validate_json(raw)


def _unit(seed: int, *key: object) -> float:
    """A uniform number in [0, 1) derived only from the seed and the key."""
    digest = hashlib.sha256(repr((seed, *key)).encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big") / 2**64


def _pick(options: Sequence[str], seed: int, *key: object) -> str:
    return options[int(_unit(seed, *key) * len(options))]


def _ordered(options: Sequence[str], seed: int, *key: object) -> list[str]:
    """A seeded permutation of ``options`` (sort by a per-item hash)."""
    return sorted(options, key=lambda item: _unit(seed, *key, item))


def _brand(slot: _Slot, seed: int) -> str:
    """A brand from the window that belongs to this product's SHELF (first subcategory).

    Leaves on one shelf share brands (one maker sells massagers and heat wraps); other
    shelves start further along the pool, so a single brand does not tie a massager to
    reading glasses and pull unrelated products into "Recommended for you".
    """
    pool = slot.category.brands
    shelves = list(dict.fromkeys(leaf.path[0] for leaf in slot.category.leaves))
    shelf = slot.category.leaves[slot.leaf_index].path[0]
    start = shelves.index(shelf) * BRANDS_PER_LEAF
    window = [pool[(start + k) % len(pool)] for k in range(BRANDS_PER_LEAF)]
    return _pick(window, seed, slot.category.name, slot.leaf_index, slot.ordinal, "brand")


def _cycled(options: Sequence[str], step: int, seed: int, *key: object) -> str:
    """Walk ``options`` from a seeded offset, so a shelf's products spread across them."""
    return options[(step + int(_unit(seed, *key) * len(options))) % len(options)]


def _title(slot: _Slot, seed: int, salt: int) -> str:
    """Brand, noun and one choice per variant group: "Acme Mouse | Silent Click".

    The noun and the first variant are walked in order (every noun/first-variant pair
    appears before any repeats) so one shelf does not fill with near-duplicates; the
    remaining variants are hashed. ``salt`` re-rolls only on a whole-title collision.
    """
    leaf = slot.category.leaves[slot.leaf_index]
    key = (slot.category.name, slot.leaf_index)
    noun = _cycled(leaf.nouns, slot.ordinal, seed, *key, "noun")
    first = _cycled(leaf.variants[0], slot.ordinal // len(leaf.nouns), seed, *key, "v0")
    rest = [
        _pick(group, seed, *key, slot.ordinal, salt, "variant", i)
        for i, group in enumerate(leaf.variants[1:], start=1)
    ]
    return TITLE_SEP.join([f"{_brand(slot, seed)} {noun}", first, *rest])


def _about(slot: _Slot, seed: int) -> str:
    leaf = slot.category.leaves[slot.leaf_index]
    key = (slot.category.name, slot.leaf_index, slot.ordinal)
    chosen = _ordered(leaf.features, seed, *key, "features")[:FEATURES_PER_PRODUCT]
    generic = _pick(slot.category.generic_features, seed, *key, "generic")
    return " ".join([*chosen, generic])


def _price(leaf: Leaf, seed: int, *key: object) -> str:
    """A shelf price inside the leaf range, ending in .99 like a real store."""
    low, high = leaf.price
    raw = low + _unit(seed, *key, "price") * (high - low)
    return f"{max(low, min(high, int(raw) + 0.99)):.2f}"


def _stars(seed: int, *key: object) -> str:
    """Ratings cluster around 4.5, the way a curated store's do (3.9 .. 4.9)."""
    mean = (_unit(seed, *key, "s1") + _unit(seed, *key, "s2")) / 2
    return f"{3.9 + round(mean * 10) / 10:.1f}"


def _count(seed: int, *key: object) -> str:
    """Review counts are long-tailed: log-uniform between ~40 and ~60,000."""
    return str(int(40 * 1500 ** _unit(seed, *key, "count")))


def _row(slot: _Slot, seed: int, title: str, number: int) -> CatalogRow:
    leaf = slot.category.leaves[slot.leaf_index]
    key = (slot.category.name, slot.leaf_index, slot.ordinal)
    low, high = FRESH_DAYS
    return CatalogRow(
        asin=f"NB-{number:05d}",
        title=title,
        about_item=_about(slot, seed),
        breadcrumbs=BREADCRUMB_JOIN.join([slot.category.name, *leaf.path]),
        brand_name=_brand(slot, seed),
        price_value=_price(leaf, seed, *key),
        rating_stars=_stars(seed, *key),
        rating_count=_count(seed, *key),
        recent_purchases=str(low + int(_unit(seed, *key, "fresh") * (high - low))),
        all_images="[]",
        product_url="",
    )


def _slots(vocab: Vocab) -> list[_Slot]:
    return [
        _Slot(category=category, leaf_index=index, ordinal=ordinal)
        for category in vocab.categories
        for index, leaf in enumerate(category.leaves)
        for ordinal in range(leaf.count)
    ]


def _unique_title(slot: _Slot, seed: int, taken: set[str]) -> str:
    """Re-roll the title with a salt until it is unused in the catalog."""
    salt = 0
    while (title := _title(slot, seed, salt)) in taken:
        salt += 1
    taken.add(title)
    return title


def generate_rows(seed: int = DEFAULT_SEED, vocab: Vocab | None = None) -> list[CatalogRow]:
    """Every catalog row, in category then leaf order. Pure: no I/O besides the vocab."""
    source = vocab or load_vocab()
    taken: set[str] = set()
    return [
        _row(slot, seed, _unique_title(slot, seed, taken), number)
        for number, slot in enumerate(_slots(source), start=1)
    ]


def render_csv(rows: Sequence[CatalogRow]) -> str:
    """The rows as csv text with ``\\n`` line endings (byte-stable across platforms)."""
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=CSV_COLUMNS, lineterminator="\n")
    writer.writeheader()
    writer.writerows(row.model_dump() for row in rows)
    return buffer.getvalue()
