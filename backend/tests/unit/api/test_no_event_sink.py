"""The API has no event sink: shopper interaction data never leaves the browser.

Product contract: no server endpoint receives, stores, or exports interaction
events. A route that accepts them (the retired ``/events`` collector) must not
come back.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from edgereco.api.app import create_app
from edgereco.api.deps import ServiceContainer
from edgereco.catalog.models import Product


def _client() -> TestClient:
    catalog = [Product(id="p1", title="Thing", category="Electronics")]
    return TestClient(create_app(ServiceContainer.from_catalog(catalog)))


def test_post_events_is_not_routed() -> None:
    event = {"event_type": "click", "product_id": "p1", "timestamp": "2026-06-01T00:00:00Z"}
    assert _client().post("/events", json={"events": [event]}).status_code == 404


def test_events_export_is_not_routed() -> None:
    assert _client().get("/events/export").status_code == 404


def test_no_route_path_mentions_events() -> None:
    paths = [getattr(route, "path", "") for route in create_app().routes]
    assert not [p for p in paths if "event" in p.lower()]
