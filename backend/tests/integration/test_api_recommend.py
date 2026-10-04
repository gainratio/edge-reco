"""Integration tests: /recommend endpoint."""

from __future__ import annotations

from fastapi.testclient import TestClient


def test_recommend_returns_requested_limit(client: TestClient) -> None:
    response = client.get("/recommend?limit=5")
    assert response.status_code == 200
    assert len(response.json()["results"]) == 5


def test_recommend_response_carries_no_session_state(client: TestClient) -> None:
    """The API is stateless: no server-side session, so no per-session counter."""
    body = client.get("/recommend?limit=5").json()
    assert set(body) == {"results"}


def test_recommend_ignores_a_session_header(client: TestClient) -> None:
    """A client-sent ``X-Session-Id`` changes nothing: the server keeps no session."""
    plain = client.get("/recommend?limit=10").json()
    tagged = client.get("/recommend?limit=10", headers={"X-Session-Id": "s-1"}).json()
    assert plain == tagged


def test_recommend_openapi_declares_no_session_header(client: TestClient) -> None:
    """The published contract has no session header parameter on any route."""
    schema = client.get("/openapi.json").json()
    params = [
        param["name"].lower()
        for path in schema["paths"].values()
        for op in path.values()
        for param in op.get("parameters", [])
    ]
    assert "x-session-id" not in params
    assert (
        "session_clicks" not in schema["components"]["schemas"]["RecommendResponse"]["properties"]
    )


def test_recommend_defaults_to_for_you(client: TestClient) -> None:
    """No ``strategy`` param → today's behavior, identical to ``strategy=for_you``."""
    default = client.get("/recommend?limit=5").json()["results"]
    explicit = client.get("/recommend?limit=5&strategy=for_you").json()["results"]
    assert [r["product"]["id"] for r in default] == [r["product"]["id"] for r in explicit]


def test_recommend_trending_strategy(client: TestClient) -> None:
    response = client.get("/recommend?limit=5&strategy=trending")
    assert response.status_code == 200
    assert len(response.json()["results"]) == 5


def test_recommend_new_arrivals_strategy(client: TestClient) -> None:
    response = client.get("/recommend?limit=5&strategy=new_arrivals")
    assert response.status_code == 200
    assert len(response.json()["results"]) == 5


def test_recommend_similar_items_needs_seed(client: TestClient) -> None:
    """A vector strategy without a seed is a client error, not a 500."""
    response = client.get("/recommend?limit=5&strategy=similar_items")
    assert response.status_code == 422


def test_recommend_similar_items_excludes_seed(client: TestClient) -> None:
    ids = [r["product"]["id"] for r in client.get("/recommend?limit=10").json()["results"]]
    seed = ids[0]
    response = client.get(f"/recommend?limit=5&strategy=similar_items&seed={seed}")
    assert response.status_code == 200
    body = response.json()["results"]
    result_ids = [r["product"]["id"] for r in body]
    assert seed not in result_ids
    assert all(r["score_components"]["similarity"] != 0.0 for r in body)


def test_recommend_also_bought_needs_seed(client: TestClient) -> None:
    """A co-occurrence strategy without a seed is a client error, not a 500."""
    response = client.get("/recommend?limit=5&strategy=also_bought")
    assert response.status_code == 422


def test_recommend_also_bought_threads_cooccurrence_matrix() -> None:
    """The route feeds the container's co-occurrence matrix into the dispatch."""
    from edgereco.api.app import create_app
    from edgereco.api.deps import ServiceContainer
    from edgereco.catalog.models import Product
    from edgereco.reco.cooccurrence import CooccurrenceMatrix, Neighbor

    products = [Product(id=f"X{i}", title=f"T{i}", category="Electronics") for i in range(4)]
    cooc = CooccurrenceMatrix(
        neighbors={"X0": [Neighbor(id="X1", score=0.9), Neighbor(id="X2", score=0.5)]}
    )
    container = ServiceContainer.from_catalog(products)
    container.cooccurrence = cooc
    local_client = TestClient(create_app(container))

    body = local_client.get("/recommend?strategy=also_bought&seed=X0&limit=5").json()["results"]
    assert [r["product"]["id"] for r in body] == ["X1", "X2"]
    assert all(r["score_components"]["cooccurrence"] != 0.0 for r in body)


def test_recommend_unknown_strategy_is_client_error(client: TestClient) -> None:
    response = client.get("/recommend?limit=5&strategy=bogus")
    assert response.status_code == 422
