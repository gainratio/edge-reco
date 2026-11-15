"""Export Assay-scored IR metrics to frontend/app/src/metrics/relevance-measurement.json."""

from __future__ import annotations

import json
from pathlib import Path

from edgereco.reco.relevance_baseline import (
    RELEVANCE_MEASUREMENT_JSON,
    build_relevance_measurement,
)


def main(out_path: Path = RELEVANCE_MEASUREMENT_JSON) -> None:
    record = build_relevance_measurement()
    out_path.write_text(f"{json.dumps(record, indent='\t')}\n", encoding="utf-8")


if __name__ == "__main__":
    main()
