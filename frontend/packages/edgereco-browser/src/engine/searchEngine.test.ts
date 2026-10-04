import type { IndexManifest, Verify, VersionPointer } from "@gainratio/browser";
import {
	MemoryCacheStore,
	materializeFile,
	syncIndex,
} from "@gainratio/browser";
import { describe, expect, it } from "vitest";
import parityFixture from "./__fixtures__/search_parity.json" with {
	type: "json",
};
import { EMBEDDING_DIM, type Embedder } from "./embedder";
import { catalogFetch, latestBytes } from "./fixtures";
import { DEFAULT_RANKING_CONFIG, type RankingConfig } from "./rankingConfig";
import { __searchVectorForParity, createSearchEngine } from "./searchEngine";
import type { VectorIndexFiles } from "./vectorIndex";

const acceptVerify: Verify = () => Promise.resolve();
const DECODER = new TextDecoder();

interface ParityFixture {
	readonly embedding_dim: number;
	readonly k: number;
	readonly query_vector: ReadonlyArray<number>;
	readonly expected: ReadonlyArray<{
		readonly id: string;
		readonly score: number;
	}>;
}

async function syncedFiles(): Promise<VectorIndexFiles> {
	const store = new MemoryCacheStore();
	const { fetchBytes } = catalogFetch();
	const result = await syncIndex({
		baseUrl: "/cat",
		store,
		fetchBytes,
		verify: acceptVerify,
	});
	void (JSON.parse(DECODER.decode(latestBytes())) as VersionPointer);
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

/** Group an ordered (id, score) list into ids bucketed by rounded score, in
 * descending score order. Equal-score ties (e.g. byte-identical duplicate-vector
 * products) order arbitrarily within a bucket, so parity is asserted per bucket. */
function scoreGroups(
	entries: ReadonlyArray<{ readonly id: string; readonly score: number }>,
): ReadonlyArray<ReadonlyArray<string>> {
	const groups: { score: string; ids: string[] }[] = [];
	for (const entry of entries) {
		const key = entry.score.toFixed(5);
		const last = groups.at(-1);
		if (last !== undefined && last.score === key) {
			last.ids.push(entry.id);
		} else {
			groups.push({ score: key, ids: [entry.id] });
		}
	}
	return groups.map((g) => g.ids.slice().sort());
}

describe("createSearchEngine real-bundle parity", () => {
	it("TS top-k product ids match Python for the same query vector", async () => {
		const fixture = parityFixture as ParityFixture;
		const files = await syncedFiles();
		const query = new Float32Array(fixture.query_vector);

		const response = await __searchVectorForParity(files, query, fixture.k);

		// Same top-k by score group (ties may reorder within an equal-score group).
		expect(
			scoreGroups(
				response.results.map((r) => ({ id: r.product.id, score: r.score })),
			),
		).toEqual(scoreGroups(fixture.expected));
		// cosine scores match Python to float32 precision, in score order.
		response.results.forEach((result, i) => {
			expect(result.score).toBeCloseTo(fixture.expected[i]?.score ?? 0, 4);
		});
		expect(response.total).toBe(fixture.k);
		expect(response.query).toBe("");
	});

	it("shapes results as SearchResult with a hydrated Product", async () => {
		const fixture = parityFixture as ParityFixture;
		const files = await syncedFiles();
		const top = (
			await __searchVectorForParity(
				files,
				new Float32Array(fixture.query_vector),
				1,
			)
		).results[0];
		// The top two fixture entries tie on score (duplicate vectors); either is
		// a correct rank-1 result.
		const topTied = fixture.expected
			.filter(
				(e) => e.score.toFixed(5) === fixture.expected[0]?.score.toFixed(5),
			)
			.map((e) => e.id);
		expect(topTied).toContain(top?.product.id);
		expect(typeof top?.product.title).toBe("string");
		// C2b has no session reranker yet -> no score_components.
		expect(top?.score_components).toBeNull();
	});
});

describe("interactionWeights accessor", () => {
	it("exposes the bundle config's interaction_weights (the app fold must use them)", async () => {
		const files = await syncedFiles();
		const retunedWeights = {
			...DEFAULT_RANKING_CONFIG.interaction_weights,
			click: { category: 0.9, tag: 0.8, brand: 0.7 },
		};
		const retuned: RankingConfig = {
			...DEFAULT_RANKING_CONFIG,
			interaction_weights: retunedWeights,
		};
		const stubEmbedder: Embedder = {
			embed: () => Promise.resolve(new Float32Array(EMBEDDING_DIM)),
		};
		const engine = await createSearchEngine(files, stubEmbedder, retuned);
		expect(engine.interactionWeights()).toEqual(retunedWeights);
	});
});
