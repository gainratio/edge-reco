"""Load product catalogs from JSONL."""

from __future__ import annotations

from pathlib import Path

from .models import Product


def load_jsonl(path: Path) -> list[Product]:
    """Load products from a JSONL file (one JSON object per line)."""
    products: list[Product] = []
    text = path.read_text(encoding="utf-8").strip()
    if not text:
        return products
    for line in text.splitlines():
        line = line.strip()
        if line:
            products.append(Product.model_validate_json(line))
    return products
