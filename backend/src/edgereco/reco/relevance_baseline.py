"""The relevance seam: EdgeReco's committed ranking export scored by Assay's
ranking face, which wraps ``ir_measures``/``trec_eval`` — the IR field's reference
implementation.

WHY THIS FILE EXISTS
The engine's parity tests prove the browser reproduces the server. They cannot tell
you both are wrong. ``relevance_export.json`` (written by the frontend suite) records
what the engine actually returned for the 50 golden queries; this module turns that
record into precision/recall/nDCG/MRR/MAP so a threshold can be asserted against it.

WHY THE METRIC IS PYTHON'S
One rule in two languages will diverge. The TypeScript suite owns *producing* the
ranked lists; this module owns *scoring* them, and the numbers it produces are the
ones CI gates on. The arithmetic is not ours at all — it is trec_eval's, reached
through ``assay.ranking``. Nothing here reimplements a metric.

THE SEAM RULE (inject, don't entangle)
``assay`` is imported HERE and nowhere else in edgereco's relevance path. Upgrading,
renaming or swapping the metrics engine touches this one file.

NEVER AVERAGE ACROSS SEGMENTS
``natural`` queries are worded from text held out of both retrieval representations;
``taxonomy-word`` queries are the label field itself (the leaky control group); and
``negative`` queries have no answer in the catalog. A mean over the three is a number
about nothing. Callers ask for one segment at a time — this module has no "overall".
"""

from __future__ import annotations

from pathlib import Path
from typing import Final, Literal

from assay.models import RankedQuery, RelevanceJudgment
from assay.ranking import RankingReport, ranking_report
from assay.settings import AssaySettings
from pydantic import BaseModel, ConfigDict

#: Which measurement a query belongs to. Mirrors ``QuerySegment`` in
#: ``relevanceGoldenSet.ts`` — the export carries the segment, so the split is data,
#: not a rule restated on this side (which is how two languages diverge).
Segment = Literal["natural", "taxonomy-word", "negative"]

#: ``src/edgereco/reco/relevance_baseline.py`` -> ``backend/`` -> repo root.
_BACKEND_ROOT: Final[Path] = Path(__file__).resolve().parents[3]

#: The committed export. Same directory the parity fixtures live in, located the same
#: way ``scripts/gen_search_fixture.py`` locates its own output.
RELEVANCE_EXPORT: Final[Path] = (
    _BACKEND_ROOT.parent
    / "frontend/packages/edgereco-browser/src/engine/__fixtures__/relevance_export.json"
)


class ExportedQuery(BaseModel):
    """One golden query as the engine answered it.

    ``relevant_ids`` is ground truth cut from the product's breadcrumb path (assigned by the catalog
    generator),
    upstream of BM25, the embeddings and the reranker. ``ranked_ids`` is the engine's
    output in rank order — positions, not scores.
    """

    model_config = ConfigDict(frozen=True, extra="ignore")

    query: str
    relevant_ids: tuple[str, ...]
    ranked_ids: tuple[str, ...]
    segment: Segment


class RelevanceExport(BaseModel):
    """The whole committed export: which catalog, which label rule, which depth."""

    model_config = ConfigDict(frozen=True, extra="ignore")

    catalog_id: str
    label_method: str
    k: int
    queries: tuple[ExportedQuery, ...]

    def in_segment(self, segment: Segment) -> tuple[ExportedQuery, ...]:
        """Every query in one segment, in export order."""
        return tuple(query for query in self.queries if query.segment == segment)


def load_export(path: Path = RELEVANCE_EXPORT) -> RelevanceExport:
    """Parse the committed export, refusing any shape it does not recognise."""
    return RelevanceExport.model_validate_json(path.read_text(encoding="utf-8"))


def _as_ranked_query(query: ExportedQuery) -> RankedQuery:
    """One exported query as Assay evidence: binary judgments + the ranked list."""
    return RankedQuery(
        query=query.query,
        judgments=tuple(RelevanceJudgment(doc_id=doc_id) for doc_id in query.relevant_ids),
        ranked=query.ranked_ids,
    )


def segment_report(
    export: RelevanceExport,
    segment: Segment,
    k: int,
    settings: AssaySettings | None = None,
) -> RankingReport:
    """Every ranking metric for ONE segment at depth ``k``.

    Refuses ``negative`` outright: those queries have an empty relevant set, and Assay
    is right to refuse it rather than score 0.0 — a 0.0 there reads as "the ranker
    found nothing" and blames the ranker for missing *judgments*. Negatives are a
    different measurement (see ``full_depth_negatives``), not a lower score.
    """
    if segment == "negative":
        raise ValueError("negative queries have no relevant set; use full_depth_negatives")
    queries = export.in_segment(segment)
    if not queries:
        raise ValueError(f"export carries no {segment!r} queries")
    return ranking_report(
        [_as_ranked_query(query) for query in queries],
        k=k,
        settings=settings or AssaySettings(),
    )


def full_depth_negatives(export: RelevanceExport) -> int:
    """How many negative queries came back holding the FULL ``k`` results.

    Nothing in the catalog answers a negative query, so every result is a false
    positive. A ranker with an absolute score floor returns few or none; one that
    only rank-normalises against the best hit in its own result set must return the
    whole page, every time. This count is that distinction, measured.
    """
    negatives = export.in_segment("negative")
    return sum(1 for query in negatives if len(query.ranked_ids) >= export.k)


def negative_results(export: RelevanceExport) -> int:
    """Total false positives shown for the unanswerable queries, across all of them.

    ``full_depth_negatives`` only notices a page that is completely full, so it
    cannot tell 23 wrong answers from none. This is the finer measure the absolute
    floor is gated on — every result here is, by construction, wrong.
    """
    return sum(len(query.ranked_ids) for query in export.in_segment("negative"))


def empty_positive_pages(export: RelevanceExport) -> int:
    """How many answerable queries came back with nothing — the floor's own risk.

    A floor set too high stops returning junk by refusing to return anything. This
    counts that failure directly, so "the negatives are clean" can never be bought
    by silencing real queries.
    """
    answerable = [q for q in export.queries if q.segment != "negative"]
    return sum(1 for query in answerable if not query.ranked_ids)
