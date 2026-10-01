"""Integration test: the ``edgereco retrain`` CLI command wiring.

Drives the command against a local filesystem origin with no collector (engagement
omitted), asserting it loads the verify key, republishes a bumped version, and
reports the outcome. Boosting behaviour is covered by ``test_republish.py``.
"""

from __future__ import annotations

from pathlib import Path

from edgeproc.bundles.signing import generate_keypair
from typer.testing import CliRunner

from edgereco.catalog.loader import dump_jsonl
from edgereco.catalog.models import Product
from edgereco.catalog.publish import publish_bundle
from edgereco.cli import app
from tests.signing import save_seed

runner = CliRunner()


def _seed_origin(tmp: Path, private_key_path: Path) -> Path:
    staging = tmp / "seed"
    (staging / "vector").mkdir(parents=True)
    dump_jsonl(staging / "products.jsonl", [Product(id="P1", title="A", category="Electronics")])
    (staging / "vector" / "embeddings.f32").write_bytes(b"\x00" * 16)
    origin = tmp / "origin"
    publish_bundle(
        staging_dir=staging,
        origin_dir=origin,
        private_key_path=private_key_path,
        catalog_id="cli-retrain-test",
        version="v1",
        embedding_model="sentence-transformers/all-MiniLM-L6-v2",
        embedding_dim=384,
        embedding_count=1,
        product_count=1,
    )
    return origin


def test_retrain_command_republishes_bumped_version(tmp_path: Path) -> None:
    private, public = generate_keypair()
    private_key = tmp_path / "private.key"
    public_key = tmp_path / "public.key"
    save_seed(private.private_bytes_raw(), private_key)
    public_key.write_bytes(public.public_bytes_raw())
    origin = _seed_origin(tmp_path, private_key)

    result = runner.invoke(
        app,
        [
            "retrain",
            str(origin),
            str(origin),
            str(private_key),
            str(public_key),
            "--cache-dir",
            str(tmp_path / "cache"),
        ],
    )

    assert result.exit_code == 0, result.output
    assert "v2" in result.output


def test_retrain_command_recomputes_cooccurrence_from_sessions(tmp_path: Path) -> None:
    """A ``--sessions`` JSONL drives co-occurrence into the republished bundle."""
    from edgeproc.bundles.signing import Ed25519Verifier

    from edgereco.api.deps import sync_and_materialize
    from edgereco.reco.cooccurrence import CooccurrenceMatrix

    private, public = generate_keypair()
    private_key = tmp_path / "private.key"
    public_key = tmp_path / "public.key"
    save_seed(private.private_bytes_raw(), private_key)
    public_key.write_bytes(public.public_bytes_raw())
    origin = _seed_origin_two(tmp_path, private_key)
    sessions = tmp_path / "sessions.jsonl"
    sessions.write_text(
        '{"session_id":"s1","events":[{"product_id":"P1","event_type":"cart"},'
        '{"product_id":"P2","event_type":"cart"}]}\n',
        encoding="utf-8",
    )

    result = runner.invoke(
        app,
        [
            "retrain",
            str(origin),
            str(origin),
            str(private_key),
            str(public_key),
            "--sessions",
            str(sessions),
            "--cache-dir",
            str(tmp_path / "cache"),
        ],
    )

    assert result.exit_code == 0, result.output
    materialized = sync_and_materialize(
        base_url=str(origin),
        cache_root=tmp_path / "verify",
        verifier=Ed25519Verifier(public),
    )
    cooc = CooccurrenceMatrix.model_validate_json((materialized / "cooccurrence.json").read_bytes())
    assert {n.id for n in cooc.neighbors["P1"]} == {"P2"}


def _seed_origin_two(tmp: Path, private_key_path: Path) -> Path:
    staging = tmp / "seed2"
    (staging / "vector").mkdir(parents=True)
    dump_jsonl(
        staging / "products.jsonl",
        [
            Product(id="P1", title="A", category="Electronics"),
            Product(id="P2", title="B", category="Electronics"),
        ],
    )
    (staging / "vector" / "embeddings.f32").write_bytes(b"\x00" * 16)
    origin = tmp / "origin2"
    publish_bundle(
        staging_dir=staging,
        origin_dir=origin,
        private_key_path=private_key_path,
        catalog_id="cli-retrain-cooc",
        version="v1",
        embedding_model="sentence-transformers/all-MiniLM-L6-v2",
        embedding_dim=384,
        embedding_count=2,
        product_count=2,
    )
    return origin
