// Browser search engine: the full in-browser equivalent of edge-reco's /search
// and /recommend routes (src/edgereco/api/routes/{search,recommend}.py), driven
// from a query STRING. Pipeline, matching search.py exactly:
//
//   q -> embed(q) [embedder.ts]            (transformers.js, parity-verified)
//     -> one SQL query [catalogueDb.ts]:   (k = max(limit*3, 30))
//          FTS5 bm25 top-k + sqlite-vector cosine top-k, fused by RRF
//     -> session rerank [reranker.ts]      (always runs; empty profile = pop+fresh)
//     -> optional category filter -> slice to limit
//
// `total` is the pre-category-filter fused count (search.py total_pre_filter).
// recommend() mirrors recommend.py: an affinity-aware candidate pool (poolSelection.ts
// — popularity top-N, plus affinity top-M when warm) reranked by the session profile.
// browse() is the catalog-listing path over products.jsonl.
//
// The C2b vector-only parity path is a TEST-ONLY helper, exported separately
// as `__searchVectorForParity` (not on the public SearchEngine interface).

import type { CatalogueStoreFactory } from "./catalogueDb";
import { type CooccurrenceMatrix, EMPTY_COOCCURRENCE } from "./cooccurrence";
import type {
	BrowseResponse,
	Product,
	RecommendResponse,
	SearchResponse,
	SearchResult,
} from "./domain";
import type { Embedder } from "./embedder";
import {
	freshnessPool,
	popularityPool,
	selectCandidatePool,
} from "./poolSelection";
import {
	DEFAULT_RANKING_CONFIG,
	type InteractionWeights,
	type RankingConfig,
	type Strategy,
} from "./rankingConfig";
import {
	type RankingProofEvidence,
	unavailableRankingProof,
} from "./rankingProof";
import {
	rerank,
	rerankWithCooccurrence,
	rerankWithSimilarity,
	retrievalEvidence,
} from "./reranker";
import { emptyProfile, type SessionProfile } from "./session";
import {
	loadVectorIndex,
	type VectorIndex,
	type VectorIndexFiles,
} from "./vectorIndex";

// Parity: mirrors edge-reco's Settings.search_limit (backend config.py) — keep in sync.
const DEFAULT_LIMIT = 10;

/** Options for a search; `limit` caps results, `category` filters post-rerank. */
export interface SearchOptions {
	readonly limit?: number;
	readonly category?: string;
	readonly profile?: SessionProfile;
}

/**
 * Options for a recommend call. `strategy` defaults to `for_you` (today's
 * behavior); `seed` is the product the `vector_similarity` strategies recommend
 * around (required for those; ignored otherwise).
 */
export interface RecommendOptions {
	readonly limit?: number;
	readonly profile?: SessionProfile;
	readonly strategy?: string;
	readonly seed?: string;
}

/** Options for a seed-based similar-items call (a vector_similarity strategy). */
export interface SimilarOptions {
	readonly limit?: number;
	readonly profile?: SessionProfile;
	/** Which vector_similarity strategy to use; defaults to `similar_items`. */
	readonly strategy?: string;
}

/** Options for a catalog browse. */
export interface BrowseOptions {
	readonly limit?: number;
	readonly category?: string;
}

/** The browser-side search surface over the synced bundle. */
export interface SearchEngine {
	readonly ntotal: number;
	/** Full hybrid search from a query string (matches /search). */
	search(query: string, opts?: SearchOptions): Promise<SearchResponse>;
	/**
	 * Strategy-aware, session-aware recommendations (matches /recommend).
	 * `strategy` defaults to `for_you`; a `vector_similarity` strategy requires
	 * `seed`. Throws on an unknown strategy or a vector strategy with no seed.
	 */
	recommend(opts?: RecommendOptions): Promise<RecommendResponse>;
	/**
	 * Seed-based "similar items" rail: recommend a `vector_similarity` strategy
	 * around `productId` (kNN-to-seed → similarity-weighted rerank).
	 */
	similar(productId: string, opts?: SimilarOptions): Promise<RecommendResponse>;
	/** Catalog listing path (browse/category pages). */
	browse(opts?: BrowseOptions): BrowseResponse;
	/** The full catalog in bundle order — the lookup the events path folds clicks over. */
	catalog(): ReadonlyArray<Product>;
	/**
	 * The strategy map from the synced config (rail name → label + policy + weights).
	 * Empty for a v1 bundle (graceful degrade → only the for_you rail). The UI reads
	 * this to render the available rails and their human-facing titles.
	 */
	strategies(): Record<string, Strategy>;
	/**
	 * The per-event-type affinity bumps from the synced config. The app's
	 * sendEvent fold (and its boot-time replay) MUST use these — not the typed
	 * defaults — so a republished bundle retunes the in-tab fold exactly like
	 * the backend /events fold. Falls back to the typed defaults only for a
	 * bundle that predates ranking_config.json (parseRankingConfig handles that).
	 */
	interactionWeights(): InteractionWeights;
	/** Static publisher evidence for the live ranking config and Assay formula. */
	rankingProofEvidence(): RankingProofEvidence;
	/** Release the SQLite-vector Worker and its OPFS handle. */
	dispose(): Promise<void>;
}

function hydrateFused(
	index: VectorIndex,
	fused: ReadonlyArray<{ readonly id: string; readonly score: number }>,
): SearchResult[] {
	const results: SearchResult[] = [];
	for (const { id, score } of fused) {
		const product = index.product(id);
		if (product !== undefined) {
			results.push({ product, score, score_components: null });
		}
	}
	return results;
}

class HybridSearchEngine implements SearchEngine {
	readonly #index: VectorIndex;
	readonly #embedder: Embedder;
	readonly #catalog: ReadonlyArray<Product>;
	readonly #config: RankingConfig;
	readonly #cooccurrence: CooccurrenceMatrix;
	readonly #proofEvidence: RankingProofEvidence;

	public constructor(
		index: VectorIndex,
		embedder: Embedder,
		config: RankingConfig,
		cooccurrence: CooccurrenceMatrix,
		proofEvidence: RankingProofEvidence,
	) {
		this.#index = index;
		this.#embedder = embedder;
		this.#catalog = index.products();
		this.#config = config;
		this.#cooccurrence = cooccurrence;
		this.#proofEvidence = proofEvidence;
	}

	public get ntotal(): number {
		return this.#index.ntotal;
	}

	public catalog(): ReadonlyArray<Product> {
		return this.#catalog;
	}

	public strategies(): Record<string, Strategy> {
		return this.#config.strategies ?? {};
	}

	public interactionWeights(): InteractionWeights {
		return this.#config.interaction_weights;
	}

	public rankingProofEvidence(): RankingProofEvidence {
		return this.#proofEvidence;
	}

	public async search(
		query: string,
		opts?: SearchOptions,
	): Promise<SearchResponse> {
		const limit = opts?.limit ?? DEFAULT_LIMIT;
		if (query.trim().length === 0) {
			return { results: [], query: "", total: 0 };
		}
		// Candidate width matches the backend: k = max(limit*3, 30).
		const k = Math.max(limit * 3, 30);
		const queryVec = await this.#embedder.embed(query);
		const fused = await this.#index.hybrid(query, queryVec, k);

		const fusedResults = hydrateFused(
			this.#index,
			fused.map((row) => ({ id: row.id, score: row.fused })),
		);
		const profile = opts?.profile ?? emptyProfile();
		let reranked = rerank(
			fusedResults,
			retrievalEvidence(fused),
			profile,
			this.#config.scoring_weights,
		);
		// `total` counts what SURVIVED the absolute floor, not what fusion produced.
		// Reporting the fused count would tell a user "192 matches" above a page
		// showing none of them — the same lie the floor exists to stop telling.
		const totalPreFilter = reranked.length;
		if (opts?.category !== undefined) {
			reranked = reranked.filter((r) => r.product.category === opts.category);
		}
		return {
			results: [...reranked.slice(0, limit)],
			query,
			total: totalPreFilter,
		};
	}

	public async recommend(opts?: RecommendOptions): Promise<RecommendResponse> {
		const limit = opts?.limit ?? DEFAULT_LIMIT;
		const profile = opts?.profile ?? emptyProfile();
		const strategyName = opts?.strategy ?? "for_you";
		const strategy = this.#strategy(strategyName);
		const ranked = await this.#rankStrategy(
			strategy,
			profile,
			opts?.seed,
			limit,
		);
		return {
			results: [...ranked.slice(0, limit)],
			session_clicks: profile.clickCount,
		};
	}

	/**
	 * Build the strategy's candidate pool and rerank it, threading the right per-
	 * candidate seed signal: co_occurrence strategies thread the neighbour score
	 * (rerankWithCooccurrence); every other policy threads the cosine similarity
	 * map (rerankWithSimilarity, empty ⇒ a plain session rerank). Phase-1/2 paths
	 * carry an empty cooccurrence map, so their scores stay byte-identical.
	 */
	async #rankStrategy(
		strategy: Strategy,
		profile: SessionProfile,
		seed: string | undefined,
		limit: number,
	): Promise<ReadonlyArray<SearchResult>> {
		if (strategy.candidate_policy === "co_occurrence") {
			const { candidates, cooccurrence } = this.#cooccurrenceCandidates(
				strategy,
				seed,
			);
			return rerankWithCooccurrence(
				candidates,
				profile,
				strategy.weights,
				cooccurrence,
			);
		}
		const { candidates, similarity } = await this.#candidates(
			strategy,
			profile,
			seed,
			limit,
		);
		return rerankWithSimilarity(
			candidates,
			profile,
			strategy.weights,
			similarity,
		);
	}

	public similar(
		productId: string,
		opts?: SimilarOptions,
	): Promise<RecommendResponse> {
		// Build options without forwarding `undefined` (exactOptionalPropertyTypes);
		// recommend() applies its own DEFAULT_LIMIT / emptyProfile fallbacks.
		const recommendOpts: RecommendOptions = {
			strategy: opts?.strategy ?? "similar_items",
			seed: productId,
			...(opts?.limit !== undefined ? { limit: opts.limit } : {}),
			...(opts?.profile !== undefined ? { profile: opts.profile } : {}),
		};
		return this.recommend(recommendOpts);
	}

	/** Resolve a named strategy from the synced config (throws if unknown). */
	#strategy(name: string): Strategy {
		const strategy = this.#config.strategies?.[name];
		if (strategy === undefined) {
			throw new Error(`unknown strategy: ${name}`);
		}
		return strategy;
	}

	/**
	 * Dispatch the strategy's candidate_policy to a candidate pool + per-id
	 * similarity map. Mirrors recommend._candidates: popularity/freshness top-N,
	 * vector_similarity → kNN-to-seed (requires a seed), affinity_first → today's
	 * warm/cold pool. Only vector candidates carry a non-empty similarity map.
	 */
	async #candidates(
		strategy: Strategy,
		profile: SessionProfile,
		seed: string | undefined,
		limit: number,
	): Promise<{
		readonly candidates: SearchResult[];
		readonly similarity: ReadonlyMap<string, number>;
	}> {
		const empty = new Map<string, number>();
		switch (strategy.candidate_policy) {
			case "popularity":
				return {
					candidates: popularityPool(this.#catalog, limit),
					similarity: empty,
				};
			case "freshness":
				return {
					candidates: freshnessPool(this.#catalog, limit),
					similarity: empty,
				};
			case "vector_similarity":
				return this.#vectorCandidates(seed, limit);
			default:
				return {
					candidates: selectCandidatePool(
						this.#catalog,
						profile,
						limit,
						strategy.weights,
					),
					similarity: empty,
				};
		}
	}

	/** kNN-to-seed candidates + their cosine map (requires a seed product id). */
	async #vectorCandidates(
		seed: string | undefined,
		limit: number,
	): Promise<{
		readonly candidates: SearchResult[];
		readonly similarity: ReadonlyMap<string, number>;
	}> {
		if (seed === undefined) {
			throw new Error("vector_similarity strategy requires a seed product id");
		}
		const hits = await this.#index.nearest(seed, limit * 5);
		const similarity = new Map<string, number>();
		const candidates: SearchResult[] = [];
		for (const { id, score } of hits) {
			const product = this.#index.product(id);
			if (product !== undefined) {
				similarity.set(id, score);
				candidates.push({ product, score, score_components: null });
			}
		}
		return { candidates, similarity };
	}

	/**
	 * The seed's co-occurrence neighbours as the candidate pool, plus their scores.
	 * Mirrors recommend._cooccurrence_candidates: REQUIRES a seed (throws if absent);
	 * caps to `co_occurrence_top_k` when set (the tighter "frequently bought
	 * together" cut); each neighbour carries its co-occurrence score as the scorer's
	 * cooccurrence signal. An unknown/cold seed yields an empty pool (rail hidden).
	 */
	#cooccurrenceCandidates(
		strategy: Strategy,
		seed: string | undefined,
	): {
		readonly candidates: SearchResult[];
		readonly cooccurrence: ReadonlyMap<string, number>;
	} {
		if (seed === undefined) {
			throw new Error("co_occurrence strategy requires a seed product id");
		}
		let neighbors = this.#cooccurrence.neighbors[seed] ?? [];
		const cap = strategy.co_occurrence_top_k;
		if (cap !== null && cap !== undefined) {
			neighbors = neighbors.slice(0, cap);
		}
		const cooccurrence = new Map<string, number>();
		const candidates: SearchResult[] = [];
		for (const { id, score } of neighbors) {
			const product = this.#index.product(id);
			if (product !== undefined) {
				cooccurrence.set(id, score);
				candidates.push({ product, score, score_components: null });
			}
		}
		return { candidates, cooccurrence };
	}

	public browse(opts?: BrowseOptions): BrowseResponse {
		const limit = opts?.limit ?? DEFAULT_LIMIT;
		const filtered =
			opts?.category !== undefined
				? this.#catalog.filter((p) => p.category === opts.category)
				: this.#catalog;
		const categories = [
			...new Set(this.#catalog.map((p) => p.category)),
		].sort();
		return {
			products: filtered.slice(0, limit),
			total: filtered.length,
			categories,
		};
	}

	public dispose(): Promise<void> {
		return this.#index.dispose();
	}
}

/**
 * Parse the synced files and return a query-ready hybrid SearchEngine. The
 * ranking weights come from the bundle's verified ranking_config.json; a bundle
 * that predates the file falls back to DEFAULT_RANKING_CONFIG (today's values).
 * `cooccurrence` is the bundle's verified cooccurrence.json; a bundle that predates
 * it falls back to EMPTY_COOCCURRENCE, so the co_occurrence strategies return empty
 * (graceful degrade — the "also bought" rails are simply hidden).
 */
export async function createSearchEngine(
	files: VectorIndexFiles,
	embedder: Embedder,
	config: RankingConfig = DEFAULT_RANKING_CONFIG,
	cooccurrence: CooccurrenceMatrix = EMPTY_COOCCURRENCE,
	proofEvidence: RankingProofEvidence = unavailableRankingProof("missing"),
	catalogueFactory?: CatalogueStoreFactory,
): Promise<SearchEngine> {
	const index = await loadVectorIndex(files, catalogueFactory);
	return new HybridSearchEngine(
		index,
		embedder,
		config,
		cooccurrence,
		proofEvidence,
	);
}

/**
 * TEST-ONLY: vector-only top-k from a pre-computed query vector — the C2b
 * vector-parity path. Skips embed + BM25 + rerank, so it lets a parity test
 * isolate the vector index against a fixture query vector without needing a
 * real embedder. NOT exposed on SearchEngine; not on the production surface.
 */
export async function __searchVectorForParity(
	files: VectorIndexFiles,
	queryVec: Float32Array,
	limit: number,
	catalogueFactory?: CatalogueStoreFactory,
): Promise<SearchResponse> {
	const index = await loadVectorIndex(files, catalogueFactory);
	const k = Math.max(limit * 3, 30);
	// Fusing a single ranking is rank-monotone, so the cosine order IS the fused
	// order. Report cosine on the result (what VectorSearcher exposes).
	const hits = await index.search(queryVec, k);
	const results: SearchResult[] = [];
	for (const { id, score } of hits) {
		const product = index.product(id);
		if (product !== undefined) {
			results.push({ product, score, score_components: null });
		}
	}
	const sliced = results.slice(0, limit);
	await index.dispose();
	return { results: sliced, query: "", total: sliced.length };
}
