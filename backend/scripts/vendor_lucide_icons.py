"""Vendor the Lucide icons the product-card mapping uses into ``lucide_icons.json``.

Downloads the pinned ``lucide-static`` release tarball from the npm registry, checks
it against the registry's published sha512 integrity string (fails closed on any
mismatch), and copies only the icons ``edgereco.catalog.product_icons`` references.
Each icon is stored as its inner SVG elements; the card renderer supplies the outer
``<g>`` with the stroke styling. Lucide is ISC licensed (see NOTICE).

Run from backend/ after changing the mapping or the pinned version::

    uv run python scripts/vendor_lucide_icons.py
    uv run python scripts/rebuild_example_bundle.py   # re-render + re-sign the cards
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import re
import sys
import tarfile
from pathlib import Path

import httpx

from edgereco.catalog.product_icons import (
    ICON_FILE,
    ICON_LICENSE,
    ICON_PACKAGE,
    ICON_VERSION,
    referenced_icon_names,
)

#: npm's ``dist.integrity`` for lucide-static@1.48.0. Changing the version means
#: changing this too, from ``npm view lucide-static@<version> dist.integrity``.
INTEGRITY = "sha512-ZUGgZ4rzlLfVbhN2Zi37TMrTaSpXAbWx6Y/xZxKSDLPiqxtTK7Mw2M+oBJa0gjV8p3+CWBHh48u+IC9+jKlUjA=="  # noqa: E501
TARBALL = f"https://registry.npmjs.org/{ICON_PACKAGE}/-/{ICON_PACKAGE}-{ICON_VERSION}.tgz"
OUTPUT = Path(__file__).resolve().parent.parent / "src" / "edgereco" / "catalog" / ICON_FILE
_INNER = re.compile(r"<svg\b[^>]*>(?P<body>.*)</svg>", re.DOTALL)


def _download() -> bytes:
    body = httpx.get(TARBALL, timeout=60.0, follow_redirects=True).raise_for_status().content
    digest = "sha512-" + base64.b64encode(hashlib.sha512(body).digest()).decode("ascii")
    if digest != INTEGRITY:
        raise SystemExit(f"integrity mismatch for {TARBALL}: got {digest}")
    return body


def _inner(svg: str) -> str:
    match = _INNER.search(svg)
    if match is None:
        raise SystemExit("unexpected icon file shape")
    body = re.sub(r"<!--.*?-->", "", match.group("body"), flags=re.DOTALL)
    return re.sub(r"\s*\n\s*", "", re.sub(r"\s+/>", "/>", body)).strip()


def _extract(tarball: bytes, names: frozenset[str]) -> dict[str, str]:
    icons: dict[str, str] = {}
    with tarfile.open(fileobj=io.BytesIO(tarball), mode="r:gz") as archive:
        for name in sorted(names):
            member = archive.extractfile(f"package/icons/{name}.svg")
            if member is None:
                raise SystemExit(f"{name} is not in {ICON_PACKAGE}@{ICON_VERSION}")
            icons[name] = _inner(member.read().decode("utf-8"))
    return icons


def main() -> None:
    icons = _extract(_download(), referenced_icon_names())
    payload = {
        "package": ICON_PACKAGE,
        "version": ICON_VERSION,
        "license": ICON_LICENSE,
        "integrity": INTEGRITY,
        "source": TARBALL,
        "icons": icons,
    }
    OUTPUT.write_text(json.dumps(payload, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    sys.stdout.write(f"vendored {len(icons)} icons from {ICON_PACKAGE}@{ICON_VERSION}\n")


if __name__ == "__main__":
    main()
