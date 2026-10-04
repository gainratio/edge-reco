from __future__ import annotations

from fastapi.testclient import TestClient

from demo_server.main import app
from edgereco.catalog.models import SessionProfile
from edgereco.reco.signals import apply_interaction

client = TestClient(app)


def test_healthz_ok() -> None:
    assert client.get("/healthz").status_code == 200


def test_cors_header_present_for_browser_origin() -> None:
    r = client.get("/healthz", headers={"Origin": "http://localhost:5174"})
    assert r.headers.get("access-control-allow-origin") == "http://localhost:5174"


def test_search_then_session_then_recommend_personalizes() -> None:
    sid = "demo-test-1"
    hits = client.get("/search", params={"q": "headphones", "limit": 5}).json()["results"]
    assert hits
    container = app.state.container
    product = container.by_id[hits[0]["product"]["id"]]

    def update(profile: SessionProfile) -> SessionProfile:
        return apply_interaction(profile, product, "click")

    container.sessions.update(sid, update)
    rec = client.get("/recommend", params={"limit": 10}, headers={"X-Session-Id": sid}).json()
    assert rec["session_clicks"] >= 1
    assert rec["results"][0]["score_components"] is not None


def test_no_event_endpoint_is_mounted() -> None:
    """Interaction data never leaves the client: the server has no event sink."""
    event = {"event_type": "click", "product_id": "p1", "timestamp": "2026-06-04T00:00:00Z"}
    assert client.post("/events", json={"events": [event]}).status_code in {404, 405}
    assert client.get("/events/export").status_code == 404


def test_browse_products_paginates_and_lists_categories() -> None:
    body = client.get("/products", params={"limit": 12}).json()
    assert len(body["products"]) == 12
    assert body["total"] >= 12
    assert body["categories"]  # non-empty facet list


def test_browse_filters_by_category() -> None:
    category = client.get("/products", params={"limit": 1}).json()["categories"][0]
    body = client.get("/products", params={"category": category, "limit": 50}).json()
    assert body["products"]
    assert all(p["category"] == category for p in body["products"])
