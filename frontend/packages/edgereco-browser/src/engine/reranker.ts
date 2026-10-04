// Session-aware reranker, ported from edge-reco's reco/scorer.py + reco/reranker.py.
// scoreProduct produces a live Assay explanation; rerank re-scores a result set
// and sorts it descending. The weights and ordered formula match scorer.py exactly:
//
//   retrieval + w_popularity*popularity + w_category*category_match
//   + w_tag*tag_match + w_brand*brand_match + w_freshness*freshness
//   + w_similarity*similarity + w_cooccurrence*cooccurrence
//   - w_repetition*was_recently_viewed
//
// tag_match is the MEAN tag affinity over the product's tags (0 if it has none).
// Retrieval is min-max scaled RRF for search and zero for recommendation-only rails.

import type { ScoreResult } from "@gainratio/assay";
import type { Product, ScoreComponents, SearchResult } from "./domain";
import { explainScore, type FormulaSignals } from "./formula";
import { DEFAULT_RANKING_CONFIG, type ScoringWeights } from "./rankingConfig";
import type { SessionProfile } from "./session";

/**
 * Search intent is the primary signal. RRF is min-max scaled over the admitted
 * set (best hit 1, weakest 0) before this weight is applied.
 *
 * WHY 1, AND WHY MIN-MAX. RRF at k=60 is flat: rank 1 scores 1/61 and rank 6
 * still scores ~0.9 of that. The old rule divided by the best hit and weighted
 * the result 0.2, so retrieval varied by ~0.04 across a page while popularity
 * (weight 0.4) varied by up to 0.4. The query-independent signal outvoted the
 * query: "stadium seat" led with car seat covers although both retrievers put
 * every Stadium Seats product first. Min-max uses the whole range, and a weight
 * of 1 is at least the sum of every query-independent signal (popularity 0.4 +
 * freshness 0.1), so those can reorder near-ties but never overturn the query.
 * Mirrored in backend reco/reranker.py; test_reranker.py pins both literals.
 */
export const SEARCH_RELEVANCE_WEIGHT = 1;

/**
 * What each retriever actually measured for one candidate, on its own scale and
 * independent of every other candidate in the set.
 *
 * `null` means "this retriever never scored it", which is not the same as 0. RRF
 * and the rank-normalization below both erase these numbers by design — RRF keeps
 * only positions, and the normalization divides by the best hit in the set — so a
 * result set of pure noise looks identical to a set of perfect matches once it
 * reaches the ranker. This is the only place the absolute magnitudes survive.
 */
export interface RetrievalEvidence {
	/** Cosine to the query embedding; null when the vector index did not return it. */
	readonly semantic: number | null;
	/** BM25 score; null when the keyword index did not return it. */
	readonly lexical: number | null;
}

/**
 * The absolute semantic floor: the cosine below which a document is, empirically,
 * not an answer.
 *
 * CALIBRATED, NOT CHOSEN. 0.3970 is the highest cosine any document in the catalog
 * reaches for a query the catalog cannot answer — measured over the golden set's 8
 * `negative` queries (`__fixtures__/relevanceGoldenSet.ts`), 576 candidate
 * observations. That is what noise looks like at its loudest, so the floor is that
 * ceiling rounded up to the next hundredth. Everything at or below it is
 * indistinguishable from a query with no answer at all.
 */
export const MIN_SEMANTIC_RELEVANCE = 0.4;

/**
 * The absolute lexical floor: any strictly-positive BM25 score is evidence.
 *
 * Calibrated by the same rule against the same 8 unanswerable queries, which
 * produced ZERO positive BM25 scores across those 576 observations — the measured
 * lexical noise ceiling is 0. A hit means the query literally shares a
 * discriminating term with the product's indexed text, which is absolute evidence
 * no matter what the embedding thinks. Honest limitation: the negative queries are
 * nonsense words by construction, so they can never produce a BM25 hit; this side
 * of the floor is calibrated on a tautology and a wider negative set could tighten
 * it. Dropping the lexical branch is not the safer option — a semantic-only floor
 * at 0.4 silences three real queries in the golden set outright.
 */
export const MIN_LEXICAL_RELEVANCE = 0;

/**
 * Does this candidate clear the floor on EITHER retriever?
 *
 * Hybrid retrieval produces two independent absolute signals and a document needs
 * only one of them to be a defensible answer. Missing evidence is a refusal, not a
 * pass: a candidate the caller cannot account for is dropped.
 */
export function meetsRelevanceFloor(
	evidence: RetrievalEvidence | undefined,
): boolean {
	if (evidence === undefined) {
		return false;
	}
	const semantic = evidence.semantic;
	if (semantic !== null && semantic >= MIN_SEMANTIC_RELEVANCE) {
		return true;
	}
	const lexical = evidence.lexical;
	return lexical !== null && lexical > MIN_LEXICAL_RELEVANCE;
}

/**
 * Both retrievers' raw scores, keyed by product id — the fusion input before RRF
 * throws the magnitudes away (catalogueDb.ts returns them beside each fused row).
 * Absent on one side stays `null`, never 0.
 */
export function retrievalEvidence(
	rows: ReadonlyArray<{
		readonly id: string;
		readonly lexicalScore: number | null;
		readonly semanticScore: number | null;
	}>,
): ReadonlyMap<string, RetrievalEvidence> {
	return new Map(
		rows.map((row) => [
			row.id,
			{ semantic: row.semanticScore, lexical: row.lexicalScore },
		]),
	);
}

function scoreComponents(explanation: ScoreResult): ScoreComponents {
	const rows = new Map(
		explanation.components.map((component) => [
			component.id,
			component.contribution,
		]),
	);
	const value = (id: keyof ScoreComponents): number => rows.get(id) ?? 0;
	return {
		retrieval: value("retrieval"),
		popularity: value("popularity"),
		category_match: value("category_match"),
		tag_match: value("tag_match"),
		brand_match: value("brand_match"),
		freshness: value("freshness"),
		similarity: value("similarity"),
		cooccurrence: value("cooccurrence"),
		repetition_penalty: value("repetition_penalty"),
	};
}

/**
 * Personalized score + signal breakdown for a product (scorer.score_product).
 * `weights` come from the synced bundle's ranking_config.json; they default to
 * DEFAULT_RANKING_CONFIG so call sites on an older bundle keep today's scores.
 *
 * `similarity` is the per-candidate cosine to a seed product, threaded in by the
 * vector_similarity strategies; `cooccurrence` is the per-candidate co-occurrence
 * score to a seed, threaded in by the co_occurrence strategies. Both default to 0
 * so every other path reduces to the original Phase-1 formula byte-for-byte.
 */
export function scoreProduct(
	product: Product,
	profile: SessionProfile,
	weights: ScoringWeights = DEFAULT_RANKING_CONFIG.scoring_weights,
	similarity = 0,
	cooccurrence = 0,
	retrieval = 0,
): SearchResult {
	const catMatch = profile.categoryAffinity.get(product.category) ?? 0;

	let tagMatch = 0;
	if (product.tags.length > 0) {
		const total = product.tags.reduce(
			(sum, tag) => sum + (profile.tagAffinity.get(tag) ?? 0),
			0,
		);
		tagMatch = total / product.tags.length;
	}

	const brandMatch = product.brand
		? (profile.brandAffinity.get(product.brand) ?? 0)
		: 0;

	const signals: FormulaSignals = {
		retrieval,
		popularity: product.popularity_score,
		category_match: catMatch,
		tag_match: tagMatch,
		brand_match: brandMatch,
		freshness: product.freshness_score,
		similarity,
		cooccurrence,
		repetition_penalty: Number(profile.recentlyViewed.includes(product.id)),
	};
	const explanation = explainScore(signals, weights);

	return {
		product,
		score: explanation.score,
		score_components: scoreComponents(explanation),
		score_explanation: explanation,
	};
}

/**
 * Map a fused RRF score to the retrieval component: SEARCH_RELEVANCE_WEIGHT times
 * its min-max position in `scores`. No positive score means no scale (0 for
 * all); a flat set gives every candidate the full weight.
 */
export function retrievalScale(
	scores: ReadonlyArray<number>,
): (score: number) => number {
	const clamped = scores.map((score) => Math.max(0, score));
	const max = Math.max(0, ...clamped);
	const min = Math.min(max, ...clamped);
	if (max === 0) {
		return () => 0;
	}
	if (max === min) {
		return () => SEARCH_RELEVANCE_WEIGHT;
	}
	return (score) =>
		(SEARCH_RELEVANCE_WEIGHT * (Math.max(0, score) - min)) / (max - min);
}

/**
 * Drop every candidate that fails the absolute floor, then re-score the survivors
 * against the profile and sort descending. Mirrors reranker.rerank_search: a stable
 * descending sort (ties keep input order), matching Python's list.sort stability so
 * fused-rank ties resolve identically.
 *
 * WHY THE FLOOR RUNS FIRST, AND WHY IT DROPS RATHER THAN DEMOTES
 * `r.score` is the RRF fused score, which is built from POSITIONS: a document
 * ranked first by one retriever scores 1/61 whether it is a perfect match or the
 * least bad of 720 wrong answers. The normalization below then divides by the best
 * hit in this very result set, so the top result always takes the full relevance
 * weight — by construction, for every query ever asked. Nothing downstream can
 * express "no good match", so a full page came back for queries with no answer at
 * all. Ranking junk last does not fix that; only refusing to return it does.
 */
export function rerank(
	results: ReadonlyArray<SearchResult>,
	evidence: ReadonlyMap<string, RetrievalEvidence>,
	profile: SessionProfile,
	weights: ScoringWeights = DEFAULT_RANKING_CONFIG.scoring_weights,
): ReadonlyArray<SearchResult> {
	const admitted = results.filter((r) =>
		meetsRelevanceFloor(evidence.get(r.product.id)),
	);
	const scale = retrievalScale(admitted.map((result) => result.score));
	const rescored = admitted.map((r, index) => ({
		result: scoreProduct(r.product, profile, weights, 0, 0, scale(r.score)),
		index,
	}));
	rescored.sort((a, b) => b.result.score - a.result.score || a.index - b.index);
	return rescored.map((entry) => entry.result);
}

/**
 * Re-score every candidate threading its per-id similarity (cosine to a seed),
 * then sort descending — the strategy-aware path mirroring recommend._rerank.
 * `similarity` maps product id → cosine; absent ids score 0, so a strategy whose
 * weights.similarity is 0 reduces to the plain `rerank` result.
 */
export function rerankWithSimilarity(
	results: ReadonlyArray<SearchResult>,
	profile: SessionProfile,
	weights: ScoringWeights,
	similarity: ReadonlyMap<string, number>,
): ReadonlyArray<SearchResult> {
	const rescored = results.map((r, index) => ({
		result: scoreProduct(
			r.product,
			profile,
			weights,
			similarity.get(r.product.id) ?? 0,
		),
		index,
	}));
	rescored.sort((a, b) => b.result.score - a.result.score || a.index - b.index);
	return rescored.map((entry) => entry.result);
}

/**
 * Re-score every candidate threading its per-id co-occurrence score (the seed's
 * neighbour strength), then sort descending — the co_occurrence strategy path
 * mirroring recommend._rerank. `cooccurrence` maps product id → neighbour score;
 * absent ids score 0, so a strategy whose weights.cooccurrence is 0 reduces to the
 * plain `rerank` result. similarity is 0 on this path (co-occurrence carries no
 * cosine), so Phase-1/2 strategies stay byte-identical.
 */
export function rerankWithCooccurrence(
	results: ReadonlyArray<SearchResult>,
	profile: SessionProfile,
	weights: ScoringWeights,
	cooccurrence: ReadonlyMap<string, number>,
): ReadonlyArray<SearchResult> {
	const rescored = results.map((r, index) => ({
		result: scoreProduct(
			r.product,
			profile,
			weights,
			0,
			cooccurrence.get(r.product.id) ?? 0,
		),
		index,
	}));
	rescored.sort((a, b) => b.result.score - a.result.score || a.index - b.index);
	return rescored.map((entry) => entry.result);
}
