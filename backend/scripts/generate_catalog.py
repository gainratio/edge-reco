"""Write the synthetic Nimbus demo catalog to ``examples/source/catalog.csv``.

The catalog is generated, not collected: invented brands and product text from the
committed vocabulary (``src/edgereco/catalog/synthetic_vocab.json``), assembled by
``edgereco.catalog.synthetic``. It is part of this repo and MIT licensed like the
rest of it. Same seed -> byte-identical file (``tests/unit/catalog/test_synthetic.py``).

Run from backend/::

    uv run python scripts/generate_catalog.py            # default seed
    uv run python scripts/generate_catalog.py --seed 7   # a different catalog

Then rebuild everything downstream (embeddings, signed bundle, fixtures)::

    uv run python scripts/rebuild_example_bundle.py --from-source
"""

from __future__ import annotations

import argparse
from pathlib import Path

from edgereco.catalog.synthetic import DEFAULT_SEED, generate_rows, render_csv

DEFAULT_OUTPUT = Path(__file__).resolve().parent.parent / "examples" / "source" / "catalog.csv"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    rows = generate_rows(args.seed)
    args.output.write_text(render_csv(rows), encoding="utf-8")
    print(f"wrote {len(rows)} synthetic products (seed {args.seed}) to {args.output}")


if __name__ == "__main__":
    main()
