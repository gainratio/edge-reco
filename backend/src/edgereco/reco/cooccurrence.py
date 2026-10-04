"""Item-to-item co-occurrence: the "customers who bought X also bought Y" math.

A pure, deterministic data transform. From a set of sessions — each a list of
``(product_id, event_type)`` interactions — it builds a sparse top-N neighbour map
per product. Each interaction contributes its ``ENGAGEMENT_WEIGHTS`` (cart 4,
favorite 3, click 1, view 0.2) to that product's per-session engagement; a product's
engagement vector indexes sessions. Neighbour scores are the **cosine similarity**
between two products' engagement vectors:

    score(a, b) = Σ_s w_a(s)·w_b(s) / ( ‖w_a‖ · ‖w_b‖ )

so two products that are co-engaged with similar intensity across the same sessions
rank highest, self is excluded, pairs are symmetric, and only the top-N neighbours
are kept. Cosine (over Jaccard) so high-intent baskets weigh more than passive views.

Carried in the signed bundle as ``cooccurrence.json``; the publisher builds it from a
session log (the shipped seed uses labeled synthetic baskets).
Mirrored in the browser tier — keep the normalisation (cosine), the ``ENGAGEMENT_WEIGHTS``,
and the top-N cut in sync.
"""

from __future__ import annotations

import math
from collections import defaultdict

from pydantic import BaseModel

from edgereco.catalog.models import EventType

#: Per-event-type weight of one interaction toward a product's per-session engagement.
#: Higher-intent signals (cart, favorite) count for more than a passive view.
ENGAGEMENT_WEIGHTS: dict[EventType, float] = {
    "click": 1.0,
    "view": 0.2,
    "favorite": 3.0,
    "cart": 4.0,
}

#: Default neighbour cap kept per product.
DEFAULT_TOP_N = 10

Session = list[tuple[str, EventType]]


class Neighbor(BaseModel):
    """One co-occurrence neighbour: a product id and its normalised score."""

    id: str
    score: float


class CooccurrenceMatrix(BaseModel):
    """Sparse top-N neighbour map, serialised as ``cooccurrence.json``."""

    schema_version: int = 1
    neighbors: dict[str, list[Neighbor]] = {}


class SessionEvent(BaseModel):
    """One interaction inside a session log line: a product and its event type."""

    product_id: str
    event_type: EventType


class SessionLog(BaseModel):
    """A logged session: an id and its ordered interactions (one JSONL line)."""

    session_id: str
    events: list[SessionEvent]


def sessions_from_logs(logs: list[SessionLog]) -> list[Session]:
    """Project typed session logs onto the ``(product_id, event_type)`` session shape."""
    return [[(e.product_id, e.event_type) for e in log.events] for log in logs]


def build_cooccurrence(
    sessions: list[Session], *, top_n: int = DEFAULT_TOP_N
) -> CooccurrenceMatrix:
    """Fold sessions into a top-N cosine co-occurrence neighbour map per product."""
    engagement = _session_engagement(sessions)
    dot = _pairwise_dot(engagement)
    norms = _norms(engagement)
    neighbors = {pid: _top_neighbors(pid, partners, norms, top_n) for pid, partners in dot.items()}
    return CooccurrenceMatrix(neighbors=neighbors)


def _session_engagement(sessions: list[Session]) -> list[dict[str, float]]:
    """Per session, sum each product's event weights into its engagement weight."""
    vectors: list[dict[str, float]] = []
    for session in sessions:
        weights: dict[str, float] = defaultdict(float)
        for product_id, event_type in session:
            weights[product_id] += ENGAGEMENT_WEIGHTS[event_type]
        vectors.append(dict(weights))
    return vectors


def _pairwise_dot(engagement: list[dict[str, float]]) -> dict[str, dict[str, float]]:
    """Accumulate Σ_s w_a(s)·w_b(s) for every co-engaged unordered pair (both directions)."""
    dot: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    for weights in engagement:
        items = list(weights.items())
        for i, (a, wa) in enumerate(items):
            for b, wb in items[i + 1 :]:
                dot[a][b] += wa * wb
                dot[b][a] += wa * wb
    return dot


def _norms(engagement: list[dict[str, float]]) -> dict[str, float]:
    """Euclidean norm of each product's engagement vector across sessions."""
    sq: dict[str, float] = defaultdict(float)
    for weights in engagement:
        for product_id, weight in weights.items():
            sq[product_id] += weight * weight
    return {pid: math.sqrt(value) for pid, value in sq.items()}


def _top_neighbors(
    pid: str, partners: dict[str, float], norms: dict[str, float], top_n: int
) -> list[Neighbor]:
    """Cosine-normalise a product's partners and keep the top-N (id-tiebroken).

    A zero norm (an all-zero engagement vector) makes the cosine undefined (0/0):
    that partner is skipped rather than divided into NaN/inf, keeping scores finite.
    """
    seed_norm = norms[pid]
    if seed_norm == 0.0:
        return []
    scored = [
        Neighbor(id=other, score=dot / (seed_norm * norms[other]))
        for other, dot in partners.items()
        if other != pid and norms[other] != 0.0
    ]
    scored.sort(key=lambda n: (-n.score, n.id))
    return scored[:top_n]
