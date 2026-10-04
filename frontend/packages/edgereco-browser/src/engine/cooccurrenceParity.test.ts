// Phase-3 co-occurrence parity: the browser engine's recommend() for the
// co_occurrence strategies (also_bought, frequently_bought_together) must reproduce
// edge-reco's Python recommend() over the SAME signed bundle + its signed
// cooccurrence.json + schema-3 ranking_config. The matrix is read through the
// verified sync path (materializeFile); same signed data both sides ⇒ deterministic.
//
// None of these paths touch the query embedder (recommend embeds nothing; the
// co_occurrence pool is a local neighbour lookup), so a rejecting stub embedder
// keeps the model out of the test.

import type { IndexManifest, Verify } from "@gainratio/browser";
import {
	MemoryCacheStore,
	materializeFile,
	syncIndex,
} from "@gainratio/browser";
import { describe, expect, it } from "vitest";
import cooccurrenceFixture from "./__fixtures__/cooccurrence_parity.json" with {
	type: "json",
};
import { parseCooccurrence } from "./cooccurrence";
import type { Embedder } from "./embedder";
import { catalogFetch } from "./fixtures";
import { parseRankingConfig } from "./rankingConfig";
import { createSearchEngine, type SearchEngine } from "./searchEngine";

const acceptVerify: Verify = () => Promise.resolve();
const stubEmbedder: Embedder = {
	embed: () => Promise.reject(new Error("embedder unused on these paths")),
};

interface CooccurrenceCase {
	readonly strategy: string;
	readonly seed: string;
	readonly expected: ReadonlyArray<{
		readonly id: string;
		readonly score: number;
	}>;
}

interface CooccurrenceParity {
	readonly limit: number;
	readonly seed_product: string;
	readonly cases: ReadonlyArray<CooccurrenceCase>;
}

const fixture = cooccurrenceFixture as CooccurrenceParity;

/**
 * Build the engine over the REAL bundle, threading BOTH verified signed files
 * (ranking_config.json + cooccurrence.json) read off the same materialize path.
 */
async function engine(): Promise<SearchEngine> {
	const store = new MemoryCacheStore();
	const { fetchBytes } = catalogFetch();
	const result = await syncIndex({
		baseUrl: "/cat",
		store,
		fetchBytes,
		verify: acceptVerify,
	});
	const manifest = JSON.parse(
		new TextDecoder().decode(await store.getManifest(result.manifestHash)),
	) as IndexManifest;
	const read = (path: string): Promise<Uint8Array> =>
		materializeFile(store, manifest, path);
	const [meta, state, embeddings, products, rankingBytes, coocBytes] =
		await Promise.all([
			read("catalog_meta.json"),
			read("vector/state.json"),
			read("vector/embeddings.f32"),
			read("products.jsonl"),
			read("ranking_config.json"),
			read("cooccurrence.json"),
		]);
	return createSearchEngine(
		{ meta, state, embeddings, products },
		stubEmbedder,
		parseRankingConfig(rankingBytes),
		parseCooccurrence(coocBytes),
	);
}

describe("co-occurrence recommend() parity vs Python cooccurrence_parity.json", () => {
	for (const expectedCase of fixture.cases) {
		it(`matches Python for the ${expectedCase.strategy} strategy`, async () => {
			const eng = await engine();
			const response = await eng.recommend({
				strategy: expectedCase.strategy,
				seed: expectedCase.seed,
				limit: fixture.limit,
			});
			const gotIds = response.results.map((r) => r.product.id);
			const wantIds = expectedCase.expected.map((e) => e.id);
			// The ordered top-k ids are the real parity guarantee — asserted exact.
			expect(gotIds).toEqual(wantIds);
			// Scores match within the same float tolerance the other parity tests use
			// (6 decimals): pure data both sides, only IEEE-754 summation noise.
			response.results.forEach((result, i) => {
				expect(result.score).toBeCloseTo(
					expectedCase.expected[i]?.score ?? Number.NaN,
					6,
				);
			});
		});
	}

	it("applies the frequently_bought_together top-k cut (tighter than also_bought)", async () => {
		const eng = await engine();
		const also = await eng.recommend({
			strategy: "also_bought",
			seed: fixture.seed_product,
			limit: fixture.limit,
		});
		const fbt = await eng.recommend({
			strategy: "frequently_bought_together",
			seed: fixture.seed_product,
			limit: fixture.limit,
		});
		// fbt caps to co_occurrence_top_k (3); also_bought keeps all neighbours.
		expect(fbt.results.length).toBe(3);
		expect(also.results.length).toBeGreaterThan(fbt.results.length);
	});

	it("populates score_components.cooccurrence for the co_occurrence strategies", async () => {
		const eng = await engine();
		const top = (
			await eng.recommend({
				strategy: "also_bought",
				seed: fixture.seed_product,
				limit: 5,
			})
		).results[0];
		// weights.cooccurrence is 0.70 for also_bought ⇒ the top neighbour's
		// weighted co-occurrence term is a positive contribution.
		expect(top?.score_components?.cooccurrence).toBeGreaterThan(0);
	});

	it("throws when a co_occurrence strategy is called without a seed", async () => {
		const eng = await engine();
		await expect(eng.recommend({ strategy: "also_bought" })).rejects.toThrow(
			/requires a seed/,
		);
	});

	it("returns an empty pool for an unknown/cold seed (rail hidden)", async () => {
		const eng = await engine();
		const response = await eng.recommend({
			strategy: "also_bought",
			seed: "NOT_A_REAL_PRODUCT_ID",
			limit: fixture.limit,
		});
		expect(response.results).toEqual([]);
	});
});
