"""Which picture a product card shows: a Lucide icon chosen by the product's shelf.

A card that shows a monogram reads as a missing photo. A card that shows a pair of
headphones reads as headphones. This module is the one place that knows about the
icon set: ``icon_for`` maps a product's category and subcategory path to a Lucide
icon, and ``icon_body`` returns that icon's drawing so the card renderer can splice
it in. Swapping icon sets means changing this file and its vendored data only.

The icon drawings are vendored in ``lucide_icons.json`` (only the icons the mapping
uses) by ``scripts/vendor_lucide_icons.py``, which downloads the pinned
``lucide-static`` release and checks its npm integrity hash first. Lucide is ISC
licensed (a few icons are MIT, from Feather); the notice is in the repo's NOTICE.

Lookup order, most specific first:

1. ``"<category> > <shelf>"`` for the rare shelf name two departments share but
   that means different things (an ultrasonic repeller for mice vs. for deer);
2. each subcategory, deepest first (``SHELF_ICONS``);
3. the product's top-level category (``CATEGORY_ICONS``);
4. ``GENERIC_ICON``.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from enum import StrEnum
from functools import cache
from importlib import resources
from types import MappingProxyType
from typing import Final

from .models import Product

ICON_PACKAGE: Final = "lucide-static"
ICON_VERSION: Final = "1.48.0"
ICON_LICENSE: Final = "ISC"
ICON_SOURCE: Final = f"{ICON_PACKAGE}@{ICON_VERSION} ({ICON_LICENSE})"
ICON_FILE: Final = "lucide_icons.json"
GENERIC_ICON: Final = "package"


class IconTier(StrEnum):
    """How specific the chosen icon is. Coverage tests demand ``LEAF`` everywhere."""

    LEAF = "leaf"
    CATEGORY = "category"
    GENERIC = "generic"


@dataclass(frozen=True)
class IconChoice:
    """The icon a product gets and how it was reached."""

    name: str
    tier: IconTier


#: Top-level department -> the icon used when a shelf is not mapped below.
CATEGORY_ICONS: Final = MappingProxyType(
    {
        "Arts, Crafts & Sewing": "palette",
        "Automotive": "car",
        "Cell Phones & Accessories": "smartphone",
        "Clothing, Shoes & Jewelry": "shirt",
        "Electronics": "monitor-smartphone",
        "Health & Household": "heart-pulse",
        "Home & Kitchen": "sofa",
        "Office Products": "briefcase",
        "Patio, Lawn & Garden": "sprout",
        "Pet Supplies": "paw-print",
        "Sports & Outdoors": "trophy",
        "Tools & Home Improvement": "toolbox",
    }
)

#: Shelf names that mean different things in different departments.
QUALIFIED_SHELF_ICONS: Final = MappingProxyType(
    {
        "health & household > ultrasonic repellers": "bug-off",
        "patio, lawn & garden > ultrasonic repellers": "squirrel",
    }
)

#: Shelf (any level of the subcategory path, case-insensitive) -> icon.
SHELF_ICONS: Final = MappingProxyType(
    {
        # Cell Phones & Accessories
        "screen protectors": "shield-check",
        "basic cases": "smartphone",
        "smartwatch bands": "watch",
        "cell phones": "smartphone-nfc",
        "wall chargers": "plug-zap",
        "car cradles & mounts": "car-front",
        "power banks": "battery-charging",
        "usb cables": "cable",
        # Clothing, Shoes & Jewelry
        "t-shirts": "shirt",
        "bodysuits": "baby",
        "active sweatshirts": "shirt",
        "fashion sneakers": "sport-shoe",
        "hiking boots": "mountain",
        "casual dresses": "shirt",
        "pendant necklaces": "gem",
        "wallets": "wallet",
        "athletic socks": "footprints",
        # Electronics
        "traditional laptops": "laptop",
        "headphones & earbuds": "headphones",
        "earbud headphones": "headphones",
        "over-ear headphones": "headphones",
        "portable bluetooth speakers": "speaker",
        "dome cameras": "cctv",
        "bullet cameras": "cctv",
        "instant cameras": "camera",
        "keyboards": "keyboard",
        "mice": "mouse",
        "usb flash drives": "usb",
        "tv mounts": "tv",
        # Health & Household
        "snore reducing aids": "moon",
        "ultrasonic repellers": "bug-off",
        "food storage bags": "sandwich",
        "toothpaste": "toothbrush",
        "reading glasses": "glasses",
        "collagen": "pill-bottle",
        "handheld massagers": "vibrate",
        "hot & cold therapies": "thermometer-snowflake",
        "blood pressure monitors": "heart-pulse",
        "microfiber cloths": "brush-cleaning",
        "first aid kits": "briefcase-medical",
        # Home & Kitchen
        "frying pans & skillets": "cooking-pot",
        "chef's knives": "utensils-crossed",
        "food storage containers": "salad",
        "pour-over coffee makers": "coffee",
        "insulated tumblers": "cup-soda",
        "sheet & pillowcase sets": "bed-double",
        "bed pillows": "bed-single",
        "bath towels": "towel-rack",
        "throw pillow covers": "sofa",
        "jar candles": "flame",
        # Office Products
        "mouse pads": "square-mouse-pointer",
        "planners": "calendar-days",
        "greeting cards": "mail",
        "gel ink pens": "pen",
        "highlighters": "highlighter",
        "notebooks": "notebook",
        "labels": "sticker",
        "label makers": "printer",
        "desktop calculators": "calculator",
        "desk lamps": "lamp-desk",
        # Patio, Lawn & Garden
        "garden hoses": "droplets",
        "drip irrigation kits": "droplet",
        "umbrellas": "umbrella",
        "planters": "plant-pot",
        "pathway lights": "lamp-floor",
        "pruning shears": "scissors",
        "chair cushions": "armchair",
        "grill tool sets": "beef",
        "vegetable seeds": "sprout",
        # Pet Supplies
        "sonic bark deterrents": "volume-x",
        "beds": "dog",
        "harnesses": "dog",
        "chew toys": "bone",
        "litter mats": "cat",
        "teaser wands": "feather",
        "cat trees": "cat",
        "fountains": "droplets",
        "aquarium lights": "fish",
        "chews & toys": "rabbit",
        # Sports & Outdoors
        "yoga mats": "person-standing",
        "dumbbells": "dumbbell",
        "water bottles": "milk",
        "lures": "fishing-hook",
        "hiking daypacks": "backpack",
        "camping tents": "tent",
        "soccer balls": "volleyball",
        "stadium seats": "armchair",
        "running shorts": "shirt",
        # Tools & Home Improvement
        "disposable cup dust safety masks": "hard-hat",
        "work gloves": "hand",
        "led bulbs": "lightbulb",
        "flush mount ceiling lights": "lamp-ceiling",
        "night lights": "moon-star",
        "screwdriver sets": "wrench",
        "cordless drills": "drill",
        "tape measures": "ruler",
        "door & window alarms": "siren",
        "adhesive hooks": "paperclip",
        "power strips & surge protectors": "plug",
        # Arts, Crafts & Sewing
        "adults' paint-by-number kits": "palette",
        "brushes": "paintbrush",
        "colored pencils": "pencil",
        "beads": "gem",
        "origami paper": "origami",
        "hot glue guns": "pipette",
        "sewing kits": "scissors",
        "quilting fabric": "swatch-book",
        "yarn": "spool",
        "storage boxes & organizers": "boxes",
        # Automotive
        "keychains": "key-round",
        "seat covers": "armchair",
        "floor mats": "layers",
        "car wash kits": "spray-can",
        "wiper blades": "cloud-rain",
        "car covers": "car",
        "headlight bulbs": "lightbulb",
        "tire inflators": "gauge",
        "riding gloves": "motorbike",
        "jump starters": "car-battery",
    }
)


def _key(text: str) -> str:
    return text.strip().lower()


def _shelf_icon(category: str, subcategories: list[str]) -> str | None:
    """The icon for the deepest mapped shelf, or None if no shelf is mapped."""
    for shelf in reversed([_key(s) for s in subcategories]):
        name = QUALIFIED_SHELF_ICONS.get(f"{category} > {shelf}") or SHELF_ICONS.get(shelf)
        if name is not None:
            return name
    return None


def icon_for(product: Product) -> IconChoice:
    """The most specific icon for a product's shelf (see the module docstring)."""
    shelf = _shelf_icon(_key(product.category), product.subcategories)
    if shelf is not None:
        return IconChoice(shelf, IconTier.LEAF)
    fallback = CATEGORY_ICONS.get(product.category.strip())
    if fallback is not None:
        return IconChoice(fallback, IconTier.CATEGORY)
    return IconChoice(GENERIC_ICON, IconTier.GENERIC)


def referenced_icon_names() -> frozenset[str]:
    """Every icon the mapping can produce: exactly what must be vendored."""
    return frozenset(
        {GENERIC_ICON}
        | set(CATEGORY_ICONS.values())
        | set(SHELF_ICONS.values())
        | set(QUALIFIED_SHELF_ICONS.values())
    )


@cache
def _vendored() -> MappingProxyType[str, str]:
    raw = resources.files("edgereco.catalog").joinpath(ICON_FILE).read_text("utf-8")
    icons: dict[str, str] = json.loads(raw)["icons"]
    return MappingProxyType(icons)


def vendored_icon_names() -> frozenset[str]:
    """Names of the icons shipped in ``lucide_icons.json``."""
    return frozenset(_vendored())


def icon_body(name: str) -> str:
    """The icon's inner SVG elements, drawn on Lucide's 24x24 stroke grid."""
    try:
        return _vendored()[name]
    except KeyError:
        raise KeyError(
            f"icon {name!r} is not vendored; run scripts/vendor_lucide_icons.py"
        ) from None
