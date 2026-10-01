"""Integration test: the ``edgereco audit`` CLI command.

Drives the read-only audit against a local signed origin: it syncs the current
bundle, replays the session log to preview popularity + co-occurrence, and prints a
human-readable diff. Never publishes; never touches the inference path.
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
    dump_jsonl(
        staging / "products.jsonl",
        [
            Product(id="P1", title="A", category="Electronics", popularity_score=0.2),
            Product(id="P2", title="B", category="Electronics", popularity_score=0.5),
        ],
    )
    (staging / "vector" / "embeddings.f32").write_bytes(b"\x00" * 16)
    origin = tmp / "origin"
    publish_bundle(
        staging_dir=staging,
        origin_dir=origin,
        private_key_path=private_key_path,
        catalog_id="cli-audit-test",
        version="v1",
        embedding_model="sentence-transformers/all-MiniLM-L6-v2",
        embedding_dim=384,
        embedding_count=2,
        product_count=2,
    )
    return origin


def test_audit_reports_event_counts_and_movers(tmp_path: Path) -> None:
    private, public = generate_keypair()
    private_key = tmp_path / "private.key"
    public_key = tmp_path / "public.key"
    save_seed(private.private_bytes_raw(), private_key)
    public_key.write_bytes(public.public_bytes_raw())
    origin = _seed_origin(tmp_path, private_key)
    sessions = tmp_path / "sessions.jsonl"
    sessions.write_text(
        '{"session_id":"s1","events":[{"product_id":"P1","event_type":"cart"},'
        '{"product_id":"P2","event_type":"cart"}]}\n'
        '{"session_id":"s2","events":[{"product_id":"P1","event_type":"click"}]}\n',
        encoding="utf-8",
    )

    result = runner.invoke(
        app,
        [
            "audit",
            str(origin),
            str(public_key),
            "--sessions",
            str(sessions),
            "--cache-dir",
            str(tmp_path / "cache"),
        ],
    )

    assert result.exit_code == 0, result.output
    # The report names the events that drove the change and the popularity mover.
    assert "3" in result.output  # total events
    assert "cart=2" in result.output
    assert "click=1" in result.output
    assert "P1" in result.output  # popularity mover
    assert "Co-occurrence edges changed" in result.output


def test_audit_is_read_only_and_does_not_republish(tmp_path: Path) -> None:
    """Audit must not bump ``latest`` or write a new manifest into the origin."""
    private, public = generate_keypair()
    private_key = tmp_path / "private.key"
    public_key = tmp_path / "public.key"
    save_seed(private.private_bytes_raw(), private_key)
    public_key.write_bytes(public.public_bytes_raw())
    origin = _seed_origin(tmp_path, private_key)
    before = (origin / "latest").read_bytes()

    result = runner.invoke(
        app,
        ["audit", str(origin), str(public_key), "--cache-dir", str(tmp_path / "cache")],
    )

    assert result.exit_code == 0, result.output
    assert (origin / "latest").read_bytes() == before  # origin untouched
