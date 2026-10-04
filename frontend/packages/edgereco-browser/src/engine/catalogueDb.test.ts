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
} from "./catalogueDb";
import { openCatalogueSql } from "./catalogueSql";

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

	it("keeps the taste log in the same database, untouched by a catalogue replace", async () => {
		const store = await openCatalogueStore({ dimension: 2 });
		const event = { ts: "t", type: "click", productId: "a" } as const;
		await store.taste.append(event);
		await store.replace({ products: PRODUCTS, vectors: VECTORS });
		expect(await store.taste.list()).toEqual([event]);
		await store.dispose();
	});
});
