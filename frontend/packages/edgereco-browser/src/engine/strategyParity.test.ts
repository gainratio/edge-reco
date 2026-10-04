// Phase-2 multi-strategy parity: the browser engine's recommend()/similar() must
// reproduce edge-reco's Python recommend() over the SAME signed bundle + its
// strategy-map ranking_config, for every shipped strategy. Vector strategies use
// the fixture's fixed seed product. Same signed config both sides -> deterministic;
// scores match within float tolerance (the existing parity tests' bar).
//
// None of these paths touch the query embedder (recommend embeds nothing; the
// vector strategies retrieve from the STORED bundle vectors via nearest()), so a
// rejecting stub embedder keeps the model out of the test.

import type { IndexManifest, Verify } from "@gainratio/browser";
import {
	MemoryCacheStore,
	materializeFile,
	syncIndex,
} from "@gainratio/browser";
import { describe, expect, it } from "vitest";
import parityFixture from "./__fixtures__/strategy_parity.json" with {
	type: "json",
};
import type { Embedder } from "./embedder";
import { catalogFetch } from "./fixtures";
import { createSearchEngine, type SearchEngine } from "./searchEngine";
import type { VectorIndexFiles } from "./vectorIndex";

const acceptVerify: Verify = () => Promise.resolve();
const DECODER = new TextDecoder();
const stubEmbedder: Embedder = {
	embed: () => Promise.reject(new Error("embedder unused on these paths")),
};

interface StrategyCase {
	readonly strategy: string;
	readonly seed: string | null;
	readonly expected: ReadonlyArray<{
		readonly id: string;
		readonly score: number;
	}>;
}

interface StrategyParity {
	readonly limit: number;
	readonly seed_product: string;
	readonly cases: ReadonlyArray<StrategyCase>;
}

const fixture = parityFixture as StrategyParity;

async function syncedFiles(): Promise<VectorIndexFiles> {
	const store = new MemoryCacheStore();
	const { fetchBytes } = catalogFetch();
	const result = await syncIndex({
		baseUrl: "/cat",
		store,
		fetchBytes,
		verify: acceptVerify,
	});
	const manifest = JSON.parse(
		DECODER.decode(await store.getManifest(result.manifestHash)),
	) as IndexManifest;
	const read = (path: string): Promise<Uint8Array> =>
		materializeFile(store, manifest, path);
	const [meta, state, embeddings, products] = await Promise.all([
		read("catalog_meta.json"),
		read("vector/state.json"),
		read("vector/embeddings.f32"),
		read("products.jsonl"),
	]);
	return { meta, state, embeddings, products };
}

/** Build the engine over the real bundle, threading its verified strategy config. */
async function engine(): Promise<SearchEngine> {
	// createSearchEngine defaults to DEFAULT_RANKING_CONFIG, which equals the
	// committed bundle's ranking_config.json (asserted in rankingConfig.test.ts).
	return createSearchEngine(await syncedFiles(), stubEmbedder);
}

describe("multi-strategy recommend() parity vs Python strategy_parity.json", () => {
	for (const expectedCase of fixture.cases) {
		it(`matches Python for the ${expectedCase.strategy} strategy`, async () => {
			const eng = await engine();
			const response = await eng.recommend({
				strategy: expectedCase.strategy,
				limit: fixture.limit,
				// Omit `seed` (not undefined) for non-vector cases — exactOptionalPropertyTypes.
				...(expectedCase.seed !== null ? { seed: expectedCase.seed } : {}),
			});
			const gotIds = response.results.map((r) => r.product.id);
			const wantIds = expectedCase.expected.map((e) => e.id);
			// The ordered top-k ids are the real parity guarantee — asserted exact.
			expect(gotIds).toEqual(wantIds);
			// Scores match within float tolerance. Non-vector strategies are exact;
			// the vector strategies carry ~1e-9 cosine noise (JS flat dot-product
			// scan vs FAISS reconstruct_n + numpy), scaled by weights.similarity, so
			// 6 decimals is the bar — the same precision the search-parity vector
			// fixtures use.
			response.results.forEach((result, i) => {
				expect(result.score).toBeCloseTo(
					expectedCase.expected[i]?.score ?? Number.NaN,
					6,
				);
			});
		});
	}

	it("similar() routes to the similar_items strategy around the seed", async () => {
		const eng = await engine();
		const seed = fixture.seed_product;
		const expected = fixture.cases.find((c) => c.strategy === "similar_items");
		if (expected === undefined) {
			throw new Error("fixture missing similar_items case");
		}
		const viaSimilar = await eng.similar(seed, { limit: fixture.limit });
		const viaRecommend = await eng.recommend({
			strategy: "similar_items",
			seed,
			limit: fixture.limit,
		});
		// similar() is sugar over recommend({strategy:'similar_items', seed}).
		expect(viaSimilar.results.map((r) => r.product.id)).toEqual(
			viaRecommend.results.map((r) => r.product.id),
		);
		expect(viaSimilar.results.map((r) => r.product.id)).toEqual(
			expected.expected.map((e) => e.id),
		);
	});

	it("populates score_components.similarity for vector strategies", async () => {
		const eng = await engine();
		const top = (await eng.similar(fixture.seed_product, { limit: 5 }))
			.results[0];
		// weights.similarity is 0.60 for similar_items, so the top neighbor's
		// weighted similarity term is a positive contribution.
		expect(top?.score_components?.similarity).toBeGreaterThan(0);
	});

	it("populates score_components.similarity as 0 for non-vector strategies", async () => {
		const eng = await engine();
		const top = (await eng.recommend({ strategy: "trending", limit: 5 }))
			.results[0];
		expect(top?.score_components?.similarity).toBe(0);
	});

	it("throws for an unknown strategy", async () => {
		const eng = await engine();
		await expect(eng.recommend({ strategy: "nope" })).rejects.toThrow(
			/unknown strategy/,
		);
	});

	it("throws when a vector strategy is called without a seed", async () => {
		const eng = await engine();
		await expect(eng.recommend({ strategy: "similar_items" })).rejects.toThrow(
			/requires a seed/,
		);
	});
});
