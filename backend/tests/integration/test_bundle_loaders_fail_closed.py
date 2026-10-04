"""The public bundle loaders fail closed on a current-schema bundle missing a file.

The serving consumer (``ServiceContainer.from_synced``) threads
``meta_schema=meta.schema_version`` into the public ``load_cooccurrence`` /
``load_ranking_config`` loaders so a CURRENT-schema bundle that is missing the file it
should carry raises rather than silently degrading to an empty matrix / the legacy
default weights.
"""

from __future__ import annotations

from pathlib import Path

import pytest

import edgereco.api.deps as deps
from edgereco.catalog.loader import dump_jsonl
from edgereco.catalog.models import Product
from edgereco.catalog.publish import CURRENT_META_SCHEMA, CatalogMeta
from edgereco.reco.cooccurrence import CooccurrenceMatrix
from edgereco.reco.ranking_config import DEFAULT_RANKING_CONFIG

_PRODUCTS = [
    Product(id="P1", title="A", category="Electronics", popularity_score=0.2),
    Product(id="P2", title="B", category="Electronics", popularity_score=0.5),
]


def _materialize_current_schema_dir(tmp_path: Path) -> Path:
    """A materialised bundle dir declaring the CURRENT schema, both files present."""
    local = tmp_path / "local"
    local.mkdir()
    dump_jsonl(local / "products.jsonl", _PRODUCTS)
    meta = CatalogMeta(
        catalog_id="fail-closed-test",
        version="v1",
        embedding_model="m",
        embedding_dim=8,
        embedding_count=len(_PRODUCTS),
        product_count=len(_PRODUCTS),
        schema_version=CURRENT_META_SCHEMA,
    )
    (local / "catalog_meta.json").write_text(meta.model_dump_json(), encoding="utf-8")
    (local / "cooccurrence.json").write_text(
        CooccurrenceMatrix().model_dump_json(), encoding="utf-8"
    )
    (local / "ranking_config.json").write_text(
        DEFAULT_RANKING_CONFIG.model_dump_json(), encoding="utf-8"
    )
    return local


def test_public_loaders_are_exposed(tmp_path: Path) -> None:
    # The fail-closed loaders are public module-level contract (from_synced consumes them).
    local = _materialize_current_schema_dir(tmp_path)
    assert deps.load_ranking_config(local, meta_schema=CURRENT_META_SCHEMA) is not None
    assert deps.load_cooccurrence(local, meta_schema=CURRENT_META_SCHEMA) is not None


def test_public_loaders_fail_closed_on_missing_current_schema_file(tmp_path: Path) -> None:
    # A current-schema bundle missing a signed file must raise, never silently degrade.
    empty = tmp_path / "empty"
    empty.mkdir()
    with pytest.raises(FileNotFoundError):
        deps.load_ranking_config(empty, meta_schema=CURRENT_META_SCHEMA)
    with pytest.raises(FileNotFoundError):
        deps.load_cooccurrence(empty, meta_schema=CURRENT_META_SCHEMA)
