"""The installed ``assay`` package must be assay-engine's, not avow's bundled copy.

avow (every PyPI release through 0.4.1) ships its own older ``assay/`` directory. Both
distributions write ``site-packages/assay/``, so a fresh ``uv sync`` can leave avow's
files on top, and ``edgereco.reco.formula`` then fails at import
(``cannot import name 'canonical_zero' from 'assay.composite'``). Every image that
runs EdgeReco must therefore reinstall assay-engine from the lock after the sync, the
way the Dagger gate does. These tests pin both halves: this interpreter has the right
files, and both server images carry the reinstall step.
"""

from __future__ import annotations

import base64
import hashlib
import importlib.metadata
import re
import tomllib
from pathlib import Path

import pytest

BACKEND = Path(__file__).parents[2]
_DOCKERFILES = (BACKEND / "deploy" / "Dockerfile", BACKEND / "demo_server" / "Dockerfile")
_REINSTALL = re.compile(r"^RUN uv sync [^\n]*--frozen[^\n]*--reinstall-package assay-engine\b")


def _record_digest(path: Path) -> str:
    digest = hashlib.sha256(path.read_bytes()).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def test_every_installed_assay_file_is_assay_engines() -> None:
    files = [
        entry
        for entry in importlib.metadata.files("assay-engine") or []
        if entry.parts[0] == "assay" and entry.suffix == ".py" and entry.hash is not None
    ]
    assert files, "assay-engine records no assay/*.py files"
    foreign = [
        str(entry)
        for entry in files
        if entry.hash is not None and _record_digest(Path(str(entry.locate()))) != entry.hash.value
    ]
    assert not foreign, f"assay/ files not from assay-engine (avow's copy won?): {foreign}"


def test_no_other_distribution_ships_a_top_level_assay_or_avow() -> None:
    # The file-hash check above passes once the image reinstalls assay-engine, so on its
    # own it hides a dependency that still ships a stray `assay/`. This asks the
    # installed metadata directly: exactly one owner per top-level package.
    owners = importlib.metadata.packages_distributions()
    assert owners.get("assay") == ["assay-engine"], (
        f"top-level assay/ owners: {owners.get('assay')}"
    )
    assert owners.get("avow") == ["avow"], f"top-level avow/ owners: {owners.get('avow')}"
    assert "writ" not in owners, f"a stray top-level writ/ is installed by {owners['writ']}"


def test_the_composition_entry_points_import() -> None:
    from assay import compose  # noqa: F401 - the import is the assertion
    from assay.composite import canonical_zero  # noqa: F401

    import edgereco.reco.formula  # noqa: F401


def _pinned_assay_engine() -> str:
    project = tomllib.loads((BACKEND / "pyproject.toml").read_text(encoding="utf-8"))
    pins = [dep for dep in project["project"]["dependencies"] if dep.startswith("assay-engine")]
    assert len(pins) == 1
    return pins[0]


@pytest.mark.parametrize("dockerfile", _DOCKERFILES, ids=lambda path: path.parent.name)
def test_image_reinstalls_assay_engine_after_its_last_sync(dockerfile: Path) -> None:
    assert "==" in _pinned_assay_engine(), "assay-engine must stay an exact pin"
    runs = [line for line in dockerfile.read_text().splitlines() if line.startswith("RUN uv ")]
    syncs = [index for index, line in enumerate(runs) if line.startswith("RUN uv sync")]
    reinstalls = [index for index, line in enumerate(runs) if _REINSTALL.match(line)]
    assert reinstalls, f"{dockerfile} never reinstalls assay-engine from the lock"
    assert reinstalls[-1] == syncs[-1], (
        f"{dockerfile}: the assay-engine reinstall must be the LAST uv sync, "
        "or a later sync can put avow's assay/ back"
    )
