import { describe, expect, it } from "vitest";
import type { Product, SearchResult } from "./domain";
import { DEFAULT_RANKING_CONFIG } from "./rankingConfig";
import {
	MIN_LEXICAL_RELEVANCE,
	MIN_SEMANTIC_RELEVANCE,
	meetsRelevanceFloor,
	type RetrievalEvidence,
	rerank,
	retrievalEvidence,
	scoreProduct,
} from "./reranker";
import { applyInteraction, emptyProfile, type SessionProfile } from "./session";

const WEIGHTS = DEFAULT_RANKING_CONFIG.scoring_weights;

function product(overrides: Partial<Product> & Pick<Product, "id">): Product {
	return {
		id: overrides.id,
		title: overrides.title ?? "",
		description: "",
		category: overrides.category ?? "",
		subcategories: [],
		tags: overrides.tags ?? [],
		brand: overrides.brand ?? "",
		price: null,
		currency: "USD",
		popularity_score: overrides.popularity_score ?? 0,
		freshness_score: overrides.freshness_score ?? 0,
		image_url: "",
		url: "",
		attributes: {},
	};
}

const P1 = product({
	id: "p1",
	category: "Clothing",
	tags: ["men", "golf"],
	brand: "Acme",
	popularity_score: 0.8,
	freshness_score: 0.5,
});
const P2 = product({
	id: "p2",
	category: "Shoes",
	tags: ["run"],
	brand: "Nike",
	popularity_score: 0.6,
	freshness_score: 0.2,
});

function profileFixture(): SessionProfile {
	let profile = emptyProfile();
	profile = applyInteraction(profile, P1, "click");
	profile = applyInteraction(profile, P2, "favorite");
	profile = applyInteraction(profile, P1, "cart");
	return profile;
}

// Reference values from edge-reco reco/scorer.score_product.
describe("scoreProduct (parity vs scorer.score_product)", () => {
	it("explains the exact ordered runtime formula with Assay", () => {
		const result = scoreProduct(P1, profileFixture());
		const explanation = result.score_explanation;

		expect(explanation?.method).toEqual({
			id: "additive",
			version: "edgereco.recommendation-v3",
		});
		expect(explanation?.score).toBe(0.2435000000000001);
		expect(explanation?.components.map((component) => component.id)).toEqual([
			"retrieval",
			"popularity",
			"category_match",
			"tag_match",
			"brand_match",
			"freshness",
			"similarity",
			"cooccurrence",
			"repetition_penalty",
		]);
		expect(
			explanation?.components.map((component) => component.operation),
		).toEqual([...Array.from({ length: 8 }, () => "add"), "subtract"]);
		expect(
			explanation?.components.map((component) => component.coefficient),
		).toEqual([1, 0.4, 0.2, 0.15, 0.1, 0.1, 0, 0, 0.25]);
	});

	it("breaks down the personalized score by signal", () => {
		const result = scoreProduct(P1, profileFixture());
		expect(result.score).toBeCloseTo(0.2435000000000001, 12);
		const c = result.score_components;
		expect(c?.popularity).toBeCloseTo(0.32, 12);
		expect(c?.category_match).toBeCloseTo(0.07, 12);
		expect(c?.tag_match).toBeCloseTo(0.0255, 12);
		expect(c?.brand_match).toBeCloseTo(0.028, 12);
		expect(c?.freshness).toBeCloseTo(0.05, 12);
		expect(c?.repetition_penalty).toBeCloseTo(0.25, 12);
	});

	it("scores with the empty profile (popularity + freshness only)", () => {
		const result = scoreProduct(P1, emptyProfile());
		expect(result.score).toBeCloseTo(0.37, 12);
		expect(result.score_components?.repetition_penalty).toBe(0);
		expect(result.score_components?.category_match).toBe(0);
	});

	it("averages tag affinity over the product's tags", () => {
		const result = scoreProduct(P2, profileFixture());
		// single tag 'run' affinity 0.1 * tag weight from config = 0.1 * 0.15 = 0.015
		expect(result.score_components?.tag_match).toBeCloseTo(
			0.1 * WEIGHTS.tag,
			12,
		);
	});
});

describe("scoreProduct (weights come from the ranking config)", () => {
	it("default and explicit DEFAULT_RANKING_CONFIG weights agree", () => {
		const implicit = scoreProduct(P1, profileFixture());
		const explicit = scoreProduct(P1, profileFixture(), WEIGHTS);
		expect(explicit.score).toBeCloseTo(implicit.score, 12);
		expect(explicit.score_components).toEqual(implicit.score_components);
	});

	it("honors a retuned config — doubling popularity doubles that signal", () => {
		const retuned = { ...WEIGHTS, popularity: WEIGHTS.popularity * 2 };
		const base = scoreProduct(P1, emptyProfile());
		const doubled = scoreProduct(P1, emptyProfile(), retuned);
		expect(doubled.score_components?.popularity).toBeCloseTo(
			(base.score_components?.popularity ?? 0) * 2,
			12,
		);
	});
});

describe("scoreProduct (Phase-3 co-occurrence term)", () => {
	it("adds weights.cooccurrence * cooc_score and reports the component", () => {
		const weights = { ...WEIGHTS, cooccurrence: 0.7 };
		const base = scoreProduct(P1, emptyProfile(), weights);
		const withCooc = scoreProduct(P1, emptyProfile(), weights, 0, 0.5);
		expect(withCooc.score_components?.cooccurrence).toBeCloseTo(0.7 * 0.5, 12);
		// The cooccurrence term is purely additive over the base score.
		expect(withCooc.score - base.score).toBeCloseTo(0.7 * 0.5, 12);
	});

	it("reports cooccurrence 0 when the weight or score is 0 (Phase-1/2 unchanged)", () => {
		const noWeight = scoreProduct(P1, emptyProfile(), WEIGHTS, 0, 0.9);
		expect(noWeight.score_components?.cooccurrence).toBe(0);
		const noScore = scoreProduct(
			P1,
			emptyProfile(),
			{ ...WEIGHTS, cooccurrence: 0.8 },
			0,
			0,
		);
		expect(noScore.score_components?.cooccurrence).toBe(0);
		// With both similarity and cooccurrence 0, the score equals the Phase-1 formula.
		expect(noScore.score).toBeCloseTo(
			scoreProduct(P1, emptyProfile(), WEIGHTS).score,
			12,
		);
	});
});

/** Every candidate admitted on strong semantic evidence — the "all relevant" case. */
function allAdmitted(
	...ids: ReadonlyArray<string>
): ReadonlyMap<string, RetrievalEvidence> {
	return new Map(ids.map((id) => [id, { semantic: 0.9, lexical: null }]));
}

describe("rerank", () => {
	it("keeps strong retrieval relevance ahead of popularity", () => {
		const input: SearchResult[] = [
			{ product: P2, score: 99, score_components: null },
			{ product: P1, score: 1, score_components: null },
		];
		const out = rerank(input, allAdmitted("p1", "p2"), emptyProfile());
		// Search relevance is the primary signal; popularity may refine, not erase it.
		expect(out.map((r) => r.product.id)).toEqual(["p2", "p1"]);
		expect(out[0]?.score_components?.retrieval).toBe(0.2);
		expect(out[0]?.score_components).not.toBeNull();
	});

	it("keeps input order on ties (stable, matching Python list.sort)", () => {
		const tie = product({ id: "tieA", popularity_score: 0.5 });
		const tie2 = product({ id: "tieB", popularity_score: 0.5 });
		const out = rerank(
			[
				{ product: tie, score: 0, score_components: null },
				{ product: tie2, score: 0, score_components: null },
			],
			allAdmitted("tieA", "tieB"),
			emptyProfile(),
		);
		expect(out.map((r) => r.product.id)).toEqual(["tieA", "tieB"]);
	});
});

describe("the absolute relevance floor", () => {
	// The literal the docs and the Python twin both promise. Asserted against the
	// number, not against itself — a floor compared only to its own constant would
	// pass at any value, including 0, which is the defect this replaces.
	it("is 0.4 cosine, or any strictly-positive BM25 score", () => {
		expect(MIN_SEMANTIC_RELEVANCE).toBe(0.4);
		expect(MIN_LEXICAL_RELEVANCE).toBe(0);
	});

	it("drops a candidate whose only evidence is a cosine below the floor", () => {
		expect(meetsRelevanceFloor({ semantic: 0.3999, lexical: null })).toBe(
			false,
		);
		expect(meetsRelevanceFloor({ semantic: 0.4, lexical: null })).toBe(true);
	});

	it("admits a weak-cosine candidate that the keyword index matched", () => {
		// Lexical evidence is absolute too: the query shares a discriminating term
		// with this product's indexed text, whatever the embedding thinks.
		expect(meetsRelevanceFloor({ semantic: 0.05, lexical: 0.9 })).toBe(true);
		expect(meetsRelevanceFloor({ semantic: 0.05, lexical: 0 })).toBe(false);
	});

	it("drops a candidate carrying no evidence at all (fail closed)", () => {
		expect(meetsRelevanceFloor(undefined)).toBe(false);
		expect(meetsRelevanceFloor({ semantic: null, lexical: null })).toBe(false);
	});

	// THE PROPERTY, not the shape. Before this floor, `rerank` normalized each
	// retrieval score against the best hit in its OWN result set, so the top hit
	// always scored a full 1.0 no matter how bad it was and a full page came back
	// for every query. Here the whole set is junk — and the answer is nothing.
	it("returns nothing when the BEST hit in the set is still below the floor", () => {
		const junk: SearchResult[] = [
			{ product: P1, score: 0.0328, score_components: null },
			{ product: P2, score: 0.0164, score_components: null },
		];
		const evidence = new Map<string, RetrievalEvidence>([
			["p1", { semantic: 0.397, lexical: null }],
			["p2", { semantic: 0.21, lexical: null }],
		]);
		expect(rerank(junk, evidence, emptyProfile())).toEqual([]);
	});

	it("renormalizes retrieval over the survivors, not the dropped set", () => {
		const results: SearchResult[] = [
			{ product: P1, score: 100, score_components: null },
			{ product: P2, score: 10, score_components: null },
		];
		const evidence = new Map<string, RetrievalEvidence>([
			["p1", { semantic: 0.1, lexical: null }],
			["p2", { semantic: 0.9, lexical: null }],
		]);
		const out = rerank(results, evidence, emptyProfile());
		expect(out.map((r) => r.product.id)).toEqual(["p2"]);
		// p2 is now the best admitted hit, so it takes the full relevance weight —
		// the dropped p1's score of 100 no longer sets the scale.
		expect(out[0]?.score_components?.retrieval).toBe(0.2);
	});
});

describe("retrievalEvidence", () => {
	it("keys both retrievers' absolute scores by product id", () => {
		const evidence = retrievalEvidence([
			{ id: "p1", lexicalScore: 3.5, semanticScore: 0.62 },
			{ id: "p2", lexicalScore: null, semanticScore: 0.31 },
		]);
		expect(evidence.get("p1")).toEqual({ semantic: 0.62, lexical: 3.5 });
		// Retrieved by one engine only — the other side is absent, not zero. Zero
		// would read as "scored 0", which is a measurement the retriever never made.
		expect(evidence.get("p2")).toEqual({ semantic: 0.31, lexical: null });
		expect(evidence.get("nope")).toBeUndefined();
	});
});
