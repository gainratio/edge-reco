// The data layer is now backend-free: every call runs the in-browser engine over
// the synced bundle, and sendEvent folds clicks into the in-tab session profile
// (no network) so the next recommend() re-ranks. These tests bootstrap the client
// against the REAL committed bundle via an injected fake sync-Worker + a stub
// embedder, then assert the contract shapes and the live re-rank loop in Node.

import {
	type IndexManifest,
	MemoryCacheStore,
	materializeFile,
	syncIndex,
	type Verify,
} from "@edgeproc/browser";
import {
	EMBEDDING_DIM,
	type Embedder,
	type EnginePort,
	type RankingConfig,
	type SyncResult,
} from "@edgereco/browser";
import { catalogFetch } from "@edgereco/browser/testing/fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSnapshot } from "../metrics/store";
import {
	__setTasteLogBackendForTests,
	readTasteEvents,
	type TasteLogBackend,
} from "../signals/tasteLog";
import {
	__setRuntimeForTests,
	bootstrap,
	browse,
	catalog,
	catalogInfo,
	clearCatalogCache,
	rankingProofEvidence,
	recommend,
	recommendStrategy,
	replayedSignalCount,
	resetSession,
	search,
	sendEvent,
	similar,
	strategies,
} from "./client";
import type { Product } from "./types";

const acceptVerify: Verify = () => Promise.resolve();
const DECODER = new TextDecoder();

/** A fake sync Worker backed by the real committed bundle (no network, no OPFS). */
function fakeEnginePort(): EnginePort {
	const store = new MemoryCacheStore();
	const { fetchBytes } = catalogFetch();
	let manifest: IndexManifest | null = null;
	return {
		async sync(): Promise<SyncResult> {
			const result = await syncIndex({
				baseUrl: "/cat",
				store,
				fetchBytes,
				verify: acceptVerify,
			});
			manifest = JSON.parse(
				DECODER.decode(await store.getManifest(result.manifestHash)),
			) as IndexManifest;
			return result;
		},
		readFile(path: string): Promise<Uint8Array> {
			if (manifest === null) {
				throw new Error("sync first");
			}
			return materializeFile(store, manifest, path);
		},
	};
}

// A unit query vector — the embedder is unused for the contract assertions, but
// search() must get a valid 384-d vector to run the vector leg.
const stubEmbedder: Embedder = {
	embed(): Promise<Float32Array> {
		const v = new Float32Array(EMBEDDING_DIM);
		v[0] = 1;
		return Promise.resolve(v);
	},
};

describe("backend-free data layer", () => {
	beforeEach(async () => {
		__setRuntimeForTests({
			spawnEngine: () => fakeEnginePort(),
			makeEmbedder: () => stubEmbedder,
		});
		await bootstrap();
	});

	afterEach(() => {
		__setRuntimeForTests({
			spawnEngine: () => fakeEnginePort(),
			makeEmbedder: () => stubEmbedder,
		});
	});

	it("bootstrap reports stages ending in 'ready'", async () => {
		__setRuntimeForTests({
			spawnEngine: () => fakeEnginePort(),
			makeEmbedder: () => stubEmbedder,
		});
		const stages: string[] = [];
		await bootstrap((stage) => stages.push(stage.kind));
		expect(stages[0]).toBe("syncing");
		expect(stages.at(-1)).toBe("ready");
	});

	it("search() returns the SearchResponse shape from the engine", async () => {
		const res = await search("headphones", { limit: 5 });
		expect(res.query).toBe("headphones");
		expect(Array.isArray(res.results)).toBe(true);
		expect(res.results.length).toBeLessThanOrEqual(5);
		expect(typeof res.total).toBe("number");
	});

	it("browse() lists products with categories", async () => {
		const res = await browse({ limit: 8 });
		expect(res.products).toHaveLength(8);
		expect(res.categories.length).toBeGreaterThan(0);
	});

	it("catalogInfo() reports the catalog size", async () => {
		const info = await catalogInfo();
		expect(info.count).toBe((await browse({ limit: 10_000 })).total);
	});

	// The committed bundle used to carry a legacy receipt ("legacy", unverifiable).
	// Rebuilding it for the synthetic catalog wrote a current edgereco.ranking-proof/v1
	// receipt. This harness supplies no trusted key, so the honest answer is still
	// "unavailable" — now because the key is missing, and never "verified" without one.
	it("never reports the committed ranking receipt verified without a trusted key", () => {
		expect(rankingProofEvidence()).toEqual({
			status: "unavailable",
			publisherSignature: "not_checked",
			configHash: "not_checked",
			reason: "key_unavailable",
		});
	});

	it("a click folds into the profile and re-ranks the next recommend (no network)", async () => {
		const cold = await recommend(10);
		expect(cold.session_clicks).toBe(0);
		const coldOrder = cold.results.map((r) => r.product.id).join(",");

		// Click 3 products in one category — clicks update the IN-TAB profile only.
		const target = cold.results[0]?.product as Product;
		const sameCategory = (await browse({ limit: 10_000 })).products
			.filter((p) => p.category === target.category)
			.slice(0, 3);
		for (const product of sameCategory) {
			await sendEvent({
				event_type: "click",
				product_id: product.id,
				timestamp: new Date().toISOString(),
			});
		}

		const warm = await recommend(10);
		expect(warm.session_clicks).toBe(3);
		const warmOrder = warm.results.map((r) => r.product.id).join(",");
		expect(warmOrder).not.toBe(coldOrder);

		// Meaningful personalization (not just a tie-break reshuffle): the affinity-aware
		// pool surfaces at least one product the cold rail never showed.
		const coldIds = new Set(cold.results.map((r) => r.product.id));
		const newcomers = warm.results.filter((r) => !coldIds.has(r.product.id));
		expect(newcomers.length).toBeGreaterThan(0);
	});

	it("ignores clicks on unknown product ids", async () => {
		await sendEvent({
			event_type: "click",
			product_id: "does-not-exist",
			timestamp: new Date().toISOString(),
		});
		const res = await recommend(5);
		expect(res.session_clicks).toBe(0);
	});

	it("records a non-negative searchMs latency when search() runs", async () => {
		await search("headphones", { limit: 3 });
		const { searchMs } = getSnapshot();
		expect(typeof searchMs).toBe("number");
		expect(searchMs).toBeGreaterThanOrEqual(0);
	});

	it("records a non-negative recommendMs latency when recommend() runs", async () => {
		await recommend(3);
		const { recommendMs } = getSnapshot();
		expect(typeof recommendMs).toBe("number");
		expect(recommendMs).toBeGreaterThanOrEqual(0);
	});

	it("strategies() exposes the seed bundle's named strategies", () => {
		const map = strategies();
		expect(map.for_you?.label).toBe("Recommended for you");
		expect(map.trending?.label).toBe("Trending now");
		expect(map.new_arrivals?.label).toBe("New arrivals");
		expect(map.similar_items?.candidate_policy).toBe("vector_similarity");
		expect(map.because_viewed?.candidate_policy).toBe("vector_similarity");
	});

	it("catalog() returns the full product list", async () => {
		const products = catalog();
		expect(products.length).toBe((await browse({ limit: 10_000 })).total);
		expect(typeof products[0]?.id).toBe("string");
	});

	it("recommendStrategy('trending') ignores the live profile (stable rail)", async () => {
		const cold = await recommendStrategy("trending", { limit: 8 });
		const coldOrder = cold.results.map((r) => r.product.id).join(",");
		// Click 3 products — trending is popularity-driven, NOT affinity-driven,
		// so its order must not move with the session profile.
		const target = cold.results[0]?.product as Product;
		const sameCategory = catalog()
			.filter((p) => p.category === target.category)
			.slice(0, 3);
		for (const product of sameCategory) {
			await sendEvent({
				event_type: "click",
				product_id: product.id,
				timestamp: new Date().toISOString(),
			});
		}
		const warm = await recommendStrategy("trending", { limit: 8 });
		expect(warm.results.map((r) => r.product.id).join(",")).toBe(coldOrder);
	});

	it("recommendStrategy('for_you') threads the live profile and re-ranks", async () => {
		const cold = await recommendStrategy("for_you", { limit: 10 });
		const coldOrder = cold.results.map((r) => r.product.id).join(",");
		const target = cold.results[0]?.product as Product;
		const sameCategory = catalog()
			.filter((p) => p.category === target.category)
			.slice(0, 3);
		for (const product of sameCategory) {
			await sendEvent({
				event_type: "click",
				product_id: product.id,
				timestamp: new Date().toISOString(),
			});
		}
		const warm = await recommendStrategy("for_you", { limit: 10 });
		expect(warm.session_clicks).toBe(3);
		expect(warm.results.map((r) => r.product.id).join(",")).not.toBe(coldOrder);
	});

	it("similar(seed) returns seed-relevant items that exclude the seed", async () => {
		const seed = catalog()[0] as Product;
		const res = await similar(seed.id, { limit: 6 });
		expect(res.results.length).toBeGreaterThan(0);
		expect(res.results.every((r) => r.product.id !== seed.id)).toBe(true);
	});

	it("recommendStrategy('because_viewed', {seed}) seeds a vector rail", async () => {
		const seed = catalog()[0] as Product;
		const res = await recommendStrategy("because_viewed", {
			seed: seed.id,
			limit: 6,
		});
		expect(res.results.length).toBeGreaterThan(0);
		expect(res.results.every((r) => r.product.id !== seed.id)).toBe(true);
	});

	it("recommendStrategy records a non-negative recommendMs latency", async () => {
		await recommendStrategy("trending", { limit: 3 });
		const { recommendMs } = getSnapshot();
		expect(recommendMs).toBeGreaterThanOrEqual(0);
	});

	it("similar records a non-negative recommendMs latency", async () => {
		const seed = catalog()[0] as Product;
		await similar(seed.id, { limit: 3 });
		const { recommendMs } = getSnapshot();
		expect(recommendMs).toBeGreaterThanOrEqual(0);
	});
});

/**
 * A fake sync Worker over the real bundle whose ranking_config.json is retuned
 * in-flight — the unit-test analogue of a maintainer republishing a bundle with
 * different weights (backend tests/integration/test_events_retune.py).
 */
function retunedEnginePort(
	mutate: (config: RankingConfig) => RankingConfig,
): EnginePort {
	const base = fakeEnginePort();
	return {
		sync: (...args: Parameters<EnginePort["sync"]>) => base.sync(...args),
		async readFile(path: string): Promise<Uint8Array> {
			const bytes = await base.readFile(path);
			if (path !== "ranking_config.json") {
				return bytes;
			}
			const config = JSON.parse(DECODER.decode(bytes)) as RankingConfig;
			return new TextEncoder().encode(JSON.stringify(mutate(config)));
		},
	};
}

/** Zero out one scoring weight on the top-level weights AND every strategy. */
function withZeroRepetitionPenalty(config: RankingConfig): RankingConfig {
	const strategies = Object.fromEntries(
		Object.entries(config.strategies ?? {}).map(([name, strategy]) => [
			name,
			{
				...strategy,
				weights: { ...strategy.weights, repetition_penalty: 0 },
			},
		]),
	);
	return {
		...config,
		scoring_weights: { ...config.scoring_weights, repetition_penalty: 0 },
		strategies,
	};
}

describe("bundle-supplied interaction weights drive the in-tab fold", () => {
	// Mirror of the backend events.py contract: the fold reads the SIGNED
	// BUNDLE's interaction_weights, not the typed defaults. The retuned bundle
	// zeroes the click affinity bumps (and the repetition penalty, so
	// recently-viewed bookkeeping cannot re-rank either) — clicks must then
	// leave the for_you rail EXACTLY as cold. A fold that ignores the bundle
	// and uses DEFAULT_RANKING_CONFIG re-ranks the rail and fails this test.
	it("a bundle that zeroes click weights leaves for_you unmoved by clicks", async () => {
		__setRuntimeForTests({
			spawnEngine: () =>
				retunedEnginePort((config) =>
					withZeroRepetitionPenalty({
						...config,
						interaction_weights: {
							...config.interaction_weights,
							click: { category: 0, tag: 0, brand: 0 },
						},
					}),
				),
			makeEmbedder: () => stubEmbedder,
		});
		await bootstrap();

		const cold = await recommendStrategy("for_you", { limit: 10 });
		const coldOrder = cold.results.map((r) => r.product.id).join(",");
		const target = cold.results[0]?.product as Product;
		const sameCategory = catalog()
			.filter((p) => p.category === target.category)
			.slice(0, 3);
		for (const product of sameCategory) {
			await sendEvent({
				event_type: "click",
				product_id: product.id,
				timestamp: new Date().toISOString(),
			});
		}

		const warm = await recommendStrategy("for_you", { limit: 10 });
		// The clicks DID fold (the click counter moved) …
		expect(warm.session_clicks).toBe(3);
		// … but the bundle's zeroed click weights mean zero affinity: the rail
		// must not move. (DEFAULT weights would bump category/tag/brand and
		// re-rank — the exact latent bug this test pins.)
		expect(warm.results.map((r) => r.product.id).join(",")).toBe(coldOrder);
	});
});

/** In-memory taste-log backend: the durable-storage stand-in for these tests. */
function memoryTasteBackend(): TasteLogBackend {
	let text: string | null = null;
	return {
		read: () => Promise.resolve(text),
		write: (next: string) => {
			text = next;
			return Promise.resolve();
		},
		remove: () => {
			text = null;
			return Promise.resolve();
		},
	};
}

const freshDeps = () => ({
	spawnEngine: () => fakeEnginePort(),
	makeEmbedder: () => stubEmbedder,
});

/** Click 3 same-category products (the standard warm-up used across this file). */
async function clickThreeSameCategory(): Promise<Product[]> {
	const cold = await recommendStrategy("for_you", { limit: 10 });
	const target = cold.results[0]?.product as Product;
	const sameCategory = catalog()
		.filter((p) => p.category === target.category)
		.slice(0, 3);
	for (const product of sameCategory) {
		await sendEvent({
			event_type: "click",
			product_id: product.id,
			timestamp: new Date().toISOString(),
		});
	}
	return sameCategory;
}

describe("durable taste: replay on boot, reset, replayed count", () => {
	beforeEach(() => {
		localStorage.clear();
		__setTasteLogBackendForTests(memoryTasteBackend());
		__setRuntimeForTests(freshDeps());
	});

	afterEach(() => {
		__setTasteLogBackendForTests(undefined);
	});

	it("replays the persisted log through the SAME fold on a fresh boot", async () => {
		await bootstrap();
		await clickThreeSameCategory();
		const warm = await recommendStrategy("for_you", { limit: 10 });
		expect(warm.session_clicks).toBe(3);
		const warmOrder = warm.results.map((r) => r.product.id).join(",");

		// "Reload": a brand-new client over the SAME durable log.
		__setRuntimeForTests(freshDeps());
		await bootstrap();
		const replayed = await recommendStrategy("for_you", { limit: 10 });

		// Deterministic replay: same events + same fold ⇒ same profile ⇒ the
		// exact same personalized rail, not merely "some" personalization.
		expect(replayed.session_clicks).toBe(3);
		expect(replayed.results.map((r) => r.product.id).join(",")).toBe(warmOrder);
	});

	it("does not log events for unknown product ids (mirrors the fold's skip)", async () => {
		await bootstrap();
		await sendEvent({
			event_type: "click",
			product_id: "does-not-exist",
			timestamp: new Date().toISOString(),
		});
		expect(await readTasteEvents()).toEqual([]);
	});

	it("resetSession clears the profile AND the durable log", async () => {
		await bootstrap();
		await clickThreeSameCategory();
		await resetSession();

		expect(
			(await recommendStrategy("for_you", { limit: 5 })).session_clicks,
		).toBe(0);
		expect(await readTasteEvents()).toEqual([]);

		// A fresh boot after reset stays cold — nothing left to replay.
		__setRuntimeForTests(freshDeps());
		await bootstrap();
		expect(
			(await recommendStrategy("for_you", { limit: 5 })).session_clicks,
		).toBe(0);
		expect(replayedSignalCount()).toBe(0);
	});

	it("replayedSignalCount counts replayed explicit signals, not ambient views", async () => {
		await bootstrap();
		const products = catalog().slice(0, 3);
		const events = [
			{ event_type: "click", product_id: products[0]?.id },
			{ event_type: "favorite", product_id: products[1]?.id },
			{ event_type: "cart", product_id: products[2]?.id },
			{ event_type: "view", product_id: products[0]?.id },
			{ event_type: "click", product_id: "does-not-exist" },
		] as const;
		for (const event of events) {
			await sendEvent({
				event_type: event.event_type,
				product_id: event.product_id as string,
				timestamp: new Date().toISOString(),
			});
		}
		// The live session did not replay anything.
		expect(replayedSignalCount()).toBe(0);

		// After a "reload", the badge restores the 3 explicit signals: the view
		// is ambient (never counted) and the unknown id was never logged.
		__setRuntimeForTests(freshDeps());
		await bootstrap();
		expect(replayedSignalCount()).toBe(3);
	});
});

describe("expired signed pointer — surfaced, never silently served", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		__setRuntimeForTests({
			spawnEngine: () => fakeEnginePort(),
			makeEmbedder: () => stubEmbedder,
		});
	});

	/** A fake sync Worker whose (offline, cached) sync is flagged expired. */
	function expiredEnginePort(): EnginePort {
		const inner = fakeEnginePort();
		return {
			sync: async (...args) => ({
				...(await inner.sync(...args)),
				expired: true as const,
			}),
			readFile: (path) => inner.readFile(path),
		};
	}

	it("warns with a coded breadcrumb when the synced bundle's pointer has expired", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		__setRuntimeForTests({
			spawnEngine: () => expiredEnginePort(),
			makeEmbedder: () => stubEmbedder,
		});
		const stages: string[] = [];
		await bootstrap((stage) => stages.push(stage.kind));

		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("[edge-reco:bundle.expired]"),
		);
		// The caller still sees every stage — the warning never swallows one.
		expect(stages).toContain("synced");
		expect(stages.at(-1)).toBe("ready");
	});

	it("stays quiet for a current bundle", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		__setRuntimeForTests({
			spawnEngine: () => fakeEnginePort(),
			makeEmbedder: () => stubEmbedder,
		});
		await bootstrap();
		expect(warn).not.toHaveBeenCalled();
	});
});

describe("clearCatalogCache — the explicit recovery", () => {
	afterEach(() => {
		__setRuntimeForTests({
			spawnEngine: () => fakeEnginePort(),
			makeEmbedder: () => stubEmbedder,
		});
	});

	it("clears through a dedicated sync worker, then lets bootstrap run again", async () => {
		const clear = vi.fn(() => Promise.resolve());
		const deleteFloorDatabase = vi.fn(() => Promise.resolve());
		__setRuntimeForTests({
			spawnEngine: () => ({ ...fakeEnginePort(), clear }),
			makeEmbedder: () => stubEmbedder,
			deleteFloorDatabase,
		});

		await clearCatalogCache();
		expect(clear).toHaveBeenCalledOnce();
		expect(deleteFloorDatabase).toHaveBeenCalledOnce();
		await expect(bootstrap()).resolves.toBeUndefined();
	});
});
