// @vitest-environment node
//
// The catalogue SQL, run on the real pinned SQLite build (FTS5 + sqlite-vector)
// in memory. These replace keyword.test.ts / rerank.test.ts, which pinned the old
// in-JS rank_bm25 port (k1=1.5, epsilon-floored IDF). The corpus is the same one,
// so the CONTRACT CHANGE is visible side by side: FTS5's bm25 has k1=1.2, b=0.75
// and floors a non-positive IDF to 1e-6 instead of epsilon * mean IDF.

import { beforeEach, describe, expect, it } from "vitest";
import {
	CatalogueDb,
	type CatalogueProduct,
	matchExpression,
	openCatalogueStore,
	RRF_K,
	SqlSwapTimeoutError,
} from "./catalogueDb";
import { openCatalogueSql } from "./catalogueSql";
import { DEFAULT_RANKING_CONFIG } from "./rankingConfig";
import { createSearchEngine } from "./searchEngine";
import { emptyProfile } from "./session";

/** A fresh catalogue database through the real seam (in-process Worker). */
async function fresh(
	weights?: Parameters<typeof CatalogueDb.open>[2],
): Promise<CatalogueDb> {
	return CatalogueDb.open(await openCatalogueSql(), 2, weights);
}

//   a: shirt polo red       c: shirt cotton men     e: shoes women
//   b: shirt golf blue      d: shirt running
const TITLES = [
	"shirt polo red",
	"shirt golf blue",
	"shirt cotton men",
	"shirt running",
	"shoes women",
];
const IDS = ["a", "b", "c", "d", "e"];

function product(id: string, title: string): CatalogueProduct {
	return { id, title, category: "", tags: [], brand: "" };
}

const PRODUCTS = IDS.map((id, i) => product(id, TITLES[i] ?? ""));
// Unit vectors on a circle: a=0°, b=90°, c=180°, d=270°, e=45°.
const VECTORS = new Float32Array([1, 0, 0, 1, -1, 0, 0, -1, 0.6, 0.8]);
const FAR = new Float32Array([-1, 0]); // nearest c, farthest a

async function openCatalogue(): Promise<CatalogueDb> {
	const db = await fresh();
	await db.replace({ products: PRODUCTS, vectors: VECTORS });
	return db;
}

async function lexical(db: CatalogueDb, query: string, k = 10) {
	return (await db.hybrid(query, FAR, k))
		.filter((row) => row.lexicalRank !== null)
		.sort((x, y) => (x.lexicalRank ?? 0) - (y.lexicalRank ?? 0));
}

describe("matchExpression", () => {
	it("quotes every chunk and ORs them", async () => {
		expect(matchExpression("  Polo   SHIRT ")).toBe('"Polo" OR "SHIRT"');
	});
	it("escapes quotes so FTS5 syntax cannot leak through", async () => {
		expect(matchExpression('say "hi')).toBe('"say" OR """hi"');
	});
	it("returns null for blank input", async () => {
		expect(matchExpression("   ")).toBeNull();
		expect(matchExpression("")).toBeNull();
	});
});

describe("FTS5 bm25 keyword ranking", () => {
	let db: CatalogueDb;
	beforeEach(async () => {
		db = await openCatalogue();
	});

	it("scores a rare term with FTS5's k1=1.2 (rank_bm25's k1=1.5 gave 1.0275)", async () => {
		const hits = await lexical(db, "polo");
		expect(hits.map((h) => h.id)).toEqual(["a"]);
		// ln(4.5/1.5) * 2.2 / (1 + 1.2 * (0.25 + 0.75 * 3 / 2.6))
		expect(hits[0]?.lexicalScore).toBeCloseTo(1.0335629, 6);
		expect(hits[0]?.lexicalScore).not.toBeCloseTo(1.0274791188982322, 3);
	});

	it("keeps a term in most documents as a weak, positive match", async () => {
		// IDF <= 0 is floored to 1e-6 (rank_bm25 used epsilon * mean IDF = 0.2).
		const hits = await lexical(db, "shirt");
		expect(hits.map((h) => h.id)).toEqual(["d", "a", "b", "c"]);
		for (const hit of hits) {
			expect(hit.lexicalScore).toBeGreaterThan(0);
			expect(hit.lexicalScore).toBeLessThan(1e-5);
		}
	});

	it("ORs query terms and sums their contributions", async () => {
		const hits = await lexical(db, "shirt polo");
		expect(hits.map((h) => h.id)).toEqual(["a", "d", "b", "c"]);
	});

	it("breaks score ties by bundle row", async () => {
		const hits = await lexical(db, "golf polo");
		expect(hits.map((h) => h.id)).toEqual(["a", "b"]);
		expect(hits[0]?.lexicalScore).toBeCloseTo(hits[1]?.lexicalScore ?? 0, 12);
	});

	it("returns no lexical rows for an unknown term or a blank query", async () => {
		expect(await lexical(db, "zzz")).toEqual([]);
		expect(await lexical(db, "   ")).toEqual([]);
	});

	it("honors the top-k cap", async () => {
		expect((await lexical(db, "shirt", 2)).map((h) => h.id)).toEqual([
			"d",
			"a",
		]);
	});

	it("treats FTS5 operators in user text as plain words", async () => {
		await expect(
			lexical(db, 'polo AND NOT title:shoes* "'),
		).resolves.toBeDefined();
		expect((await lexical(db, "NOT polo")).map((h) => h.id)).toEqual(["a"]);
	});

	it("folds case, punctuation and diacritics with unicode61", async () => {
		const folded = await fresh();
		await folded.replace({
			products: [product("x", "Crème T-Shirt"), product("y", "plain")],
			vectors: new Float32Array([1, 0, 0, 1]),
		});
		expect((await lexical(folded, "creme")).map((h) => h.id)).toEqual(["x"]);
		expect((await lexical(folded, "CRÈME,")).map((h) => h.id)).toEqual(["x"]);
		expect((await lexical(folded, "t-shirt")).map((h) => h.id)).toEqual(["x"]);
	});

	it("keeps a hyphenated slug as one token, so its parts do not match", async () => {
		const slugged = await fresh();
		await slugged.replace({
			products: [
				{ id: "h", title: "", category: "", tags: ["garden-hoses"], brand: "" },
				{ id: "y", title: "plain", category: "", tags: [], brand: "" },
			],
			vectors: new Float32Array([1, 0, 0, 1]),
		});
		expect(await lexical(slugged, "garden")).toEqual([]);
		expect((await lexical(slugged, "garden-hoses")).map((h) => h.id)).toEqual([
			"h",
		]);
	});

	it("indexes category, tags and brand, weighted per column", async () => {
		const rows: CatalogueProduct[] = [
			{ id: "t", title: "acme", category: "", tags: [], brand: "" },
			{ id: "b", title: "", category: "", tags: [], brand: "acme" },
			{ id: "g", title: "", category: "", tags: ["green tea"], brand: "" },
		];
		const vectors = new Float32Array([1, 0, 0, 1, 1, 1]);
		const even = await fresh();
		await even.replace({ products: rows, vectors });
		expect((await lexical(even, "acme")).map((h) => h.id)).toEqual(["t", "b"]);
		expect((await lexical(even, "tea")).map((h) => h.id)).toEqual(["g"]);
		const brandFirst = await fresh({
			title: 1,
			category: 1,
			tags: 1,
			brand: 5,
		});
		await brandFirst.replace({ products: rows, vectors });
		expect((await lexical(brandFirst, "acme")).map((h) => h.id)).toEqual([
			"b",
			"t",
		]);
	});
});

describe("hybrid fusion (RRF in SQL)", () => {
	let db: CatalogueDb;
	beforeEach(async () => {
		db = await openCatalogue();
	});

	it("uses the standard RRF constant k = 60", () => {
		expect(RRF_K).toBe(60);
	});

	it("sums 1/(60 + rank) over both lists and explains every input", async () => {
		const rows = await db.hybrid("polo", FAR, 2);
		// keyword: [a]; semantic top-2 from 180°: [c, b] (b and d tie; row order).
		const a = rows.find((row) => row.id === "a");
		expect(a).toMatchObject({ lexicalRank: 1, semanticRank: null });
		// Pin the literal k=60 the docs promise: 1/61, not 1/(RRF_K + 1), which
		// would pass at any k.
		expect(a?.fused).toBeCloseTo(1 / 61, 12);
		const c = rows.find((row) => row.id === "c");
		expect(c).toMatchObject({ lexicalRank: null, semanticRank: 1 });
		expect(c?.semanticScore).toBeCloseTo(1, 6);
	});

	it("ranks a document found by both retrievers above single-list hits", async () => {
		const towardC = new Float32Array([-1, 0.01]);
		const rows = await db.hybrid("cotton", towardC, 3);
		expect(rows[0]?.id).toBe("c");
		expect(rows[0]?.fused).toBeCloseTo(2 / 61, 12);
	});

	it("puts the keyword list first when fused scores tie", async () => {
		// keyword [a], semantic [c]: both 1/61; keyword wins the tie.
		const rows = await db.hybrid("polo", FAR, 1);
		expect(rows.map((row) => row.id)).toEqual(["a", "c"]);
	});

	it("returns only semantic rows for a blank query and nothing at k=0", async () => {
		const rows = await db.hybrid("", FAR, 2);
		expect(rows.every((row) => row.lexicalRank === null)).toBe(true);
		expect(rows).toHaveLength(2);
		expect(await db.hybrid("polo", FAR, 0)).toEqual([]);
	});

	it("rejects a non-finite query vector", async () => {
		await expect(
			db.hybrid("polo", new Float32Array([Number.NaN, 0]), 2),
		).rejects.toThrow(/query vector must be finite/);
	});

	it("rejects a query vector of the wrong dimension", async () => {
		await expect(db.hybrid("polo", new Float32Array(3), 2)).rejects.toThrow(
			/dimension 3; expected 2/,
		);
	});
});

describe("vector search", () => {
	let db: CatalogueDb;
	beforeEach(async () => {
		db = await openCatalogue();
	});

	it("returns cosine similarity, nearest first, ties by bundle row", async () => {
		const hits = await db.vectorSearch(FAR, 3);
		expect(hits.map((h) => h.id)).toEqual(["c", "b", "d"]);
		expect(hits[0]?.score).toBeCloseTo(1, 6);
		expect(hits[1]?.score).toBeCloseTo(0, 6);
	});

	it("finds a stored product's neighbours without the product itself", async () => {
		const hits = await db.nearest("a", 2);
		expect(hits.map((h) => h.id)).toEqual(["e", "b"]);
		expect(hits[0]?.score).toBeCloseTo(0.6, 6);
	});

	it("refuses an unknown seed", async () => {
		await expect(db.nearest("nope", 2)).rejects.toThrow(
			/unknown product id: nope/,
		);
	});

	it("rejects a wrong-dimension query", async () => {
		await expect(db.vectorSearch(new Float32Array(1), 2)).rejects.toThrow(
			/dimension 1/,
		);
	});
});

describe("catalogue revisions", () => {
	it("replaces the previous revision, keyword index included", async () => {
		const db = await openCatalogue();
		await db.replace({
			products: [product("z", "kayak")],
			vectors: new Float32Array([1, 0]),
		});
		expect(await db.count()).toBe(1);
		expect((await lexical(db, "kayak")).map((h) => h.id)).toEqual(["z"]);
		expect(await lexical(db, "polo")).toEqual([]);
	});

	it("rejects a vector block that does not match the product count", async () => {
		const db = await openCatalogue();
		await expect(
			db.replace({ products: PRODUCTS, vectors: new Float32Array(3) }),
		).rejects.toThrow(/expected 10 vector values, got 3/);
		expect(await db.count()).toBe(5);
	});

	it("rejects non-finite vectors before touching the old revision", async () => {
		const db = await openCatalogue();
		const bad = new Float32Array(VECTORS);
		bad[3] = Number.POSITIVE_INFINITY;
		await expect(
			db.replace({ products: PRODUCTS, vectors: bad }),
		).rejects.toThrow(/catalogue vectors must be finite/);
		expect(await db.count()).toBe(5);
	});

	it("rolls back a failed import, leaving the old revision searchable", async () => {
		const db = await openCatalogue();
		const duplicate = [product("a", "one"), product("a", "two")];
		await expect(
			db.replace({ products: duplicate, vectors: new Float32Array(4) }),
		).rejects.toThrow(/UNIQUE/);
		expect(await db.count()).toBe(5);
		expect((await lexical(db, "polo")).map((h) => h.id)).toEqual(["a"]);
	});

	it("refuses a non-positive dimension and closes the database", async () => {
		const sql = await openCatalogueSql();
		await expect(CatalogueDb.open(sql, 0)).rejects.toThrow(/positive integer/);
		await expect(sql.query("SELECT 1")).rejects.toThrow();
	});
});

describe("openCatalogueStore", () => {
	it("opens a working store at the requested dimension", async () => {
		const store = await openCatalogueStore({ dimension: 2 });
		await store.replace({ products: PRODUCTS, vectors: VECTORS });
		expect((await store.vectorSearch(FAR, 1)).map((h) => h.id)).toEqual(["c"]);
		await store.dispose();
	});

	it("executes browseSql() with category filter, pagination, and full Product hydration", async () => {
		const db = await fresh();
		await db.replace({
			products: [
				{
					id: "p1",
					title: "Alpha Jacket",
					description: "Warm coat",
					category: "apparel",
					tags: ["winter", "warm"],
					brand: "Arc",
					price: 199.5,
					popularity_score: 0.9,
					freshness_score: 0.8,
					image_url: "https://example.com/a.jpg",
				},
				{
					id: "p2",
					title: "Beta Tent",
					description: "2-person tent",
					category: "camping",
					tags: ["outdoor"],
					brand: "Peak",
					price: 299,
					popularity_score: 0.7,
					freshness_score: 0.6,
					image_url: "https://example.com/b.jpg",
				},
			],
			vectors: new Float32Array([1, 0, 0, 1]),
		});
		const all = await db.browseSql({ limit: 1, offset: 0 });
		expect(all.total).toBe(2);
		expect(all.categories).toEqual(["apparel", "camping"]);
		expect(all.products).toEqual([
			{
				id: "p1",
				title: "Alpha Jacket",
				description: "Warm coat",
				category: "apparel",
				subcategories: [],
				tags: ["winter", "warm"],
				brand: "Arc",
				price: 199.5,
				currency: "USD",
				popularity_score: 0.9,
				freshness_score: 0.8,
				image_url: "https://example.com/a.jpg",
				url: "",
				attributes: {},
			},
		]);
		const filtered = await db.browseSql({ category: "camping" });
		expect(filtered.total).toBe(1);
		expect(filtered.products.map((p) => p.id)).toEqual(["p2"]);
		await db.dispose();
	});

	it("gates concurrent queries during replace() and throws SqlSwapTimeoutError when swapTimeoutMs is exceeded", async () => {
		const sql = await openCatalogueSql();
		const origTx = sql.transaction.bind(sql);
		let delayMs = 0;
		sql.transaction = (async (input: Parameters<typeof origTx>[0]) => {
			if (delayMs > 0) {
				await new Promise((resolve) => setTimeout(resolve, delayMs));
			}
			return origTx(input as never);
		}) as typeof sql.transaction;

		const db = await CatalogueDb.open(sql, 2);
		await db.replace({ products: PRODUCTS, vectors: VECTORS });

		delayMs = 60;
		const slowSwap = db.replace(
			{
				products: [product("z", "kayak")],
				vectors: new Float32Array([1, 0]),
			},
			{ swapTimeoutMs: 10 },
		);
		const concurrent = db.count();
		await expect(concurrent).rejects.toBeInstanceOf(SqlSwapTimeoutError);
		await expect(concurrent).rejects.toMatchObject({
			code: "sql.swap_timeout",
			timeoutMs: 10,
		});
		await slowSwap;
		expect(await db.count()).toBe(1);
		await db.dispose();
	});

	it("imports a canonical pre-built SQLite database via importSqlite() with FTS5 and sqlite-vector ready", async () => {
		const sourceSql = await openCatalogueSql();
		const sourceDb = await CatalogueDb.open(sourceSql, 2);
		await sourceDb.replace({ products: PRODUCTS, vectors: VECTORS });
		if (sourceSql.exportDatabase === undefined) {
			throw new Error("expected exportDatabase on CatalogueSql");
		}
		const sqliteBytes = await sourceSql.exportDatabase();
		await sourceDb.dispose();

		const targetDb = await fresh();
		await targetDb.importSqlite(sqliteBytes);
		expect(await targetDb.count()).toBe(5);
		expect((await lexical(targetDb, "polo")).map((h) => h.id)).toEqual(["a"]);
		expect((await targetDb.vectorSearch(FAR, 3)).map((h) => h.id)).toEqual([
			"c",
			"b",
			"d",
		]);
		await expect(
			targetDb.importSqlite(new Uint8Array([1, 2, 3])),
		).rejects.toThrow(/not a SQLite database/);
		expect(await targetDb.count()).toBe(5);
		await targetDb.dispose();
	});

	it("supports INT8 embeddings in importSqlite(), productsByIds(), and candidatePoolSql()", async () => {
		const sourceSql = await openCatalogueSql();
		const sourceDb = await CatalogueDb.open(sourceSql, 4);
		await sourceDb.replace({
			products: [
				{
					id: "p1",
					title: "Alpha Jacket",
					category: "apparel",
					tags: ["winter"],
					brand: "Arc",
					price: 199,
					popularity_score: 0.9,
					freshness_score: 0.2,
				},
				{
					id: "p2",
					title: "Beta Boots",
					category: "footwear",
					tags: ["hiking"],
					brand: "Peak",
					price: 149,
					popularity_score: 0.4,
					freshness_score: 0.95,
				},
			],
			vectors: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0]),
		});
		// Convert stored embeddings in sourceSql to 4-byte INT8 blobs before exporting.
		await sourceSql.exec("UPDATE products SET embedding = ? WHERE id = 'p1'", [
			new Uint8Array(new Int8Array([127, 0, 0, 0]).buffer),
		]);
		await sourceSql.exec("UPDATE products SET embedding = ? WHERE id = 'p2'", [
			new Uint8Array(new Int8Array([0, 127, 0, 0]).buffer),
		]);
		if (sourceSql.exportDatabase === undefined) {
			throw new Error("expected exportDatabase on CatalogueSql");
		}
		const sqliteBytes = await sourceSql.exportDatabase();
		await sourceDb.dispose();

		const targetSql = await openCatalogueSql();
		const targetDb = await CatalogueDb.open(targetSql, 4);
		await targetDb.importSqlite(sqliteBytes);

		const hits = await targetDb.vectorSearch(new Float32Array([1, 0, 0, 0]), 2);
		expect(hits.map((h) => h.id)).toEqual(["p1", "p2"]);
		expect(hits[0]?.score).toBeCloseTo(1, 2);

		const byIds = await targetDb.productsByIds(["p2", "missing", "p1"]);
		expect([...byIds.keys()].sort()).toEqual(["p1", "p2"]);
		expect(byIds.get("p2")?.brand).toBe("Peak");

		const emptyIds = await targetDb.productsByIds([]);
		expect(emptyIds.size).toBe(0);

		const defaultWeights = DEFAULT_RANKING_CONFIG.scoring_weights;

		const popPool = await targetDb.candidatePoolSql(
			"popularity",
			1,
			emptyProfile(),
			defaultWeights,
		);
		expect(popPool[0]?.product.id).toBe("p1");

		const freshPool = await targetDb.candidatePoolSql(
			"freshness",
			1,
			emptyProfile(),
			defaultWeights,
		);
		expect(freshPool[0]?.product.id).toBe("p2");

		const coldAffinityPool = await targetDb.candidatePoolSql(
			"affinity_first",
			2,
			emptyProfile(),
			defaultWeights,
		);
		expect(coldAffinityPool.map((r) => r.product.id)).toEqual(["p1", "p2"]);

		const affinityPool = await targetDb.candidatePoolSql(
			"affinity_first",
			5,
			{
				...emptyProfile(),
				categoryAffinity: new Map([["footwear", 1.0]]),
				tagAffinity: new Map([["hiking", 1.0]]),
				brandAffinity: new Map([["Peak", 1.0]]),
			},
			defaultWeights,
		);
		expect(affinityPool.map((r) => r.product.id)).toEqual(["p2", "p1"]);
		expect(await targetDb.activateRevision("", 2)).toBe(false);
		expect(await targetDb.activateRevision("rev-1", 2)).toBe(false);
		await targetDb.importSqlite(sqliteBytes, { revisionKey: "rev-1" });
		expect(await targetDb.activateRevision("rev-1", 2)).toBe(true);
		expect(await targetDb.activateRevision("rev-2", 2)).toBe(false);
		expect(await targetDb.activateRevision("rev-1", 99)).toBe(false);
		await targetDb.dispose();

		const metaBytes = new TextEncoder().encode(
			JSON.stringify({
				catalog_id: "test-cat",
				version: "v1",
				embedding_model: "test-model",
				embedding_dim: 4,
				embedding_count: 2,
				product_count: 2,
			}),
		);
		const engine = await createSearchEngine(
			{
				meta: metaBytes,
				state: new Uint8Array(0),
				embeddings: new Uint8Array(0),
				products: new Uint8Array(0),
				sqlite: sqliteBytes,
			},
			{
				embed: async () => new Float32Array([1, 0, 0, 0]),
			},
			DEFAULT_RANKING_CONFIG,
			{ schema_version: 1, neighbors: { p1: [{ id: "p2", score: 0.8 }] } },
		);
		expect(engine.ntotal).toBe(2);
		expect(engine.catalog()).toEqual([]);
		expect((await engine.productById?.("p1"))?.title).toBe("Alpha Jacket");
		expect(await engine.productById?.("missing")).toBeUndefined();
		expect((await engine.productsByIds?.(["p2"]))?.get("p2")?.title).toBe(
			"Beta Boots",
		);
		const searchRes = await engine.search("Alpha Jacket");
		expect(searchRes.results[0]?.product.id).toBe("p1");
		const forYouRes = await engine.recommend({ strategy: "for_you", limit: 2 });
		expect(forYouRes.results.length).toBe(2);
		const trendingRes = await engine.recommend({
			strategy: "trending",
			limit: 1,
		});
		expect(trendingRes.results[0]?.product.id).toBe("p1");
		const newRes = await engine.recommend({
			strategy: "new_arrivals",
			limit: 1,
		});
		expect(newRes.results[0]?.product.id).toBe("p2");
		const simRes = await engine.similar("p1", { limit: 1 });
		expect(simRes.results[0]?.product.id).toBe("p2");
		const coocRes = await engine.recommend({
			strategy: "also_bought",
			seed: "p1",
			limit: 1,
		});
		expect(coocRes.results[0]?.product.id).toBe("p2");
		const browseAll = await engine.browseSql?.({ limit: 1, offset: 0 });
		expect(browseAll?.total).toBe(2);
		expect(browseAll?.categories).toEqual(["apparel", "footwear"]);
		const browseCat = await engine.browseSql?.({ category: "footwear" });
		expect(browseCat?.total).toBe(1);
		await engine.reload?.({
			meta: metaBytes,
			state: new Uint8Array(0),
			embeddings: new Uint8Array(0),
			products: new Uint8Array(0),
			sqlite: sqliteBytes,
		});
		await engine.dispose();
	});
});
