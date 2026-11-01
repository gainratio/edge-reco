// The in-browser catalogue index over the synced bundle. Row i of
// embeddings.f32 is the L2-normalized vector for state.json faiss_ids[i]
// (Python's VectorSearcher, src/edgereco/search/vector.py). The verified
// products and vectors are imported into ONE SQLite database, which
// @gainratio/browser runs in its own Worker (catalogueDb.ts, catalogueSql.ts): keyword search is FTS5, similarity is sqlite-vector, and
// hybrid fusion is a SQL query. Every query crosses that Worker boundary and stays
// off the UI thread.

import {
	type CatalogueBrowseOptions,
	type CatalogueProduct,
	type CatalogueStore,
	type CatalogueStoreFactory,
	type CatalogueSwapOptions,
	type HybridRow,
	openCatalogueStore,
} from "./catalogueDb";
import type { BrowseResponse, Product, SearchResult } from "./domain";
import type { ScoringWeights } from "./rankingConfig";
import type { SessionProfile } from "./session";

const DECODER = new TextDecoder();

/** The reassembled bundle files the index is built from. */
export interface VectorIndexFiles {
	/** catalog_meta.json — carries embedding_count / embedding_dim. */
	readonly meta: Uint8Array;
	/** vector/state.json — carries the faiss_ids row->id map (empty in SQLite-only bundles). */
	readonly state: Uint8Array;
	/** vector/embeddings.f32 — row-major L2-normalized float32, ntotal x dim (empty in SQLite-only bundles). */
	readonly embeddings: Uint8Array;
	/** products.jsonl — one Product JSON object per line (empty in SQLite-only bundles). */
	readonly products: Uint8Array;
	/** catalogue.sqlite — canonical pre-built SQLite database. */
	readonly sqlite?: Uint8Array;
	/** Demand-driven async stream of verified `catalogue.sqlite` chunks. */
	readonly sqliteChunks?: () => AsyncIterable<Uint8Array>;
	/** Optional bundle revision key (`manifestHash` or `catalog_id:version:count`). */
	readonly revisionKey?: string;
	/** True when the pre-opened CatalogueStore already activated `revisionKey` on OPFS. */
	readonly sqliteAlreadyActive?: boolean;
}

/** A scored retrieval hit: a product id and its cosine similarity to the query. */
export interface VectorHit {
	readonly id: string;
	readonly score: number;
}

interface CatalogMeta {
	readonly catalog_id?: string;
	readonly version?: string;
	readonly embedding_count: number;
	readonly embedding_dim: number;
}

interface VectorState {
	readonly faiss_ids: ReadonlyArray<string>;
}

/**
 * Thrown when present-but-malformed catalog bundle data (catalog_meta.json,
 * vector/state.json, or products.jsonl) fails validation. The browser tier fails
 * CLOSED here — like rankingConfig.ts / cooccurrence.ts — so a corrupt-but-signed
 * bundle surfaces loudly instead of being blindly `as T` cast into the index,
 * where a non-string id or non-finite dim would silently corrupt retrieval and
 * diverge from the Python tier.
 */
export class VectorIndexError extends Error {
	public constructor(message: string) {
		super(`malformed catalog bundle: ${message}`);
		this.name = "VectorIndexError";
	}
}

/**
 * Thrown when the on-device vector store itself cannot be opened (OPFS
 * unavailable, storage broken). This is a LOCAL storage failure, not a verdict on
 * the catalog: the bundle was already signature-checked, so it must never read
 * as "malformed" or tampered. The underlying error is kept as `cause`.
 */
export class VectorStoreUnavailableError extends Error {
	public constructor(cause: unknown) {
		const detail = cause instanceof Error ? cause.message : String(cause);
		super(`could not open the on-device search index: ${detail}`, { cause });
		this.name = "VectorStoreUnavailableError";
	}
}

async function openCatalogue(
	factory: CatalogueStoreFactory,
	dimension: number,
): Promise<CatalogueStore> {
	try {
		return await factory({ dimension });
	} catch (error) {
		throw new VectorStoreUnavailableError(error);
	}
}

function asRecord(value: unknown, at: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new VectorIndexError(`${at} must be an object`);
	}
	return value as Record<string, unknown>;
}

/** A finite number — rejects strings, null, NaN and ±Infinity. */
function assertFiniteNumber(value: unknown, at: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new VectorIndexError(`${at} must be a finite number`);
	}
	return value;
}

/** A whole count ≥ 1 — rejects 0, negatives, fractions and non-numbers. */
function assertPositiveInt(value: unknown, at: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
		throw new VectorIndexError(`${at} must be an integer >= 1`);
	}
	return value;
}

/** A finite number OR null (price is optional per Product) — rejects all else. */
function assertFiniteOrNull(value: unknown, at: string): void {
	if (value === null) {
		return;
	}
	assertFiniteNumber(value, at);
}

function assertStringField(
	record: Record<string, unknown>,
	field: string,
	at: string,
): void {
	if (typeof record[field] !== "string") {
		throw new VectorIndexError(`${at}.${field} must be a string`);
	}
}

function parseJsonBytes(bytes: Uint8Array, at: string): unknown {
	try {
		return JSON.parse(DECODER.decode(bytes));
	} catch {
		throw new VectorIndexError(`${at} is not valid JSON`);
	}
}

/** Validate catalog_meta.json into a typed CatalogMeta, or fail closed. */
function parseCatalogMeta(bytes: Uint8Array): CatalogMeta {
	const record = asRecord(
		parseJsonBytes(bytes, "catalog_meta.json"),
		"catalog_meta.json",
	);
	assertPositiveInt(
		record.embedding_count,
		"catalog_meta.json.embedding_count",
	);
	assertPositiveInt(record.embedding_dim, "catalog_meta.json.embedding_dim");
	return record as unknown as CatalogMeta;
}

/** Validate vector/state.json into a typed VectorState, or fail closed. */
function parseVectorState(bytes: Uint8Array): VectorState {
	const record = asRecord(
		parseJsonBytes(bytes, "vector/state.json"),
		"vector/state.json",
	);
	const ids = record.faiss_ids;
	if (!Array.isArray(ids)) {
		throw new VectorIndexError("vector/state.json.faiss_ids must be an array");
	}
	const seen = new Set<string>();
	ids.forEach((id, i) => {
		if (typeof id !== "string") {
			throw new VectorIndexError(
				`vector/state.json.faiss_ids[${i}] must be a string`,
			);
		}
		if (seen.has(id)) {
			throw new VectorIndexError(
				`vector/state.json.faiss_ids contains duplicate id ${JSON.stringify(id)}`,
			);
		}
		seen.add(id);
	});
	return record as unknown as VectorState;
}

/** Wrap embeddings.f32 as a typed view, asserting the byte length matches n*dim. */
function asMatrix(
	embeddings: Uint8Array,
	ntotal: number,
	dim: number,
): Float32Array {
	const expected = ntotal * dim * Float32Array.BYTES_PER_ELEMENT;
	if (embeddings.byteLength !== expected) {
		throw new VectorIndexError(
			`embeddings.f32 is ${embeddings.byteLength} bytes; expected ${expected} (${ntotal}x${dim})`,
		);
	}
	// The reassembled bytes may not be 4-byte aligned; copy into a fresh buffer.
	const aligned = embeddings.slice();
	return new Float32Array(aligned.buffer, aligned.byteOffset, ntotal * dim);
}

/** The display/ranking-critical Product string fields validated before the cast. */
const PRODUCT_STRING_FIELDS = ["title", "category", "brand"] as const;

/**
 * Field-by-field guard for one product row (mirrors rankingConfig.ts's style):
 * the ranking/display-critical fields must be well-typed so a corrupt-but-signed
 * product can't silently feed NaN into the scorer or blank text into the rail.
 * `id` is validated by the caller (so it can narrow the map key).
 */
function assertProductFields(
	record: Record<string, unknown>,
	at: string,
): void {
	for (const field of PRODUCT_STRING_FIELDS) {
		assertStringField(record, field, at);
	}
	if (!Array.isArray(record.tags)) {
		throw new VectorIndexError(`${at}.tags must be an array`);
	}
	assertFiniteNumber(record.popularity_score, `${at}.popularity_score`);
	assertFiniteNumber(record.freshness_score, `${at}.freshness_score`);
	assertFiniteOrNull(record.price, `${at}.price`);
}

function parseProducts(bytes: Uint8Array): ReadonlyMap<string, Product> {
	const map = new Map<string, Product>();
	const lines = DECODER.decode(bytes).split("\n");
	lines.forEach((line, i) => {
		if (line.trim().length === 0) {
			return;
		}
		const at = `products.jsonl[${i}]`;
		const record = asRecord(
			parseJsonBytes(new TextEncoder().encode(line), at),
			at,
		);
		if (typeof record.id !== "string") {
			throw new VectorIndexError(`${at}.id must be a string`);
		}
		assertProductFields(record, at);
		map.set(record.id, record as unknown as Product);
	});
	return map;
}

/** Loaded, query-ready catalogue index over the synced bundle. */
export class VectorIndex {
	readonly #store: CatalogueStore;
	#ids: ReadonlyArray<string>;
	#known: ReadonlySet<string>;
	#products: ReadonlyMap<string, Product>;
	#ntotal: number;
	readonly #dim: number;

	public constructor(
		store: CatalogueStore,
		ids: ReadonlyArray<string>,
		products: ReadonlyMap<string, Product>,
		dim: number,
		ntotal?: number,
	) {
		this.#store = store;
		this.#ids = ids;
		this.#known = new Set(ids);
		this.#products = products;
		this.#ntotal = ntotal ?? ids.length;
		this.#dim = dim;
	}

	public get ntotal(): number {
		return this.#ntotal;
	}

	public get dim(): number {
		return this.#dim;
	}

	public idAt(row: number): string {
		const id = this.#ids[row];
		if (id === undefined) {
			throw new RangeError(`row ${row} out of range`);
		}
		return id;
	}

	public product(id: string): Product | undefined {
		return this.#products.get(id);
	}

	/** Hydrate products by ID from the in-memory map or the SQLite `products` table. */
	public async productsByIds(
		ids: ReadonlyArray<string>,
	): Promise<ReadonlyMap<string, Product>> {
		if (this.#products.size > 0) {
			const out = new Map<string, Product>();
			for (const id of ids) {
				const product = this.#products.get(id);
				if (product !== undefined) {
					out.set(id, product);
				}
			}
			return out;
		}
		if (this.#store.productsByIds !== undefined) {
			return this.#store.productsByIds(ids);
		}
		return new Map();
	}

	/** SQL-backed candidate pool selection when the catalog lives in SQLite. */
	public candidatePoolSql(
		policy: "popularity" | "freshness" | "affinity_first",
		limit: number,
		profile: SessionProfile,
		weights: ScoringWeights,
	): Promise<SearchResult[]> | null {
		return this.#store.candidatePoolSql !== undefined
			? this.#store.candidatePoolSql(policy, limit, profile, weights)
			: null;
	}

	/** All products, in faiss_ids row order (the catalog order from the bundle). */
	public products(): ReadonlyArray<Product> {
		const out: Product[] = [];
		for (const id of this.#ids) {
			const product = this.#products.get(id);
			if (product !== undefined) {
				out.push(product);
			}
		}
		return out;
	}

	/**
	 * Hot-swap the live catalogue index in place over the same SQLite Worker
	 * connection, gated by `swapTimeoutMs` (default 150 ms). If validation or
	 * the SQLite transaction fails, the live index remains untouched.
	 */
	public async reload(
		files: VectorIndexFiles,
		options?: CatalogueSwapOptions,
	): Promise<void> {
		const parsed = parseBundleRevision(files, this.#dim);
		await applyBundleToStore(this.#store, files, parsed, options);
		this.#ids = parsed.ids;
		this.#known = new Set(parsed.ids);
		this.#products = parsed.products;
		this.#ntotal = parsed.ntotal;
	}

	/**
	 * SQL-backed browse query over the SQLite `products` table when supported by
	 * the underlying `CatalogueStore`.
	 */
	public browseSql(
		options?: CatalogueBrowseOptions,
	): Promise<BrowseResponse> | null {
		return this.#store.browseSql !== undefined
			? this.#store.browseSql(options)
			: null;
	}

	/**
	 * Exact cosine top-k through sqlite-vector, nearest first. Exact-distance ties
	 * keep the authenticated state.json row order, like Python FAISS.
	 */
	public search(
		queryVec: Float32Array,
		k: number,
	): Promise<ReadonlyArray<VectorHit>> {
		return k <= 0 ? Promise.resolve([]) : this.#store.vectorSearch(queryVec, k);
	}

	/**
	 * FTS5 bm25 top-k and cosine top-k fused by RRF, in one SQL query. Each row
	 * carries both ranks and raw scores, so the fused order is explainable.
	 */
	public hybrid(
		query: string,
		queryVec: Float32Array,
		k: number,
	): Promise<ReadonlyArray<HybridRow>> {
		return this.#store.hybrid(query, queryVec, Math.max(0, k));
	}

	/**
	 * Top-k products nearest a SEED product's stored vector, the seed excluded.
	 * Mirrors VectorSearcher.nearest (embeddings/index.py). Throws on an unknown id.
	 */
	public nearest(
		productId: string,
		k: number,
	): Promise<ReadonlyArray<VectorHit>> {
		if (this.#known.size > 0 && !this.#known.has(productId)) {
			return Promise.reject(new Error(`unknown product id: ${productId}`));
		}
		return this.#store.nearest(productId, Math.max(0, k));
	}

	public dispose(): Promise<void> {
		return this.#store.dispose();
	}
}

function parseBundleRevision(
	files: VectorIndexFiles,
	expectedDim?: number,
): {
	readonly dim: number;
	readonly ntotal: number;
	readonly ids: ReadonlyArray<string>;
	readonly matrix: Float32Array;
	readonly products: ReadonlyMap<string, Product>;
	readonly revisionKey: string;
} {
	const meta = parseCatalogMeta(files.meta);
	const dim = meta.embedding_dim;
	if (expectedDim !== undefined && dim !== expectedDim) {
		throw new VectorIndexError(
			`catalog_meta embedding_dim ${dim} != active index dimension ${expectedDim}`,
		);
	}
	const revisionKey =
		files.revisionKey ??
		`${String(meta.catalog_id ?? "catalog")}:${String(meta.version ?? "v1")}:${meta.embedding_count}`;
	if (
		(files.sqliteChunks !== undefined ||
			files.sqlite !== undefined ||
			files.sqliteAlreadyActive === true) &&
		files.state.byteLength === 0 &&
		files.embeddings.byteLength === 0 &&
		files.products.byteLength === 0
	) {
		return {
			dim,
			ntotal: meta.embedding_count,
			ids: [],
			matrix: new Float32Array(0),
			products: new Map(),
			revisionKey,
		};
	}
	const state = parseVectorState(files.state);
	const ntotal = state.faiss_ids.length;
	if (meta.embedding_count !== ntotal) {
		throw new VectorIndexError(
			`catalog_meta embedding_count ${meta.embedding_count} != faiss_ids length ${ntotal}`,
		);
	}
	const matrix = asMatrix(files.embeddings, ntotal, dim);
	const products = parseProducts(files.products);
	return { dim, ntotal, ids: state.faiss_ids, matrix, products, revisionKey };
}

async function* singleChunkStream(
	bytes: Uint8Array,
): AsyncGenerator<Uint8Array> {
	yield bytes;
}

async function concatChunks(
	chunks: AsyncIterable<Uint8Array>,
): Promise<Uint8Array> {
	const parts: Uint8Array[] = [];
	let total = 0;
	for await (const chunk of chunks) {
		parts.push(chunk);
		total += chunk.byteLength;
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.byteLength;
	}
	return out;
}

async function applyBundleToStore(
	store: CatalogueStore,
	files: VectorIndexFiles,
	parsed: {
		readonly ids: ReadonlyArray<string>;
		readonly matrix: Float32Array;
		readonly products: ReadonlyMap<string, Product>;
		readonly revisionKey: string;
	},
	options?: CatalogueSwapOptions,
): Promise<void> {
	const swapOpts: CatalogueSwapOptions = {
		...options,
		revisionKey: options?.revisionKey ?? parsed.revisionKey,
	};
	if (files.sqliteChunks !== undefined) {
		if (store.importSqliteFromChunks !== undefined) {
			await store.importSqliteFromChunks(files.sqliteChunks(), swapOpts);
			return;
		}
		if (store.importSqlite !== undefined) {
			const bytes = files.sqlite ?? (await concatChunks(files.sqliteChunks()));
			await store.importSqlite(bytes, swapOpts);
			return;
		}
	}
	if (files.sqlite !== undefined) {
		if (store.importSqlite !== undefined) {
			await store.importSqlite(files.sqlite, swapOpts);
			return;
		}
		if (store.importSqliteFromChunks !== undefined) {
			await store.importSqliteFromChunks(
				singleChunkStream(files.sqlite),
				swapOpts,
			);
			return;
		}
	}
	// The database is durable across catalogue revisions; replace() swaps the
	// whole revision (products, FTS5 index, vectors) in ONE transaction, so a
	// removed product cannot linger and an interrupted import leaves the old
	// revision intact. Bootstrap fails closed and the next attempt redoes it.
	await store.replace(
		{
			products: parsed.ids.map((id) =>
				catalogueRow(id, parsed.products.get(id)),
			),
			vectors: parsed.matrix,
		},
		options,
	);
}

/**
 * Parse the synced files and build a query-ready VectorIndex.
 *
 * `async` so the fail-closed validators (parseCatalogMeta / parseVectorState /
 * parseProducts) surface as a REJECTED promise rather than a synchronous throw —
 * callers await this, so a corrupt-but-signed bundle rejects cleanly instead of
 * tripping a sync throw the await site can't catch.
 */
export async function loadVectorIndex(
	files: VectorIndexFiles,
	factory: CatalogueStoreFactory = openCatalogueStore,
): Promise<VectorIndex> {
	const { dim, ntotal, ids, matrix, products, revisionKey } =
		parseBundleRevision(files);
	const store = await openCatalogue(factory, dim);
	try {
		if (files.sqliteAlreadyActive === true) {
			return new VectorIndex(store, ids, products, dim, ntotal);
		}
		const hasSqlite =
			files.sqliteChunks !== undefined || files.sqlite !== undefined;
		const canImportSqlite =
			store.importSqliteFromChunks !== undefined ||
			store.importSqlite !== undefined;
		if (hasSqlite && canImportSqlite) {
			if (
				store.activateRevision === undefined ||
				!(await store.activateRevision(revisionKey, ntotal))
			) {
				await applyBundleToStore(store, files, {
					ids,
					matrix,
					products,
					revisionKey,
				});
			}
		} else {
			await applyBundleToStore(store, files, {
				ids,
				matrix,
				products,
				revisionKey,
			});
		}
		return new VectorIndex(store, ids, products, dim, ntotal);
	} catch (error) {
		await store.dispose();
		const message = error instanceof Error ? error.message : String(error);
		throw new VectorIndexError(`vector index rejected the bundle: ${message}`);
	}
}

/** The stored and keyword-indexed fields of a product; a vector with no product row is
 * still searchable by similarity but has no text (hydration drops it, as before). */
function catalogueRow(
	id: string,
	product: Product | undefined,
): CatalogueProduct {
	return {
		id,
		title: product?.title ?? "",
		category: product?.category ?? "",
		tags: product?.tags ?? [],
		brand: product?.brand ?? "",
		...(product?.description !== undefined
			? { description: product.description }
			: {}),
		...(typeof product?.price === "number" ? { price: product.price } : {}),
		...(typeof product?.popularity_score === "number"
			? { popularity_score: product.popularity_score }
			: {}),
		...(typeof product?.freshness_score === "number"
			? { freshness_score: product.freshness_score }
			: {}),
		...(product?.image_url !== undefined
			? { image_url: product.image_url }
			: {}),
	};
}
