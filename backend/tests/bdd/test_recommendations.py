"""Step impls for features/recommendations.feature."""

from __future__ import annotations

from dataclasses import dataclass

import pytest
from pytest_bdd import given, parsers, scenarios, then, when

from edgereco.catalog.models import Product, SearchResult, SessionProfile
from edgereco.reco.ranking_config import DEFAULT_RANKING_CONFIG
from edgereco.reco.reranker import rerank

scenarios("recommendations.feature")


@dataclass
class StepContext:
    """Mutable state shared across recommendation BDD steps."""

    catalog: list[Product] | None = None
    by_id: dict[str, Product] | None = None
    profile: SessionProfile | None = None
    candidates: list[SearchResult] | None = None
    reranked: list[SearchResult] | None = None


@pytest.fixture
def ctx() -> StepContext:
    return StepContext()


@given("the mini catalog of 50 products is loaded")
def _catalog_loaded(ctx: StepContext, bdd_catalog: list[Product]) -> None:
    ctx.catalog = bdd_catalog
    ctx.by_id = {p.id: p for p in bdd_catalog}
    assert len(bdd_catalog) == 50


@given("a fresh empty session profile")
def _fresh_profile(ctx: StepContext) -> None:
    ctx.profile = SessionProfile()


@given("a candidate result list mixing Electronics and Books")
def _mixed_candidates(ctx: StepContext) -> None:
    by_id: dict[str, Product] = ctx.by_id
    electronics = [p for p in by_id.values() if p.category == "Electronics"][:3]
    books = [p for p in by_id.values() if p.category == "Books"][:3]
    candidates = electronics + books
    ctx.candidates = [SearchResult(product=p, score=0.5) for p in candidates]


@given("a candidate result list of three Electronics products")
def _three_electronics(ctx: StepContext) -> None:
    by_id: dict[str, Product] = ctx.by_id
    electronics = [p for p in by_id.values() if p.category == "Electronics"][:3]
    # Ensure B001 is one of them
    if not any(p.id == "B001" for p in electronics):
        electronics = [by_id["B001"], *electronics[:2]]
    ctx.candidates = [SearchResult(product=p, score=0.5) for p in electronics]


@when(parsers.parse('the profile holds a click on product "{product_id}"'))
def _profile_with_click(ctx: StepContext, product_id: str) -> None:
    """A profile shaped like the browser tier's after one click on ``product_id``."""
    product = ctx.by_id[product_id]
    bump = DEFAULT_RANKING_CONFIG.interaction_weights.click
    ctx.profile = SessionProfile(
        category_affinity={product.category: bump.category},
        tag_affinity=dict.fromkeys(product.tags, bump.tag),
        brand_affinity={product.brand: bump.brand} if product.brand else {},
        recently_viewed=[product.id],
        click_count=1,
    )


@when("I rerank the candidate list")
def _rerank_default(ctx: StepContext) -> None:
    ctx.reranked = rerank(ctx.candidates, ctx.profile)


@when("I rerank the candidate list with the fresh empty session profile")
def _rerank_fresh(ctx: StepContext) -> None:
    ctx.reranked = rerank(ctx.candidates, SessionProfile())


@then(parsers.parse("the top reranked product should be in the {category} category"))
def _top_in_category(ctx: StepContext, category: str) -> None:
    assert ctx.reranked[0].product.category == category


@then(parsers.parse('product "{product_id}" should not be the top reranked product'))
def _not_top(ctx: StepContext, product_id: str) -> None:
    assert ctx.reranked[0].product.id != product_id


@then("the reranked list should contain all candidates")
def _all_present(ctx: StepContext) -> None:
    assert len(ctx.reranked) == len(ctx.candidates)
    cand_ids = {c.product.id for c in ctx.candidates}
    rerank_ids = {r.product.id for r in ctx.reranked}
    assert cand_ids == rerank_ids
