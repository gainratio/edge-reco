"""Supply-chain contract for EdgeReco's published Assay dependency."""

from __future__ import annotations

import tomllib
from pathlib import Path

BACKEND_ROOT = Path(__file__).parents[2]
PYPROJECT = tomllib.loads((BACKEND_ROOT / "pyproject.toml").read_text())
LOCK = tomllib.loads((BACKEND_ROOT / "uv.lock").read_text())
REQUIREMENT = "assay-engine[metrics]==0.5.0.dev6"
WHEEL_SHA256 = "2ca09584a9c2373112561eaf6036e23b37821dbfc1016af58893b9d8a2e943f3"
SDIST_SHA256 = "c7694932e5cee91b1403bd34465c2086e7c2e3ed4d87166500b4546bdd7236fc"


def assay_package() -> dict[str, object]:
    """Return the single locked Assay package."""
    matches = [package for package in LOCK["package"] if package["name"] == "assay-engine"]
    assert len(matches) == 1
    return matches[0]


def test_assay_is_an_exact_registry_dependency() -> None:
    """The application must not fall back to a mutable sibling checkout."""
    dependencies = PYPROJECT["project"]["dependencies"]
    assay_requirements = [item for item in dependencies if item.startswith("assay-engine")]
    assert assay_requirements == [REQUIREMENT]
    assert "assay-engine" not in PYPROJECT["tool"]["uv"].get("sources", {})


def test_assay_lock_matches_verified_pypi_artifacts() -> None:
    """The lock must retain the independently verified public artifact hashes."""
    package = assay_package()
    assert package["version"] == "0.5.0.dev6"
    assert package["source"] == {"registry": "https://pypi.org/simple"}
    assert package["sdist"]["hash"] == f"sha256:{SDIST_SHA256}"
    assert {wheel["hash"] for wheel in package["wheels"]} == {f"sha256:{WHEEL_SHA256}"}
