"""Unit tests for the deterministic co-occurrence computation (``reco.cooccurrence``).

``build_cooccurrence`` folds a set of sessions (each a list of ``(product_id, event_type)``
pairs) into a sparse top-N neighbour map per product, weighting pairs by
``ENGAGEMENT_WEIGHTS`` and normalising with cosine over per-product engagement vectors.
The output is deterministic, symmetric, self-excluded, and top-N capped.
"""

from __future__ import annotations

import math

from edgereco.reco.cooccurrence import (
    CooccurrenceMatrix,
    Neighbor,
    SessionLog,
    _top_neighbors,
    build_cooccurrence,
    sessions_from_logs,
)


def test_zero_norm_partner_is_skipped_not_nan() -> None:
    """A zero-norm engagement vector must not divide-by-zero into NaN/inf — the
    cosine for that partner is skipped (score 0 / dropped), never poisoned."""
    norms = {"A": 2.0, "Z": 0.0}  # Z has an all-zero engagement vector
    neighbors = _top_neighbors("A", {"Z": 1.0}, norms, top_n=10)
    for n in neighbors:
        assert math.isfinite(n.score)
    # Z is undefined (0/0) cosine; it must be dropped, not surfaced as NaN.
    assert "Z" not in {n.id for n in neighbors}


def test_zero_norm_self_yields_no_neighbors() -> None:
    """If the seed product's own norm is zero, it has no defined cosine to anyone."""
    norms = {"A": 0.0, "B": 1.0}
    assert _top_neighbors("A", {"B": 0.0}, norms, top_n=10) == []


# One basket type, two products co-engaged via clicks (weight 1.0 each).
_SESSIONS = [
    [("A", "click"), ("B", "click")],
    [("A", "click"), ("B", "click")],
    [("A", "click"), ("C", "click")],
]


def test_empty_sessions_yield_empty_matrix() -> None:
    matrix = build_cooccurrence([])
    assert isinstance(matrix, CooccurrenceMatrix)
    assert matrix.neighbors == {}


def test_pair_is_symmetric() -> None:
    matrix = build_cooccurrence(_SESSIONS)
    a_to_b = {n.id: n.score for n in matrix.neighbors["A"]}
    b_to_a = {n.id: n.score for n in matrix.neighbors["B"]}
    assert "B" in a_to_b
    assert "A" in b_to_a
    assert a_to_b["B"] == b_to_a["A"]


def test_self_is_excluded() -> None:
    matrix = build_cooccurrence(_SESSIONS)
    for pid, neighbors in matrix.neighbors.items():
        assert all(n.id != pid for n in neighbors)


def test_cosine_score_is_deterministic() -> None:
    # A and B co-occur in 2 sessions (click·click = 1.0 each), each = 2.0 dot.
    # A also appears with C once. Per-product engagement vectors over sessions:
    #   A = [1, 1, 1], B = [1, 1, 0], C = [0, 0, 1]
    # cosine(A,B) = (1+1+0) / (sqrt(3)·sqrt(2)) = 2 / sqrt(6)
    matrix = build_cooccurrence(_SESSIONS)
    a_to_b = {n.id: n.score for n in matrix.neighbors["A"]}
    assert a_to_b["B"] == pytest_approx(2.0 / math.sqrt(6.0))


def test_higher_intent_events_weigh_more() -> None:
    # cart (4.0) co-engagement dominates a click (1.0) co-engagement.
    sessions = [
        [("X", "cart"), ("Y", "cart")],
        [("X", "click"), ("Z", "click")],
    ]
    matrix = build_cooccurrence(sessions)
    x_neighbors = {n.id: n.score for n in matrix.neighbors["X"]}
    assert x_neighbors["Y"] > x_neighbors["Z"]


def test_top_n_caps_neighbour_count() -> None:
    # One hub product H co-engaged with 15 distinct others in its own session.
    hub_session = [("H", "click")] + [(f"P{i}", "click") for i in range(15)]
    matrix = build_cooccurrence([hub_session], top_n=10)
    assert len(matrix.neighbors["H"]) == 10


def test_neighbors_sorted_by_score_desc() -> None:
    matrix = build_cooccurrence(_SESSIONS)
    for neighbors in matrix.neighbors.values():
        scores = [n.score for n in neighbors]
        assert scores == sorted(scores, reverse=True)


def test_schema_version_is_set() -> None:
    matrix = build_cooccurrence(_SESSIONS)
    assert matrix.schema_version == 1


def test_neighbor_is_typed() -> None:
    matrix = build_cooccurrence(_SESSIONS)
    first = matrix.neighbors["A"][0]
    assert isinstance(first, Neighbor)
    assert isinstance(first.id, str)
    assert isinstance(first.score, float)


def test_duplicate_product_in_session_accumulates_weight() -> None:
    # Two clicks on A in one session => A's engagement weight is 2.0 that session.
    sessions = [[("A", "click"), ("A", "click"), ("B", "click")]]
    matrix = build_cooccurrence(sessions)
    # dot(A,B) = 2.0·1.0 = 2.0; |A|=2, |B|=1 => cosine = 2 / (2·1) = 1.0
    a_to_b = {n.id: n.score for n in matrix.neighbors["A"]}
    assert a_to_b["B"] == pytest_approx(1.0)


def test_session_log_projects_to_event_pairs() -> None:
    logs = [
        SessionLog(
            session_id="s1",
            events=[
                {"product_id": "A", "event_type": "cart"},
                {"product_id": "B", "event_type": "click"},
            ],
        )
    ]
    sessions = sessions_from_logs(logs)
    assert sessions == [[("A", "cart"), ("B", "click")]]


def test_sessions_from_logs_round_trips_into_build() -> None:
    logs = [
        SessionLog(
            session_id="s1",
            events=[
                {"product_id": "A", "event_type": "cart"},
                {"product_id": "B", "event_type": "cart"},
            ],
        )
    ]
    matrix = build_cooccurrence(sessions_from_logs(logs))
    assert {n.id for n in matrix.neighbors["A"]} == {"B"}


def pytest_approx(value: float) -> object:
    import pytest

    return pytest.approx(value, rel=1e-9)
