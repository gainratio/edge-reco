// The on-device catalogue database: products, keyword search and vector search
// in ONE SQLite database, queried with SQL instead of hand-written search code.
//
//   products        one row per product, rowid = the bundle's row (state.json
//                   faiss_ids order), plus its float32 embedding as a BLOB.
//   products_fts    an FTS5 external-content index over products (title,
//                   category, tags, brand). Keyword ranking is FTS5's built-in
//                   bm25() with per-column weights. The unicode61 tokenizer
//                   folds case and diacritics and splits on punctuation, but
//                   keeps '-' and the apostrophe inside a token: a slug tag like
//                   "adults'-paint-by-number-kits" stays ONE token, as it was
//                   under the old whitespace split,
//                   so a natural-language query cannot hit the taxonomy through
//                   it (see __fixtures__/relevanceGoldenSet.ts).
//   vectors         sqlite-vector's vector_full_scan over products.embedding
//                   (exact cosine).
//   fusion          reciprocal-rank fusion of both lists, as one SQL CTE that
//                   also returns every input to the fused score (ranks and raw
//                   scores), so a ranking stays explainable.
//
// FTS5 fixes BM25's k1=1.2 and b=0.75 (https://sqlite.org/fts5.html); only the
// column weights are tunable. Ties break by bundle row, as before.
//
// This module only speaks SQL. The database itself (Worker, OPFS pool, owner
// lock, memory fallback) comes from @gainratio/browser through catalogueSql.ts.

import {
	type CatalogueSql,
	openCatalogueSql,
	retireLegacyVectorPool,
	type SqlBind,
	type SqlRow,
} from "./catalogueSql";
import { SqlTasteStore, type TasteStore } from "./tasteStore";

/** The product fields the keyword index reads. */
export interface CatalogueProduct {
	readonly id: string;
	readonly title: string;
	readonly category: string;
	readonly tags: ReadonlyArray<string>;
	readonly brand: string;
}

/** One verified catalogue revision, in bundle row order. */
export interface CatalogueImport {
	/** products[i] is bundle row i; its vector is vectors[i*dim .. (i+1)*dim). */
	readonly products: ReadonlyArray<CatalogueProduct>;
	readonly vectors: Float32Array;
}

/** A ranked id with its score (bm25 relevance, cosine, or fused RRF). */
export interface ScoredId {
	readonly id: string;
	readonly score: number;
}

/**
 * One fused hybrid result with every input to its score. `lexicalRank` and
 * `semanticRank` are 1-based; null means that retriever did not return it.
 */
export interface HybridRow {
	readonly id: string;
	readonly fused: number;
	readonly lexicalScore: number | null;
	readonly lexicalRank: number | null;
	readonly semanticScore: number | null;
	readonly semanticRank: number | null;
}

/** bm25() column weights, in products_fts column order. */
export interface LexicalWeights {
	readonly title: number;
	readonly category: number;
	readonly tags: number;
	readonly brand: number;
}

/** Equal weights: every indexed field counts the same, like the old single-bag BM25. */
export const DEFAULT_LEXICAL_WEIGHTS: LexicalWeights = Object.freeze({
	title: 1,
	category: 1,
	tags: 1,
	brand: 1,
});

/** The standard RRF constant (Cormack et al. 2009), unchanged from the JS port. */
export const RRF_K = 60;

const SCHEMA = `
	CREATE TABLE IF NOT EXISTS products(
		rowid INTEGER PRIMARY KEY,
		id TEXT NOT NULL UNIQUE,
		title TEXT NOT NULL,
		category TEXT NOT NULL,
		tags TEXT NOT NULL,
		brand TEXT NOT NULL,
		embedding BLOB NOT NULL
	);
	CREATE VIRTUAL TABLE IF NOT EXISTS products_fts USING fts5(
		title, category, tags, brand,
		content = 'products', content_rowid = 'rowid',
		tokenize = "unicode61 remove_diacritics 2 tokenchars '-'''"
	);
`;

const HYBRID_SQL = `
	WITH lexical AS (
		SELECT rowid, -bm25(products_fts, ?1, ?2, ?3, ?4) AS score
		FROM products_fts WHERE products_fts MATCH ?5
		ORDER BY bm25(products_fts, ?1, ?2, ?3, ?4), rowid LIMIT ?6
	),
	keyword AS (
		SELECT rowid, score, row_number() OVER (ORDER BY score DESC, rowid) AS rank
		FROM lexical
	),
	semantic AS (
		SELECT rowid, 1.0 - distance AS score,
			row_number() OVER (ORDER BY distance, rowid) AS rank
		FROM vector_full_scan('products', 'embedding', ?7)
		ORDER BY distance, rowid LIMIT ?6
	),
	fused AS (
		SELECT rowid, SUM(1.0 / (?8 + rank)) AS fused
		FROM (SELECT rowid, rank FROM keyword UNION ALL SELECT rowid, rank FROM semantic)
		GROUP BY rowid
	)
	SELECT p.id AS id, f.fused AS fused,
		k.score AS lexical_score, k.rank AS lexical_rank,
		s.score AS semantic_score, s.rank AS semantic_rank
	FROM fused AS f
	JOIN products AS p ON p.rowid = f.rowid
	LEFT JOIN keyword AS k ON k.rowid = f.rowid
	LEFT JOIN semantic AS s ON s.rowid = f.rowid
	ORDER BY f.fused DESC, k.rank IS NULL, k.rank, s.rank
`;

/** An empty phrase: valid FTS5 that matches no row (MATCH NULL is an error). */
const MATCH_NOTHING = '""';

const NEAREST_SQL = `
	SELECT p.id AS id, 1.0 - scan.distance AS score
	FROM vector_full_scan('products', 'embedding',
		(SELECT embedding FROM products WHERE id = ?1)) AS scan
	JOIN products AS p ON p.rowid = scan.rowid
	WHERE p.id <> ?1
	ORDER BY scan.distance, p.rowid LIMIT ?2
`;

const VECTOR_SQL = `
	SELECT p.id AS id, 1.0 - scan.distance AS score
	FROM vector_full_scan('products', 'embedding', ?1) AS scan
	JOIN products AS p ON p.rowid = scan.rowid
	ORDER BY scan.distance, p.rowid LIMIT ?2
`;

/**
 * Turn a user query into an FTS5 MATCH expression: every whitespace-separated
 * chunk becomes a quoted string, ORed together. Quoting neutralises FTS5 query
 * syntax (AND/NOT/NEAR, `*`, `^`, column filters); FTS5's own tokenizer still
 * splits and folds each chunk, so "Crème," matches "creme". OR keeps the old
 * any-term recall: a product matching one query word is a candidate.
 * Returns null when there is nothing to match.
 */
export function matchExpression(query: string): string | null {
	const chunks = query.split(/\s+/u).filter((chunk) => chunk.length > 0);
	if (chunks.length === 0) {
		return null;
	}
	return chunks.map((chunk) => `"${chunk.replaceAll('"', '""')}"`).join(" OR ");
}

function asNumberOrNull(value: unknown): number | null {
	return typeof value === "number" ? value : null;
}

/** NaN or ±Infinity would poison every cosine; refuse them at the boundary. */
function assertFinite(values: Float32Array, what: string): void {
	if (!values.every(Number.isFinite)) {
		throw new RangeError(`${what} must be finite`);
	}
}

function vectorBlob(vector: Float32Array): Uint8Array {
	return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
}

/** The async catalogue surface the search engine uses. */
export interface CatalogueStore {
	replace(revision: CatalogueImport): Promise<void>;
	hybrid(
		query: string,
		vector: Float32Array,
		k: number,
	): Promise<ReadonlyArray<HybridRow>>;
	vectorSearch(
		vector: Float32Array,
		k: number,
	): Promise<ReadonlyArray<ScoredId>>;
	nearest(id: string, k: number): Promise<ReadonlyArray<ScoredId>>;
	/** The shopper's taste log, in the same database (tasteStore.ts). */
	readonly taste: TasteStore;
	dispose(): Promise<void>;
}

export interface CatalogueStoreOptions {
	readonly dimension: number;
}

/** Opens a CatalogueStore at the bundle's embedding dimension. */
export type CatalogueStoreFactory = (
	options: CatalogueStoreOptions,
) => Promise<CatalogueStore>;

/**
 * Production factory: retire main's old OPFS vector pool, then open the
 * catalogue database through the @gainratio/browser SQL seam.
 */
export const openCatalogueStore: CatalogueStoreFactory = async ({
	dimension,
}) => {
	await retireLegacyVectorPool();
	return CatalogueDb.open(await openCatalogueSql(), dimension);
};

/** Catalogue search over one open SQLite database. */
export class CatalogueDb implements CatalogueStore {
	readonly #sql: CatalogueSql;
	readonly #dimension: number;
	readonly #weights: LexicalWeights;
	public readonly taste: TasteStore;

	private constructor(
		sql: CatalogueSql,
		dimension: number,
		weights: LexicalWeights,
		taste: TasteStore,
	) {
		this.#sql = sql;
		this.#dimension = dimension;
		this.#weights = weights;
		this.taste = taste;
	}

	/** Create the schema and register the vector column; closes `sql` on failure. */
	public static async open(
		sql: CatalogueSql,
		dimension: number,
		weights: LexicalWeights = DEFAULT_LEXICAL_WEIGHTS,
	): Promise<CatalogueDb> {
		try {
			if (!Number.isInteger(dimension) || dimension < 1) {
				throw new RangeError(`vector dimension must be a positive integer`);
			}
			await sql.exec(SCHEMA);
			await sql.query(
				"SELECT vector_init('products', 'embedding', ?) AS initialized",
				[`dimension=${dimension},type=FLOAT32,distance=COSINE`],
			);
			const taste = await SqlTasteStore.open(sql);
			return new CatalogueDb(sql, dimension, weights, taste);
		} catch (error) {
			await sql.close();
			throw error;
		}
	}

	/** Replace the whole catalogue with one verified revision, atomically. */
	public async replace(revision: CatalogueImport): Promise<void> {
		const { products, vectors } = revision;
		const dim = this.#dimension;
		if (vectors.length !== products.length * dim) {
			throw new RangeError(
				`expected ${products.length * dim} vector values, got ${vectors.length}`,
			);
		}
		assertFinite(vectors, "catalogue vectors");
		const rows = products.map((product, row) => [
			row,
			product.id,
			product.title,
			product.category,
			product.tags.join(" "),
			product.brand,
			vectorBlob(vectors.subarray(row * dim, (row + 1) * dim)),
		]);
		await this.#sql.transaction([
			{ sql: "DELETE FROM products" },
			{ sql: "INSERT INTO products VALUES (?, ?, ?, ?, ?, ?, ?)", rows },
			{ sql: "INSERT INTO products_fts(products_fts) VALUES ('rebuild')" },
		]);
	}

	/** Number of products in the database. */
	public async count(): Promise<number> {
		const [row] = await this.#sql.query("SELECT count(*) AS n FROM products");
		return Number(row?.n ?? 0);
	}

	/**
	 * Hybrid retrieval in one statement: FTS5 bm25 top-k and exact cosine top-k,
	 * fused by RRF. A query with no matchable text contributes no keyword list.
	 */
	public async hybrid(
		query: string,
		vector: Float32Array,
		k: number,
	): Promise<ReadonlyArray<HybridRow>> {
		this.#assertVector(vector);
		const w = this.#weights;
		const rows = await this.#sql.query(HYBRID_SQL, [
			w.title,
			w.category,
			w.tags,
			w.brand,
			matchExpression(query) ?? MATCH_NOTHING,
			Math.max(0, k),
			vectorBlob(vector),
			RRF_K,
		]);
		return rows.map((row) => ({
			id: String(row.id),
			fused: Number(row.fused),
			lexicalScore: asNumberOrNull(row.lexical_score),
			lexicalRank: asNumberOrNull(row.lexical_rank),
			semanticScore: asNumberOrNull(row.semantic_score),
			semanticRank: asNumberOrNull(row.semantic_rank),
		}));
	}

	/** Exact cosine top-k for a query vector, ties broken by bundle row. */
	public async vectorSearch(
		vector: Float32Array,
		k: number,
	): Promise<ReadonlyArray<ScoredId>> {
		this.#assertVector(vector);
		return this.#scored(VECTOR_SQL, [vectorBlob(vector), Math.max(0, k)]);
	}

	/** Top-k neighbours of a stored product, the product itself excluded. */
	public async nearest(
		id: string,
		k: number,
	): Promise<ReadonlyArray<ScoredId>> {
		const known = await this.#sql.query(
			"SELECT 1 AS known FROM products WHERE id = ?",
			[id],
		);
		if (known.length === 0) {
			throw new Error(`unknown product id: ${id}`);
		}
		return this.#scored(NEAREST_SQL, [id, Math.max(0, k)]);
	}

	public dispose(): Promise<void> {
		return this.#sql.close();
	}

	async #scored(sql: string, bind: SqlBind): Promise<ReadonlyArray<ScoredId>> {
		const rows: ReadonlyArray<SqlRow> = await this.#sql.query(sql, bind);
		return rows.map((row) => ({
			id: String(row.id),
			score: Number(row.score),
		}));
	}

	#assertVector(vector: Float32Array): void {
		if (vector.length !== this.#dimension) {
			throw new RangeError(
				`query vector has dimension ${vector.length}; expected ${this.#dimension}`,
			);
		}
		assertFinite(vector, "query vector");
	}
}
