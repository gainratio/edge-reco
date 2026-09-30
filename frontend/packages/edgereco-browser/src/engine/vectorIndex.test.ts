import type { IndexManifest, Verify, VersionPointer } from "@edgeproc/browser";
import {
	MemoryCacheStore,
	materializeFile,
	syncIndex,
} from "@edgeproc/browser";
import { FlatVectorIndex } from "@edgeproc/browser/vector";
import { createSqliteVectorIndex } from "@edgeproc/browser/vector/sqlite";
import { describe, expect, it, vi } from "vitest";
import { catalogFetch, latestBytes } from "./fixtures";
import {
	loadVectorIndex,
	VectorIndexError,
	type VectorIndexFiles,
} from "./vectorIndex";

const acceptVerify: Verify = () => Promise.resolve();
const DECODER = new TextDecoder();

/** Sync the real bundle into memory and reassemble the four search inputs. */
async function syncedFiles(): Promise<VectorIndexFiles> {
	const store = new MemoryCacheStore();
	const { fetchBytes } = catalogFetch();
	const result = await syncIndex({
		baseUrl: "/cat",
		store,
		fetchBytes,
		verify: acceptVerify,
	});
	const pointer = JSON.parse(DECODER.decode(latestBytes())) as VersionPointer;
	const manifest = JSON.parse(
		DECODER.decode(await store.getManifest(result.manifestHash)),
	) as IndexManifest;
	void pointer;
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

function encoder(vectors: ReadonlyArray<ReadonlyArray<number>>): {
	readonly meta: Uint8Array;
	readonly state: Uint8Array;
	readonly embeddings: Uint8Array;
	readonly products: Uint8Array;
} {
	const dim = vectors[0]?.length ?? 0;
	const ids = vectors.map((_v, i) => `p${i}`);
	const flat = new Float32Array(vectors.flat());
	const products = ids
		.map((id) =>
			JSON.stringify({
				id,
				title: `title ${id}`,
				category: "c",
				brand: "b",
				tags: ["t"],
				popularity_score: 0.5,
				freshness_score: 0.3,
				price: 9.99,
			}),
		)
		.join("\n");
	const text = new TextEncoder();
	return {
		meta: text.encode(
			JSON.stringify({ embedding_count: vectors.length, embedding_dim: dim }),
		),
		state: text.encode(JSON.stringify({ faiss_ids: ids })),
		embeddings: new Uint8Array(flat.buffer),
		products: text.encode(products),
	};
}

describe("loadVectorIndex synthetic correctness", () => {
	it("atomically clears stale catalog rows before importing the signed matrix", async () => {
		const enc = encoder([[1, 0]]);
		const shared = new FlatVectorIndex({ name: "test", dimension: 2 });
		const clear = vi.spyOn(shared, "clear");
		const insert = vi.spyOn(shared, "insert");

		const index = await loadVectorIndex(enc, () => shared);

		expect(clear).toHaveBeenCalledOnce();
		expect(insert).toHaveBeenCalledOnce();
		expect(clear.mock.invocationCallOrder[0]).toBeLessThan(
			insert.mock.invocationCallOrder[0] ?? 0,
		);
		await index.dispose();
	});

	it("opens the shared SQLite-vector adapter in persistent OPFS mode", async () => {
		const createSqlite = vi.mocked(createSqliteVectorIndex);
		createSqlite.mockClear();
		const enc = encoder([[1, 0]]);
		const index = await loadVectorIndex(enc);
		expect(createSqlite).toHaveBeenCalledWith({
			name: "edgereco-catalog",
			dimension: 2,
			persistence: "opfs",
		});
		await index.dispose();
	});

	it("cosine top-k ordering is exact over a known matrix", async () => {
		// Three orthonormal-ish rows; a query closest to row 1, then 2, then 0.
		const enc = encoder([
			[1, 0, 0],
			[0, 1, 0],
			[0.6, 0.8, 0],
		]);
		const index = await loadVectorIndex({
			meta: enc.meta,
			state: enc.state,
			embeddings: enc.embeddings,
			products: enc.products,
		});
		// query points mostly along row 2's direction.
		const hits = await index.search(new Float32Array([0.6, 0.8, 0]), 3);
		expect(hits.map((h) => h.id)).toEqual(["p2", "p1", "p0"]);
		// row 2 is identical to the (normalized) query -> cosine == 1.
		expect(hits[0]?.score).toBeCloseTo(1, 5);
	});

	it("normalizes a non-unit query vector before scoring", async () => {
		const enc = encoder([
			[1, 0],
			[0, 1],
		]);
		const index = await loadVectorIndex({
			meta: enc.meta,
			state: enc.state,
			embeddings: enc.embeddings,
			products: enc.products,
		});
		// scaling the query must not change ordering or the cosine score.
		const small = await index.search(new Float32Array([3, 0]), 1);
		expect(small[0]?.id).toBe("p0");
		expect(small[0]?.score).toBeCloseTo(1, 5);
	});

	it("k larger than ntotal returns every row", async () => {
		const enc = encoder([
			[1, 0],
			[0, 1],
		]);
		const index = await loadVectorIndex({
			meta: enc.meta,
			state: enc.state,
			embeddings: enc.embeddings,
			products: enc.products,
		});
		expect(await index.search(new Float32Array([1, 0]), 99)).toHaveLength(2);
		expect(index.ntotal).toBe(2);
	});

	it("exposes the product map keyed by id", async () => {
		const enc = encoder([[1, 0]]);
		const index = await loadVectorIndex({
			meta: enc.meta,
			state: enc.state,
			embeddings: enc.embeddings,
			products: enc.products,
		});
		expect(index.product("p0")?.title).toBe("title p0");
		expect(index.product("missing")).toBeUndefined();
	});
});

describe("loadVectorIndex over the real synced bundle", () => {
	it("reports the real ntotal/dim and reads vectors row<->faiss_id aligned", async () => {
		const files = await syncedFiles();
		// Cross-check the loaded FAISS index against the bundle's own declaration
		// (catalog_meta.json) rather than hardcoding a count that drifts on rebuild.
		const meta = JSON.parse(DECODER.decode(files.meta)) as {
			readonly embedding_count: number;
			readonly embedding_dim: number;
		};
		const index = await loadVectorIndex(files);
		expect(index.ntotal).toBe(meta.embedding_count);
		expect(index.dim).toBe(meta.embedding_dim);
		// every stored row is L2-normalized -> a row queried against itself scores ~1.
		const selfId = index.idAt(0);
		const hits = await index.nearest(selfId, 1);
		expect(hits[0]?.id).not.toBe(selfId);
		expect(hits[0]?.score).toBeLessThanOrEqual(1);
	});
});

describe("VectorIndex.nearest (kNN-to-seed primitive)", () => {
	it("excludes the seed and returns descending cosine neighbors", async () => {
		// A query closest to row 1, then 2, then 0; nearest(seed=p1) drops p1 itself
		// and returns its neighbors p2 (cosine ~0.8) then p0 (cosine 0), descending.
		const enc = encoder([
			[1, 0, 0],
			[0, 1, 0],
			[0.6, 0.8, 0],
		]);
		const index = await loadVectorIndex({
			meta: enc.meta,
			state: enc.state,
			embeddings: enc.embeddings,
			products: enc.products,
		});
		const hits = await index.nearest("p1", 2);
		expect(hits.map((h) => h.id)).toEqual(["p2", "p0"]);
		expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? Number.NaN);
	});

	it("throws on an unknown seed id", async () => {
		const enc = encoder([[1, 0]]);
		const index = await loadVectorIndex({
			meta: enc.meta,
			state: enc.state,
			embeddings: enc.embeddings,
			products: enc.products,
		});
		await expect(index.nearest("missing", 5)).rejects.toThrow(
			/unknown product id/,
		);
	});

	it("over the real bundle: seed excluded, k results, strictly descending", async () => {
		const files = await syncedFiles();
		const index = await loadVectorIndex(files);
		const seed = "NB-00011";
		const hits = await index.nearest(seed, 10);
		expect(hits).toHaveLength(10);
		expect(hits.some((h) => h.id === seed)).toBe(false);
		for (let i = 1; i < hits.length; i += 1) {
			expect(hits[i - 1]?.score).toBeGreaterThanOrEqual(
				hits[i]?.score ?? Number.NaN,
			);
		}
		// cosine to a unit seed lives in [-1, 1].
		for (const hit of hits) {
			expect(hit.score).toBeLessThanOrEqual(1 + 1e-5);
			expect(hit.score).toBeGreaterThanOrEqual(-1 - 1e-5);
		}
	});
});

/**
 * A corrupt-but-signed catalog (products.jsonl / catalog_meta.json / state.json)
 * must fail CLOSED, not be blindly `JSON.parse(...) as T` cast into the index where
 * a non-string id or non-finite dim would silently corrupt retrieval. Mirrors the
 * fail-closed validation rankingConfig.ts / cooccurrence.ts already do: a missing
 * field, wrong type, or non-finite number must THROW (VectorIndexError).
 */
describe("loadVectorIndex fail-closed validation", () => {
	const text = new TextEncoder();

	/** A structurally valid set of files we mutate per-case to isolate one defect. */
	function validFiles(): VectorIndexFiles {
		const enc = encoder([
			[1, 0],
			[0, 1],
		]);
		return {
			meta: enc.meta,
			state: enc.state,
			embeddings: enc.embeddings,
			products: enc.products,
		};
	}

	function encode(value: unknown): Uint8Array {
		return text.encode(JSON.stringify(value));
	}

	it("the valid baseline still loads", async () => {
		await expect(loadVectorIndex(validFiles())).resolves.toBeDefined();
	});

	it("throws on non-JSON catalog_meta.json bytes", async () => {
		const files = { ...validFiles(), meta: text.encode("{not json") };
		await expect(loadVectorIndex(files)).rejects.toThrow();
	});

	it("throws when catalog_meta embedding_dim is not a finite number", async () => {
		const files = {
			...validFiles(),
			meta: encode({ embedding_count: 2, embedding_dim: null }),
		};
		await expect(loadVectorIndex(files)).rejects.toThrow(VectorIndexError);
	});

	it("throws when catalog_meta embedding_count is the wrong type", async () => {
		const files = {
			...validFiles(),
			meta: encode({ embedding_count: "2", embedding_dim: 2 }),
		};
		await expect(loadVectorIndex(files)).rejects.toThrow(/embedding_count/);
	});

	it("throws when state.json faiss_ids is not an array", async () => {
		const files = { ...validFiles(), state: encode({ faiss_ids: "p0,p1" }) };
		await expect(loadVectorIndex(files)).rejects.toThrow(/faiss_ids/);
	});

	it("throws when a faiss_id is not a string", async () => {
		const files = { ...validFiles(), state: encode({ faiss_ids: ["p0", 7] }) };
		await expect(loadVectorIndex(files)).rejects.toThrow(VectorIndexError);
	});

	it("throws when a products.jsonl line is not a JSON object", async () => {
		const files = { ...validFiles(), products: text.encode('"p0"\n"p1"') };
		await expect(loadVectorIndex(files)).rejects.toThrow(VectorIndexError);
	});

	it("throws when a product is missing its string id", async () => {
		const broken = [
			JSON.stringify({
				id: "p0",
				title: "ok",
				category: "c",
				brand: "b",
				tags: ["t"],
				popularity_score: 0.5,
				freshness_score: 0.5,
				price: 1,
			}),
			JSON.stringify({ title: "no id", category: "c" }),
		].join("\n");
		const files = { ...validFiles(), products: text.encode(broken) };
		await expect(loadVectorIndex(files)).rejects.toThrow(/id/);
	});

	it("throws when a product id is the wrong type", async () => {
		const broken = JSON.stringify({ id: 7, title: "bad id", category: "c" });
		const files = { ...validFiles(), products: text.encode(broken) };
		await expect(loadVectorIndex(files)).rejects.toThrow(VectorIndexError);
	});

	it("throws on a non-JSON products.jsonl line", async () => {
		const broken = [
			JSON.stringify({
				id: "p0",
				title: "ok",
				category: "c",
				brand: "b",
				tags: ["t"],
				popularity_score: 0.5,
				freshness_score: 0.5,
				price: 1,
			}),
			"{not json",
		].join("\n");
		const files = { ...validFiles(), products: text.encode(broken) };
		await expect(loadVectorIndex(files)).rejects.toThrow(VectorIndexError);
	});

	// A fully-valid product row we mutate per-case to isolate one ranking/display
	// field defect (mirrors the field-by-field guard in rankingConfig.ts).
	function product(
		overrides: Record<string, unknown>,
	): Record<string, unknown> {
		return {
			id: "p0",
			title: "ok",
			category: "c",
			brand: "b",
			tags: ["t"],
			popularity_score: 0.5,
			freshness_score: 0.5,
			price: 9.99,
			...overrides,
		};
	}

	function withProductRow(row: Record<string, unknown>): VectorIndexFiles {
		return { ...validFiles(), products: encode(row) };
	}

	it("throws when popularity_score is not a finite number", async () => {
		const files = withProductRow(product({ popularity_score: "high" }));
		await expect(loadVectorIndex(files)).rejects.toThrow(VectorIndexError);
	});

	it("throws when freshness_score is not a finite number", async () => {
		// freshness_score is a live ranking input (0.10*fresh in reranker.ts); a
		// corrupt-but-signed value would feed NaN straight into the rerank score.
		const files = withProductRow(product({ freshness_score: "warm" }));
		await expect(loadVectorIndex(files)).rejects.toThrow(VectorIndexError);
	});

	it("throws when a product is missing its freshness_score", async () => {
		const { freshness_score: _omit, ...noFreshness } = product({});
		const files = withProductRow(noFreshness);
		await expect(loadVectorIndex(files)).rejects.toThrow(/freshness_score/);
	});

	it("throws when a product is missing its title", async () => {
		const { title: _omit, ...noTitle } = product({});
		const files = withProductRow(noTitle);
		await expect(loadVectorIndex(files)).rejects.toThrow(/title/);
	});

	it("throws when category is the wrong type", async () => {
		const files = withProductRow(product({ category: 7 }));
		await expect(loadVectorIndex(files)).rejects.toThrow(VectorIndexError);
	});

	it("throws when tags is not an array", async () => {
		const files = withProductRow(product({ tags: "a,b" }));
		await expect(loadVectorIndex(files)).rejects.toThrow(/tags/);
	});

	it("throws when price is neither a finite number nor null", async () => {
		const files = withProductRow(product({ price: "free" }));
		await expect(loadVectorIndex(files)).rejects.toThrow(VectorIndexError);
	});

	it("accepts a null price (out-of-stock products carry no price)", async () => {
		const files = withProductRow(product({ price: null }));
		await expect(loadVectorIndex(files)).resolves.toBeDefined();
	});

	it("throws VectorIndexError when embedding_dim is zero", async () => {
		const files = {
			...validFiles(),
			meta: encode({ embedding_count: 2, embedding_dim: 0 }),
		};
		await expect(loadVectorIndex(files)).rejects.toThrow(VectorIndexError);
	});

	it("throws VectorIndexError when embedding_dim is fractional", async () => {
		const files = {
			...validFiles(),
			meta: encode({ embedding_count: 2, embedding_dim: 1.5 }),
		};
		await expect(loadVectorIndex(files)).rejects.toThrow(VectorIndexError);
	});

	it("throws VectorIndexError when embedding_count is fractional", async () => {
		const files = {
			...validFiles(),
			meta: encode({ embedding_count: 2.5, embedding_dim: 2 }),
		};
		await expect(loadVectorIndex(files)).rejects.toThrow(VectorIndexError);
	});

	it("routes an embeddings byte-length mismatch through VectorIndexError", async () => {
		// meta declares dim=2,count=2 -> 16 bytes expected; supply a short buffer.
		const files = { ...validFiles(), embeddings: new Uint8Array(8) };
		await expect(loadVectorIndex(files)).rejects.toThrow(VectorIndexError);
	});

	it("routes an embedding_count vs faiss_ids length mismatch through VectorIndexError", async () => {
		// state.json carries 2 faiss_ids; declare a meta count of 3 so the
		// malformed-bundle mismatch surfaces as the typed boundary error, not a
		// bare Error a caller catching VectorIndexError would miss.
		const files = {
			...validFiles(),
			meta: encode({ embedding_count: 3, embedding_dim: 2 }),
		};
		await expect(loadVectorIndex(files)).rejects.toThrow(VectorIndexError);
	});

	it("rejects non-finite vector values at the shared adapter boundary", async () => {
		const files = {
			...validFiles(),
			embeddings: new Uint8Array(
				new Float32Array([1, 0, Number.NaN, 1]).buffer,
			),
		};
		await expect(loadVectorIndex(files)).rejects.toThrow(VectorIndexError);
	});

	it("rejects duplicate producer ids at the shared adapter boundary", async () => {
		const files = {
			...validFiles(),
			state: encode({ faiss_ids: ["p0", "p0"] }),
		};
		await expect(loadVectorIndex(files)).rejects.toThrow(VectorIndexError);
	});
});
