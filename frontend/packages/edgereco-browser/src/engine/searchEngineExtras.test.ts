// recommend/browse/empty-query coverage for the hybrid engine. These paths do
// not touch the embedder, so a stub embedder keeps the model out of the test.

import type { IndexManifest, Verify } from "@gainratio/browser";
import {
	MemoryCacheStore,
	materializeFile,
	syncIndex,
} from "@gainratio/browser";
import { describe, expect, it } from "vitest";
import type { InteractionEvent, Product } from "./domain";
import type { Embedder } from "./embedder";
import { catalogFetch } from "./fixtures";
import { createSearchEngine, type SearchEngine } from "./searchEngine";
import { buildProfile } from "./session";
import type { VectorIndexFiles } from "./vectorIndex";

const acceptVerify: Verify = () => Promise.resolve();
const DECODER = new TextDecoder();
const stubEmbedder: Embedder = {
	embed: () => Promise.reject(new Error("embedder unused on these paths")),
};

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

async function engine(): Promise<SearchEngine> {
	return createSearchEngine(await syncedFiles(), stubEmbedder);
}

describe("hybrid engine recommend/browse", () => {
	it("returns an empty response for a blank query without embedding", async () => {
		const response = await (await engine()).search("   ");
		expect(response).toEqual({ results: [], query: "", total: 0 });
	});

	it("recommends from the popularity pool, descending, capped at limit", async () => {
		const eng = await engine();
		const response = await eng.recommend({ limit: 5 });
		expect(response.results).toHaveLength(5);
		expect(response.session_clicks).toBe(0);
		const scores = response.results.map((r) => r.score);
		for (let i = 1; i < scores.length; i += 1) {
			expect(scores[i - 1] ?? 0).toBeGreaterThanOrEqual(scores[i] ?? 0);
		}
		expect(response.results[0]?.score_components).not.toBeNull();
	});

	it("reflects session clicks and applies the repetition penalty", async () => {
		const eng = await engine();
		const baseline = await eng.recommend({ limit: 10 });
		const topProduct = baseline.results[0]?.product as Product;
		const topScore = baseline.results[0]?.score ?? 0;
		// Click the current top item: click_count rises, and the repetition
		// penalty (it is now recently_viewed) lowers its reranked score by 0.25.
		const events: InteractionEvent[] = [
			{ event_type: "click", product_id: topProduct.id, timestamp: "t0" },
		];
		const profile = buildProfile(
			events,
			new Map<string, Product>([[topProduct.id, topProduct]]),
		);
		const personalized = await eng.recommend({ limit: 10, profile });
		// session_clicks surfaces the click count from the profile.
		expect(personalized.session_clicks).toBe(1);
		// If the clicked item survives into the window its score reflects the
		// repetition penalty (down vs baseline); if it was pushed out, that is the
		// penalty working. Either way it must not retain its un-penalized score.
		const clicked = personalized.results.find(
			(r) => r.product.id === topProduct.id,
		);
		if (clicked !== undefined) {
			expect(clicked.score).toBeLessThan(topScore);
			expect(clicked.score_components?.repetition_penalty).toBe(0.25);
		}
	});

	it("browses the catalog with categories and a limit", async () => {
		const eng = await engine();
		const response = eng.browse({ limit: 8 });
		expect(response.products).toHaveLength(8);
		expect(response.total).toBe(eng.ntotal);
		expect(response.categories.length).toBeGreaterThan(0);
		expect([...response.categories].sort()).toEqual(response.categories);
	});

	it("filters browse by category", async () => {
		const eng = await engine();
		const category = eng.browse({ limit: 1 }).products[0]?.category ?? "";
		const filtered = eng.browse({ limit: 1000, category });
		expect(filtered.products.every((p) => p.category === category)).toBe(true);
		expect(filtered.total).toBe(filtered.products.length);
	});
});
