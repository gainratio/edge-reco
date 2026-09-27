"""Generate the committed synthetic demo session log for seed co-occurrence.

LABELED DEMO DATA — NOT real purchases. The static hosted demo runs no retrain, so
``examples/source/demo_sessions.jsonl`` ships a plausible set of co-purchase baskets
over the committed 720-product catalog. ``cooccurrence.py`` runs *real* co-occurrence
math on these, so "Customers also bought" rails are populated on edge-reco.com; a real
retrain regenerates the matrix from genuine events.

Baskets are **shelf-coherent**: each session draws 2-4 products from one shelf
(category + first subcategory, e.g. Health & Household > Wellness & Relaxation),
and a few span two shelves of the same category. Reads the source csv, so run it after
``scripts/generate_catalog.py`` and before ``rebuild_example_bundle.py --from-source``.
Fully deterministic (fixed RNG seed) so the committed file is byte-stable.

Run from backend/::

    .venv/bin/python3 scripts/gen_demo_sessions.py
"""

from __future__ import annotations

import csv
import json
import random
from collections import defaultdict
from pathlib import Path

from edgereco.catalog.preprocessor import BREADCRUMB_SEP

BACKEND_ROOT = Path(__file__).resolve().parent.parent
SOURCE_CSV = BACKEND_ROOT / "examples" / "source" / "catalog.csv"
OUT = BACKEND_ROOT / "examples" / "source" / "demo_sessions.jsonl"
RNG_SEED = 1729
SESSION_COUNT = 120
MIXED_FRACTION = 0.15  # ~15% of baskets span two shelves of the same category
# Higher-intent events are rarer than clicks, mirroring a real funnel.
EVENT_TYPES = ["click", "click", "click", "view", "favorite", "cart"]


def _shelf(breadcrumbs: str) -> tuple[str, str]:
    """(category, first subcategory): the shelf a shopper browses."""
    parts = [p.strip() for p in breadcrumbs.split(BREADCRUMB_SEP)]
    return (parts[0], parts[1] if len(parts) > 1 else "")


def _ids_by_shelf() -> dict[tuple[str, str], list[str]]:
    """Group the source catalog's product ids by shelf (sorted, deterministic)."""
    with SOURCE_CSV.open(newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    grouped: dict[tuple[str, str], list[str]] = defaultdict(list)
    for row in rows:
        grouped[_shelf(row["breadcrumbs"])].append(row["asin"])
    return {shelf: sorted(ids) for shelf, ids in sorted(grouped.items()) if len(ids) >= 2}


def _basket(rng: random.Random, pool: list[str]) -> list[dict[str, str]]:
    """One basket: 2-4 distinct products from ``pool``, each with a weighted event."""
    size = rng.randint(2, min(4, len(pool)))
    chosen = rng.sample(pool, size)
    return [{"product_id": pid, "event_type": rng.choice(EVENT_TYPES)} for pid in chosen]


def _session_pool(rng: random.Random, by_shelf: dict[tuple[str, str], list[str]]) -> list[str]:
    """A coherent pool: one shelf usually; for a few baskets, two shelves of ONE category.

    Baskets never cross categories. Cross-category pairs drawn at random are what put
    a massage gun next to incontinence pads in "Customers also bought".
    """
    shelves = list(by_shelf)
    primary = rng.choice(shelves)
    siblings = [s for s in shelves if s[0] == primary[0] and s != primary]
    if siblings and rng.random() < MIXED_FRACTION:
        return by_shelf[primary] + by_shelf[rng.choice(siblings)]
    return by_shelf[primary]


def main() -> None:
    by_shelf = _ids_by_shelf()
    # Deterministic synthetic demo data — not security-sensitive, so stdlib random is fine.
    rng = random.Random(RNG_SEED)  # noqa: S311
    lines: list[str] = []
    for i in range(SESSION_COUNT):
        events = _basket(rng, _session_pool(rng, by_shelf))
        lines.append(json.dumps({"session_id": f"demo-s{i:04d}", "events": events}))
    OUT.write_text("\n".join(lines) + "\n", encoding="utf-8")
    rel = OUT.relative_to(BACKEND_ROOT)
    print(f"wrote {rel} ({SESSION_COUNT} sessions, {OUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
