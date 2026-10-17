"""Deterministic, license-clean product-card images baked into the signed bundle.

The Nimbus demo ships product images INSIDE the signed, offline catalog bundle.
Remote CDN images (the raw Amazon URLs) would leak every visitor's IP on page
load and break the "one signed file, then zero backend calls" promise, so each
product is rendered here as a small SVG card: the Lucide icon for its shelf
(``product_icons``) on a pastel backdrop coloured from its id, with the brand in
small type. Same catalog in -> byte-identical SVGs out (no timestamps, no
randomness), so the bundle hash stays stable.

Seam: ``generate_product_image`` is the single, swappable renderer, and
``localize_catalog`` is the single place a catalog's images become local. A
future license-clean *raster* localizer can replace the renderer behind this
exact signature without touching the publish or serve paths.
"""

from __future__ import annotations

import colorsys
import hashlib
import json
import re
from collections.abc import Mapping
from enum import StrEnum
from xml.sax.saxutils import escape, quoteattr

from .models import Product
from .product_icons import icon_body, icon_for


class ImageMode(StrEnum):
    """How a published bundle expects product images to be served.

    ``LOCAL`` (the default) localizes every photo at build time and serves it from our
    own origin, so the deployed CSP can stay ``img-src 'self' data:`` and a page load
    makes ZERO third-party requests. ``REMOTE`` keeps the catalog's own CDN urls and
    requires the deployment to list those hosts in ``img-src`` — cheaper to build, but
    every visitor's IP reaches that CDN on page load.

    LOCAL is the default deliberately: the storefront's headline claim is that nothing
    leaves the browser, so the mode that preserves it is the one you get for free.
    """

    LOCAL = "local"
    REMOTE = "remote"


_SAFE_ID = re.compile(r"^[A-Za-z0-9._-]+$")
_FONT = "system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"
#: Lucide draws on a 24x24 grid; 6.5x makes a 156 px icon inside the studio tile.
_ICON_SCALE = 6.5
#: Centre of the studio object. The storefront grid crops the square card to a 4:3
#: frame and horizontal rails crop to ~1.8:1 (``object-fit: cover``), so the podium,
#: tile, icon, and brand badge all sit inside the y=145..455 safe band.
_ICON_CY = 264


def _require_safe_id(product_id: str) -> str:
    """Reject anything that could escape the ``images/`` dir or a URL path."""
    if not _SAFE_ID.match(product_id):
        raise ValueError(f"unsafe product id for an image path: {product_id!r}")
    return product_id


def image_relpath(product_id: str, extension: str = "svg") -> str:
    """Bundle-relative path for a product's card (staged + covered by the signature)."""
    return f"images/{_require_safe_id(product_id)}.{_require_safe_id(extension)}"


def local_image_url(product_id: str, extension: str = "svg") -> str:
    """Root-relative same-origin URL the SPA renders (passes ``isLocalImage``)."""
    return f"/images/{_require_safe_id(product_id)}.{_require_safe_id(extension)}"


def _localize_line(line: str, staged: Mapping[str, str]) -> tuple[str, str, bytes | None]:
    """One catalog line -> (rewritten line, card relpath, card bytes or None).

    ``staged`` maps a product id to the extension of a REAL photo the build already
    localized. For those, the url points at the photo and no bytes are emitted — the
    file is already on disk and must not be overwritten by a placeholder.
    """
    product = Product.model_validate_json(line)
    record = json.loads(line)
    extension = staged.get(product.id)
    record["image_url"] = local_image_url(product.id, extension or "svg")
    rewritten = json.dumps(record, ensure_ascii=False, separators=(",", ":"))
    if extension is not None:
        return rewritten, image_relpath(product.id, extension), None
    svg = generate_product_image(product).encode("utf-8")
    return rewritten, image_relpath(product.id), svg


def localize_catalog(
    raw: str,
    staged: Mapping[str, str] | None = None,
    mode: ImageMode = ImageMode.LOCAL,
) -> tuple[str, dict[str, bytes]]:
    """Point every product's ``image_url`` at a local card and render the missing ones.

    ``staged`` maps a product id to the extension of a REAL photo the build already
    downloaded (``image_download``). Those keep their url and their bytes; every other
    product falls back to a generated placeholder card. So the real photo is the
    default and the card is the fallback, per product, with no build-wide failure mode.

    Returns the rewritten ``products.jsonl`` text plus ``{bundle relpath: bytes}`` for
    the cards this call rendered — staged photos are already on disk and are
    deliberately absent from that map so nothing overwrites them.

    Deterministic AND idempotent: an already-localized catalog re-renders to the
    same bytes (the url is derived from the product id, never from its old value),
    so republishing never moves the bundle hash.

    Splits on ``\\n`` ONLY — never ``str.splitlines()``. ``ensure_ascii=False`` emits
    U+2028, U+2029 and U+0085 raw, and ``splitlines`` treats all three as line
    terminators: one of them in any product field and the producer would write a
    catalog it cannot re-read, breaking the idempotency claimed above. ``\\n`` is
    also exactly what the browser consumer splits on, so the two agree by
    construction rather than by luck.
    """
    if mode is ImageMode.REMOTE:
        # The catalog's own urls ARE the contract in this mode; rewriting them here is
        # what would silently strand the deployment on placeholders.
        return raw, {}
    return _localize_records(raw, staged or {})


def _localize_records(raw: str, staged: Mapping[str, str]) -> tuple[str, dict[str, bytes]]:
    """Rewrite every non-blank record and collect the cards this call had to render."""
    cards: dict[str, bytes] = {}
    lines: list[str] = []
    for line in filter(str.strip, raw.split("\n")):
        rewritten, relpath, svg = _localize_line(line, staged)
        lines.append(rewritten)
        if svg is not None:
            cards[relpath] = svg
    return "".join(f"{line}\n" for line in lines), cards


def _hex(hue: float, lightness: float, saturation: float) -> str:
    red, green, blue = colorsys.hls_to_rgb(hue % 1.0, lightness, saturation)
    return f"#{round(red * 255):02x}{round(green * 255):02x}{round(blue * 255):02x}"


def _hue(product_id: str) -> float:
    """A stable hue per product, so neighbours on one shelf still look different."""
    digest = hashlib.sha256(product_id.encode("utf-8")).digest()
    return int.from_bytes(digest[:2], "big") / 65536


def _colors(product_id: str) -> tuple[str, str, str, str]:
    """(light stop, deep stop, accent glow, deep ink) derived from the product id."""
    hue = _hue(product_id)
    return (
        _hex(hue, 0.95, 0.72),
        _hex(hue + 0.06, 0.83, 0.58),
        _hex(hue + 0.02, 0.62, 0.68),
        _hex(hue, 0.24, 0.62),
    )


def generate_product_image(product: Product) -> str:
    """Render one product as a deterministic, self-contained studio-lit SVG card.

    A studio backdrop and elevated podium tile (coloured from the product id),
    the Lucide icon for the product's shelf (``product_icons``), and the brand
    plinth underneath.
    """
    light, deep, accent, ink = _colors(product.id)
    body = "".join(
        (
            _backdrop(light, deep, accent, ink),
            _icon(icon_for(product).name, ink),
            _brand(product.brand, ink),
        )
    )
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600" '
        f'width="600" height="600" role="img" aria-label={quoteattr(product.title)}>'
        f"{body}</svg>"
    )


def _backdrop(light: str, deep: str, accent: str, ink: str) -> str:
    return (
        '<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">'
        f'<stop offset="0" stop-color="{light}"/><stop offset="1" stop-color="{deep}"/>'
        '</linearGradient></defs><rect width="600" height="600" fill="url(#bg)"/>'
        f'<ellipse cx="300" cy="390" rx="116" ry="15" fill="{ink}" fill-opacity=".16"/>'
        '<rect x="184" y="146" width="232" height="228" rx="42" fill="#fff" '
        f'fill-opacity=".92" stroke="{deep}" stroke-width="2"/>'
        f'<circle cx="300" cy="{_ICON_CY}" r="68" fill="{accent}" fill-opacity=".18"/>'
    )


def _icon(name: str, ink: str) -> str:
    return (
        f'<g data-icon="{escape(name)}" '
        f'transform="translate(300 {_ICON_CY}) scale({_ICON_SCALE}) translate(-12 -12)" '
        f'fill="none" stroke="{ink}" stroke-width="1.75" '
        f'stroke-linecap="round" stroke-linejoin="round">{icon_body(name)}</g>'
    )


def _brand(brand: str, ink: str) -> str:
    if not brand.strip():
        return ""
    return (
        '<rect x="160" y="408" width="280" height="34" rx="17" fill="#fff" fill-opacity=".72"/>'
        f'<text x="300" y="431" font-family="{_FONT}" font-size="18" font-weight="600" '
        f'letter-spacing="3.5" fill="{ink}" fill-opacity=".86" '
        f'text-anchor="middle">{escape(brand.strip().upper())}</text>'
    )
