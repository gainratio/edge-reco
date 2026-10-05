"""The optional API-server image must never ingest the parent OSS workspace."""

from pathlib import Path

BACKEND = Path(__file__).parents[2]
REPOSITORY = BACKEND.parent


def test_compose_runs_no_event_collector() -> None:
    """The demo stack has no server that receives shopper interaction events."""
    compose = (REPOSITORY / "frontend" / "docker-compose.yml").read_text()

    assert "  collector:" not in compose
    assert "VITE_EVENTS_URL" not in compose
    assert "demo_server/Dockerfile" not in compose


def test_api_server_dockerfile_never_copies_sibling_repositories() -> None:
    dockerfile = (BACKEND / "demo_server" / "Dockerfile").read_text()

    assert "COPY edge-reco/" not in dockerfile
    assert "COPY edge-proc/" not in dockerfile
    assert "COPY shared-libs-python/" not in dockerfile
    assert "COPY pyproject.toml uv.lock ./" in dockerfile


def test_backend_dockerignore_excludes_host_secrets_and_build_state() -> None:
    patterns = (BACKEND / ".dockerignore").read_text().splitlines()

    for pattern in [".git", ".venv", "**/.env*", "**/private.key", "**/*.pem"]:
        assert pattern in patterns
