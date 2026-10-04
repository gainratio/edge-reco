"""/recommend surfaces affinity matches that fall outside the popularity pool.

Regression for the demo's "clicking does nothing" bug: a clicked product builds
session affinity, but under a popularity-only candidate pool, similar low-popularity
items can never enter the rail. The affinity-aware pool fixes this.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from edgereco.api.app import create_app
from edgereco.api.deps import ServiceContainer
from edgereco.catalog.models import Product, SessionProfile
from edgereco.reco.signals import apply_interaction

_SESSION_ID = "affinity-pool-session"
_SESSION = {"X-Session-Id": _SESSION_ID}


def _catalog() -> list[Product]:
    # 25 low-popularity Electronics fully occupy the popularity pool (n = limit*5 = 25).
    rail = [
        Product(id=f"e{i}", title=f"Electronics {i}", category="Electronics", popularity_score=0.08)
        for i in range(25)
    ]
    # Two even-less-popular Niche items share a tag + brand → outside the popularity pool.
    niche = [
        Product(
            id=pid,
            title=f"Niche {pid}",
            category="Niche",
            tags=["nichetag"],
            brand="NicheBrand",
            popularity_score=0.05,
        )
        for pid in ("clicked", "sibling")
    ]
    return rail + niche


def _client() -> tuple[TestClient, ServiceContainer]:
    container = ServiceContainer.from_catalog(_catalog())
    return TestClient(create_app(container)), container


def _click(container: ServiceContainer, product_id: str) -> None:
    """Fold a click into the server session the way an in-process host would."""
    product = container.by_id[product_id]

    def update(profile: SessionProfile) -> SessionProfile:
        return apply_interaction(profile, product, "click")

    container.sessions.update(_SESSION_ID, update)


def _rail_ids(client: TestClient) -> list[str]:
    results = client.get("/recommend?limit=5", headers=_SESSION).json()["results"]
    return [r["product"]["id"] for r in results]


def test_clicked_category_sibling_surfaces_in_rail() -> None:
    client, container = _client()
    assert "sibling" not in _rail_ids(client)  # cold start: popularity-only, niche item absent

    _click(container, "clicked")

    # affinity pool makes the unpopular sibling eligible and it ranks in
    assert "sibling" in _rail_ids(client)


def test_clicked_item_itself_is_not_re_recommended() -> None:
    client, container = _client()
    _click(container, "clicked")
    # repetition penalty keeps the exact clicked item out
    assert "clicked" not in _rail_ids(client)
