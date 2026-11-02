// The browser runtime that turns the synced signed bundle into a live, in-tab
// SearchEngine — the in-browser replacement for the FastAPI backend.
//
// Three Workers, off the UI thread:
//   - the sync Worker (worker.ts) owns OPFS + the ported sync_index; it pulls the
//     signed, content-addressed bundle from the Caddy origin, verifies it
//     ed25519+sha256 fail-closed, and materializes the four index files;
//   - the embedder Worker (embedderWorker.ts) owns transformers.js: the ~25 MB
//     all-MiniLM-L6-v2 weights download + ONNX inference.
//   - @gainratio/browser's SQL Worker owns the catalogue database (FTS5 keyword
//     search, sqlite-vector cosine, RRF fusion) in OPFS (catalogueSql.ts).
//
// bootstrap() drives both with a progress callback so the UI can show real
// stages (syncing bundle… loading model…). It is idempotent: the engine is
// built once and cached; later calls return the same instance. After the first
// run everything needed to search lives in OPFS + the HTTP cache, so reloads
// are offline-capable (a re-sync over a reachable origin fetches zero chunks).

import {
	type ChunkRef,
	decompressAndVerify,
	EngineClient,
	EngineWorker,
	type FetchBytes,
	type FileEntry,
	fetchBytes,
	IntegrityError,
	MAX_DECOMPRESSED_CHUNK_BYTES,
	MAX_TRUST_ROOT_BYTES,
	NetworkError,
	parseTrustRoot,
	SyncCapError,
	type SyncResult,
	sha256Hex,
} from "../gainratio";
import { deleteBundleFloorDatabase } from "./cacheFloor";
import {
	type CatalogueStore,
	type CatalogueStoreFactory,
	openCatalogueStore,
} from "./catalogueDb";
import { clearCatalogueSqlStorage } from "./catalogueSql";
import { type CooccurrenceMatrix, parseCooccurrence } from "./cooccurrence";
import { createEmbedder, type Embedder } from "./embedder";
import { createWorkerEmbedder, spawnEmbedderWorker } from "./embedderClient";
import { parseRankingConfig, type RankingConfig } from "./rankingConfig";
import {
	RANKING_RECEIPT_NAME,
	type RankingProofEvidence,
	verifyRankingProof,
} from "./rankingProof";
import { createSearchEngine, type SearchEngine } from "./searchEngine";
import type { VectorIndexFiles } from "./vectorIndex";

/** The bundle files the in-browser index is assembled from. */
const META_PATH = "catalog_meta.json";
const STATE_PATH = "vector/state.json";
const EMBEDDINGS_PATH = "vector/embeddings.f32";
const PRODUCTS_PATH = "products.jsonl";
/** Optional canonical pre-built SQLite database (`products` + `products_fts` + `embedding`). */
const SQLITE_PATH = "catalogue.sqlite";
/** The signed ranking weights; absent on bundles that predate the feature. */
const RANKING_CONFIG_PATH = "ranking_config.json";
/** Avow envelope containing EdgeReco's static Assay ranking proof. */
const RANKING_RECEIPT_PATH = RANKING_RECEIPT_NAME;
/** The signed co-occurrence matrix; absent on bundles that predate Phase 3. */
const COOCCURRENCE_PATH = "cooccurrence.json";
/**
 * Small JSON metadata files materialized through the sync Worker's chunk store.
 * The canonical `catalogue.sqlite` is streamed chunk-by-chunk directly into the
 * SQLite Worker's OPFS database (`streamBundleSqliteChunks`) so neither Worker
 * ever allocates a 75 MB full-file buffer in memory.
 */
const SYNC_METADATA_PATHS: ReadonlyArray<string> = [
	META_PATH,
	RANKING_CONFIG_PATH,
	RANKING_RECEIPT_PATH,
	COOCCURRENCE_PATH,
];
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_COMPRESSED_CHUNK_BYTES = 2 * MAX_DECOMPRESSED_CHUNK_BYTES + 4096;
const CHUNK_FETCH_ATTEMPTS = 2;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/** Any non-empty string warms the ONNX session; content is discarded. */
const WARMUP_PROMPT = "warm up the model";

/** A bootstrap stage, surfaced to the UI for a real progress story. */
export type BootStage =
	| { readonly kind: "syncing" }
	| { readonly kind: "synced"; readonly result: SyncResult }
	| { readonly kind: "reassembling" }
	| { readonly kind: "loading-model" }
	| { readonly kind: "ready" };

/** Progress sink; called as bootstrap advances through its stages. */
export type OnStage = (stage: BootStage) => void;

/** Where the bundle is synced from + the pinned verify key, from Vite env. */
export interface RuntimeConfig {
	/** Caddy origin serving the signed bundle (`/latest`, `/manifest/*`, `/chunk/*`). */
	readonly bundleBaseUrl: string;
	/** Same-origin URL of the pinned ed25519 public key (NOT the bundle origin). */
	readonly pubkeyUrl: string;
	readonly expectedBundleId?: string;
	readonly expectedChannel?: string;
	/** Skip the eager 23 MB model warm; the first semantic search loads it.
	 * The storefront can render from the signed catalog before the model. */
	readonly deferEmbedder?: boolean;
}

/** Optional sync options forwarded to `EngineClient.sync`. */
export interface EngineSyncOptions {
	readonly wantedPaths?: ReadonlyArray<string>;
}

/** The sync-Worker surface bootstrap needs: pull the bundle, read its files. */
export interface EnginePort {
	sync(
		baseUrl: string,
		pubkeyUrl: string,
		expectedBundleId?: string,
		expectedChannel?: string,
		options?: EngineSyncOptions,
	): Promise<SyncResult>;
	readFile(path: string): Promise<Uint8Array>;
	/**
	 * Clear the durable signed-bundle cache (the library's SQLite cache database
	 * on OPFS: chunks, manifests, the active pointer and the rollback floor)
	 * under the same cross-tab lock as sync/read. `EngineClient.clear()` satisfies this. Only ever driven by an
	 * explicit user action — see {@link EngineRuntime.clearBundleCache}.
	 */
	clear?(): Promise<void>;
	/** Release the sync worker once the bundle is materialized. */
	dispose?(): void;
	/** Legacy lifecycle alias for worker-backed ports. */
	terminate?(): void;
}

/** The seams bootstrap depends on; defaulted to the real Workers, faked in tests. */
export interface RuntimeDeps {
	readonly spawnEngine: () => EnginePort;
	readonly makeEmbedder: () => Embedder;
	readonly makeCatalogue?: CatalogueStoreFactory;
	/**
	 * Fetch the raw trust-root bytes at `pubkeyUrl` — the SAME document the sync
	 * Worker pins: a legacy raw 32-byte Ed25519 key or an `edgeproc.keyring/v1`
	 * JSON keyring. Parsing is not the loader's job (see `loadTrustedKeys`).
	 */
	readonly loadPublisherKey?: (url: string) => Promise<Uint8Array>;
	/**
	 * Delete the IndexedDB rollback-floor database, awaited and bounded; used
	 * only by the explicit {@link EngineRuntime.clearBundleCache}. Defaults to
	 * `deleteBundleFloorDatabase` (cacheFloor.ts).
	 */
	readonly deleteFloorDatabase?: () => Promise<void>;
	/**
	 * Clear the local catalogue SQLite OPFS pool (`edgereco-catalogue`) while
	 * preserving `edgereco-user` taste data. Defaults to `clearCatalogueSqlStorage`.
	 */
	readonly clearCatalogueStorage?: () => Promise<unknown>;
	/**
	 * Optional byte fetcher for streaming verified `catalogue.sqlite` chunks
	 * directly into the SQLite Worker. Defaults to `@gainratio/browser`'s `fetchBytes`.
	 */
	readonly fetchBytes?: FetchBytes;
}

// `no-store`, matching upstream `loadTrustRoot`: the trust root is where a key is
// REVOKED, so an HTTP-cached copy would keep a revoked key verifying the ranking
// proof until the cache expired. It is a few hundred bytes, read once per boot.
const defaultLoadPublisherKey = (url: string): Promise<Uint8Array> =>
	fetchBytes(url, { cache: "no-store", maxBytes: MAX_TRUST_ROOT_BYTES });

/** Bundle the shared side-effect Worker entry from this Vite consumer. */
export function spawnEngineClient(): EngineClient {
	return new EngineClient(new EngineWorker());
}

const defaultDeps: RuntimeDeps = {
	spawnEngine: spawnEngineClient,
	makeEmbedder: () => createWorkerEmbedder(spawnEmbedderWorker()),
	loadPublisherKey: defaultLoadPublisherKey,
};

/**
 * Build the production runtime deps (real sync Worker + real transformers.js
 * embedder Worker). Exposed so consumers can compose — e.g. swap one field in
 * a test without re-implementing the other.
 */
export function defaultRuntimeDeps(): RuntimeDeps {
	return defaultDeps;
}

interface ReadBundleResult {
	readonly files: VectorIndexFiles;
	readonly preopenedStore: CatalogueStore | null;
}

export interface StreamBundleSqliteChunksOptions {
	readonly baseUrl: string;
	readonly manifestHash: string;
	readonly fetchBytes?: FetchBytes;
	readonly path?: string;
	readonly cachedChunkBaseUrls?: ReadonlyMap<string, string>;
}

async function fetchWithRetry(
	fetchFn: FetchBytes,
	url: string,
	maxBytes: number,
): Promise<Uint8Array> {
	let lastError: unknown;
	for (let attempt = 1; attempt <= CHUNK_FETCH_ATTEMPTS; attempt += 1) {
		try {
			return await fetchFn(url, { maxBytes });
		} catch (error) {
			lastError = error;
			if (!(error instanceof NetworkError) || attempt >= CHUNK_FETCH_ATTEMPTS) {
				throw error;
			}
		}
	}
	throw lastError;
}

function parseManifestFiles(
	manifestBytes: Uint8Array,
): ReadonlyArray<FileEntry> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(manifestBytes));
	} catch (error) {
		throw new IntegrityError(
			`manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new IntegrityError("manifest must be a JSON object");
	}
	const files = (parsed as { readonly files?: unknown }).files;
	if (!Array.isArray(files)) {
		throw new IntegrityError("manifest.files must be an array");
	}
	return files as ReadonlyArray<FileEntry>;
}

function parseManifestFileEntry(
	manifestBytes: Uint8Array,
	targetPath: string,
): FileEntry {
	const files = parseManifestFiles(manifestBytes);
	const entry = files.find(
		(candidate): candidate is FileEntry =>
			typeof candidate === "object" &&
			candidate !== null &&
			(candidate as { readonly path?: unknown }).path === targetPath,
	);
	if (entry === undefined) {
		throw new Error(`file ${targetPath} not in manifest`);
	}
	if (
		typeof entry.size !== "number" ||
		!Number.isSafeInteger(entry.size) ||
		entry.size < 0 ||
		!Array.isArray(entry.chunks)
	) {
		throw new IntegrityError(`manifest entry ${targetPath} is malformed`);
	}
	let sum = 0;
	for (const ref of entry.chunks as ReadonlyArray<ChunkRef>) {
		if (
			typeof ref !== "object" ||
			ref === null ||
			typeof ref.hash !== "string" ||
			!SHA256_HEX_RE.test(ref.hash) ||
			typeof ref.size !== "number" ||
			!Number.isInteger(ref.size) ||
			ref.size <= 0
		) {
			throw new IntegrityError(
				`manifest entry ${targetPath} has malformed chunk ref`,
			);
		}
		if (ref.size > MAX_DECOMPRESSED_CHUNK_BYTES) {
			throw new SyncCapError(
				`chunk ${ref.hash} declares size ${ref.size} > cap ${MAX_DECOMPRESSED_CHUNK_BYTES}`,
			);
		}
		sum += ref.size;
	}
	if (sum !== entry.size) {
		throw new IntegrityError(
			`manifest entry ${targetPath} chunk sizes sum to ${sum}, expected ${entry.size}`,
		);
	}
	return entry;
}

async function applyManifestChunkAccounting(
	rawResult: SyncResult,
	baseUrl: string,
	fetchFn: FetchBytes,
	chunkBaseUrlByHash: Map<string, string>,
): Promise<{
	readonly result: SyncResult;
	readonly previousChunkBaseUrls: ReadonlyMap<string, string>;
}> {
	const previousChunkBaseUrls = new Map(chunkBaseUrlByHash);
	const base = baseUrl.replace(/\/+$/, "");
	if (!SHA256_HEX_RE.test(rawResult.manifestHash)) {
		return { result: rawResult, previousChunkBaseUrls };
	}
	try {
		const manifestBytes = await fetchWithRetry(
			fetchFn,
			`${base}/manifest/${rawResult.manifestHash}`,
			MAX_MANIFEST_BYTES,
		);
		if ((await sha256Hex(manifestBytes)) !== rawResult.manifestHash) {
			return { result: rawResult, previousChunkBaseUrls };
		}
		const files = parseManifestFiles(manifestBytes);
		const distinctHashes = new Set<string>();
		for (const file of files) {
			if (Array.isArray(file?.chunks)) {
				for (const ref of file.chunks) {
					if (typeof ref?.hash === "string" && SHA256_HEX_RE.test(ref.hash)) {
						distinctHashes.add(ref.hash);
					}
				}
			}
		}
		if (distinctHashes.size === 0) {
			return { result: rawResult, previousChunkBaseUrls };
		}
		if (rawResult.chunksFetched === 0) {
			for (const hash of distinctHashes) {
				if (!chunkBaseUrlByHash.has(hash)) {
					chunkBaseUrlByHash.set(hash, base);
				}
			}
			return {
				result: {
					...rawResult,
					chunksFetched: 0,
					chunksReused: distinctHashes.size,
					bytesFetched: 0,
				},
				previousChunkBaseUrls,
			};
		}
		let reused = 0;
		let fetched = 0;
		for (const hash of distinctHashes) {
			if (previousChunkBaseUrls.has(hash)) {
				reused += 1;
			} else {
				fetched += 1;
				chunkBaseUrlByHash.set(hash, base);
			}
		}
		return {
			result: {
				...rawResult,
				chunksFetched: fetched,
				chunksReused: reused,
			},
			previousChunkBaseUrls,
		};
	} catch {
		return { result: rawResult, previousChunkBaseUrls };
	}
}

const STREAM_CHUNK_CONCURRENCY = 16;

async function fetchAndVerifyChunk(
	ref: ChunkRef,
	base: string,
	fetchFn: FetchBytes,
	cachedChunkBaseUrls?: ReadonlyMap<string, string>,
): Promise<Uint8Array> {
	const cachedBase = cachedChunkBaseUrls?.get(ref.hash)?.replace(/\/+$/, "");
	let compressed: Uint8Array;
	if (cachedBase !== undefined && cachedBase !== base) {
		try {
			compressed = await fetchWithRetry(
				fetchFn,
				`${cachedBase}/chunk/${ref.hash}`,
				MAX_COMPRESSED_CHUNK_BYTES,
			);
		} catch {
			compressed = await fetchWithRetry(
				fetchFn,
				`${base}/chunk/${ref.hash}`,
				MAX_COMPRESSED_CHUNK_BYTES,
			);
		}
	} else {
		compressed = await fetchWithRetry(
			fetchFn,
			`${base}/chunk/${ref.hash}`,
			MAX_COMPRESSED_CHUNK_BYTES,
		);
	}
	return decompressAndVerify(ref.hash, compressed, ref.size);
}

/**
 * Stream verified `catalogue.sqlite` chunks in strict index order using a
 * bounded sliding prefetch window (`STREAM_CHUNK_CONCURRENCY = 16`). Peak JS
 * heap in the stream is bounded to at most 16 chunks (~576 KiB) in flight.
 */
export async function* streamBundleSqliteChunks(
	options: StreamBundleSqliteChunksOptions,
): AsyncGenerator<Uint8Array> {
	const fetchFn = options.fetchBytes ?? fetchBytes;
	const base = options.baseUrl.replace(/\/+$/, "");
	const targetPath = options.path ?? SQLITE_PATH;
	if (!SHA256_HEX_RE.test(options.manifestHash)) {
		throw new IntegrityError(
			`invalid manifestHash for streamed SQLite bundle: ${options.manifestHash}`,
		);
	}
	const manifestBytes = await fetchWithRetry(
		fetchFn,
		`${base}/manifest/${options.manifestHash}`,
		MAX_MANIFEST_BYTES,
	);
	const actualManifestHash = await sha256Hex(manifestBytes);
	if (actualManifestHash !== options.manifestHash) {
		throw new IntegrityError(
			`manifest sha256 mismatch: expected ${options.manifestHash}, got ${actualManifestHash}`,
		);
	}
	const entry = parseManifestFileEntry(manifestBytes, targetPath);
	const chunks = entry.chunks;
	const inFlight: Array<Promise<Uint8Array>> = [];
	let nextIndex = 0;
	const enqueueNext = (): void => {
		const ref = chunks[nextIndex];
		if (ref === undefined) return;
		nextIndex += 1;
		const promise = fetchAndVerifyChunk(
			ref,
			base,
			fetchFn,
			options.cachedChunkBaseUrls,
		);
		promise.catch(() => {});
		inFlight.push(promise);
	};
	while (
		inFlight.length < STREAM_CHUNK_CONCURRENCY &&
		nextIndex < chunks.length
	) {
		enqueueNext();
	}
	for (
		let head = inFlight.shift();
		head !== undefined;
		head = inFlight.shift()
	) {
		enqueueNext();
		yield await head;
	}
}

function tryParseMetaCounts(metaBytes: Uint8Array): {
	readonly dim: number;
	readonly count: number;
	readonly rev: string;
} | null {
	try {
		const raw = JSON.parse(new TextDecoder().decode(metaBytes)) as Record<
			string,
			unknown
		>;
		const dim = raw.embedding_dim;
		const count = raw.embedding_count;
		if (
			typeof dim === "number" &&
			Number.isInteger(dim) &&
			dim >= 1 &&
			typeof count === "number" &&
			Number.isInteger(count) &&
			count >= 1
		) {
			const rev = `${String(raw.catalog_id ?? "catalog")}:${String(raw.version ?? "v1")}:${count}`;
			return { dim, count, rev };
		}
	} catch {
		// Fall through to normal validation in loadVectorIndex.
	}
	return null;
}

async function readBundleFiles(
	engine: EnginePort,
	options?: {
		readonly revisionKey?: string;
		readonly makeCatalogue?: CatalogueStoreFactory;
		readonly streamedSqlite?: StreamBundleSqliteChunksOptions;
	},
): Promise<ReadBundleResult> {
	if (options?.streamedSqlite !== undefined) {
		const meta = await engine.readFile(META_PATH);
		const parsedMeta = tryParseMetaCounts(meta);
		const revisionKey = options.revisionKey ?? parsedMeta?.rev;
		let preopenedStore: CatalogueStore | null = null;
		if (parsedMeta !== null && options.makeCatalogue !== undefined) {
			try {
				preopenedStore = await options.makeCatalogue({
					dimension: parsedMeta.dim,
				});
				if (
					revisionKey !== undefined &&
					preopenedStore.activateRevision !== undefined &&
					(await preopenedStore.activateRevision(revisionKey, parsedMeta.count))
				) {
					return {
						files: {
							meta,
							state: new Uint8Array(0),
							embeddings: new Uint8Array(0),
							products: new Uint8Array(0),
							revisionKey,
							sqliteAlreadyActive: true,
						},
						preopenedStore,
					};
				}
			} catch {
				if (preopenedStore !== null) {
					await preopenedStore.dispose();
					preopenedStore = null;
				}
			}
		}
		const streamOpts = options.streamedSqlite;
		return {
			files: {
				meta,
				state: new Uint8Array(0),
				embeddings: new Uint8Array(0),
				products: new Uint8Array(0),
				sqliteChunks: () => streamBundleSqliteChunks(streamOpts),
				...(revisionKey !== undefined ? { revisionKey } : {}),
			},
			preopenedStore,
		};
	}

	const [meta, state, embeddings, products] = await Promise.all([
		engine.readFile(META_PATH),
		readOptionalBundleFile(engine, STATE_PATH),
		readOptionalBundleFile(engine, EMBEDDINGS_PATH),
		readOptionalBundleFile(engine, PRODUCTS_PATH),
	]);
	if (
		state === undefined ||
		embeddings === undefined ||
		products === undefined
	) {
		const parsedMeta = tryParseMetaCounts(meta);
		const revisionKey = options?.revisionKey ?? parsedMeta?.rev;
		let preopenedStore: CatalogueStore | null = null;
		if (parsedMeta !== null && options?.makeCatalogue !== undefined) {
			try {
				preopenedStore = await options.makeCatalogue({
					dimension: parsedMeta.dim,
				});
				if (
					revisionKey !== undefined &&
					preopenedStore.activateRevision !== undefined &&
					(await preopenedStore.activateRevision(revisionKey, parsedMeta.count))
				) {
					return {
						files: {
							meta,
							state: new Uint8Array(0),
							embeddings: new Uint8Array(0),
							products: new Uint8Array(0),
							revisionKey,
							sqliteAlreadyActive: true,
						},
						preopenedStore,
					};
				}
			} catch {
				if (preopenedStore !== null) {
					await preopenedStore.dispose();
					preopenedStore = null;
				}
			}
		}
		try {
			const sqlite = await readOptionalBundleFile(engine, SQLITE_PATH);
			if (sqlite !== undefined) {
				return {
					files: {
						meta,
						state: new Uint8Array(0),
						embeddings: new Uint8Array(0),
						products: new Uint8Array(0),
						sqlite,
						...(revisionKey !== undefined ? { revisionKey } : {}),
					},
					preopenedStore,
				};
			}
		} catch (error) {
			if (preopenedStore !== null) {
				await preopenedStore.dispose();
			}
			throw error;
		}
		if (preopenedStore !== null) {
			await preopenedStore.dispose();
		}
	}
	const sqlite = await readOptionalBundleFile(engine, SQLITE_PATH);
	if (state === undefined) {
		await engine.readFile(STATE_PATH);
		throw new Error(`file ${STATE_PATH} not in manifest`);
	}
	if (embeddings === undefined) {
		await engine.readFile(EMBEDDINGS_PATH);
		throw new Error(`file ${EMBEDDINGS_PATH} not in manifest`);
	}
	if (products === undefined) {
		await engine.readFile(PRODUCTS_PATH);
		throw new Error(`file ${PRODUCTS_PATH} not in manifest`);
	}
	return {
		files: {
			meta,
			state,
			embeddings,
			products,
			...(sqlite !== undefined ? { sqlite } : {}),
			...(options?.revisionKey !== undefined
				? { revisionKey: options.revisionKey }
				: {}),
		},
		preopenedStore: null,
	};
}

/**
 * Read an OPTIONAL bundle file, distinguishing ABSENT from a real error. The sync
 * layer signals "this file predates the bundle" with a typed `file <path> not in
 * manifest` rejection (sync.ts `fileEntry`); that — and ONLY that — maps to
 * `undefined` so the caller degrades to its default. Any other rejection (a read/
 * IPC failure, a corrupt chunk) propagates so the bootstrap fails CLOSED instead of
 * silently masking a real fault as "older bundle".
 */
export async function readOptionalBundleFile(
	engine: EnginePort,
	path: string,
): Promise<Uint8Array | undefined> {
	try {
		return await engine.readFile(path);
	} catch (error) {
		if (
			error instanceof Error &&
			error.message === `file ${path} not in manifest`
		) {
			return undefined;
		}
		throw error;
	}
}

/**
 * Read the bundle's VERIFIED ranking_config.json — it rides in the signed
 * manifest, so engine.readFile materializes it through the same ed25519/sha256
 * path as catalog_meta.json (no out-of-band fetch, no verification bypass). A
 * bundle that predates the file has no such manifest entry (→ undefined → typed
 * default). A present-but-malformed file throws in parseRankingConfig (fail-closed),
 * and an unexpected read error propagates from readOptionalBundleFile.
 */
async function readRankingConfig(engine: EnginePort): Promise<RankingConfig> {
	const bytes = await readOptionalBundleFile(engine, RANKING_CONFIG_PATH);
	return parseRankingConfig(bytes);
}

/**
 * The keys the ranking proof may be signed by: every UNREVOKED key of the
 * pinned trust root, read with upstream `parseTrustRoot` — the exact parser the
 * sync Worker uses (`loadTrustRoot`) — so both readers agree on one format and a
 * key rotation to an `edgeproc.keyring/v1` trust root keeps the proof verified.
 * An unreachable or malformed trust root yields `undefined` (→ key_unavailable);
 * the proof is evidence, never boot-critical.
 */
async function loadTrustedKeys(
	url: string,
	loader: (url: string) => Promise<Uint8Array>,
): Promise<ReadonlyArray<Uint8Array> | undefined> {
	try {
		const keyring = await parseTrustRoot(await loader(url));
		const revoked = new Set(keyring.revoked);
		return keyring.keys
			.filter((key) => !revoked.has(key.keyId))
			.map((key) => key.publicKey);
	} catch {
		return undefined;
	}
}

/** Read and verify the static proof without making proof availability boot-critical. */
export async function readRankingProofEvidence(
	engine: EnginePort,
	config: RankingConfig,
	pubkeyUrl: string,
	loadPublisherKey: (url: string) => Promise<Uint8Array>,
): Promise<RankingProofEvidence> {
	const receipt = await readOptionalBundleFile(engine, RANKING_RECEIPT_PATH);
	const preliminary = await verifyRankingProof(receipt, config, undefined);
	if (
		preliminary.status !== "unavailable" ||
		preliminary.reason !== "key_unavailable"
	) {
		return preliminary;
	}
	const trustedKeys = await loadTrustedKeys(pubkeyUrl, loadPublisherKey);
	return verifyRankingProof(receipt, config, trustedKeys);
}

/**
 * Read the bundle's VERIFIED cooccurrence.json the SAME way as ranking_config.json:
 * it rides in the signed manifest, so engine.readFile materializes it through the
 * ed25519/sha256 path (no out-of-band fetch, no verification bypass). A bundle that
 * predates Phase 3 has no such manifest entry (→ undefined → empty matrix). A
 * present-but-malformed file throws in parseCooccurrence (fail-closed), and an
 * unexpected read error propagates from readOptionalBundleFile.
 */
async function readCooccurrence(
	engine: EnginePort,
): Promise<CooccurrenceMatrix> {
	const bytes = await readOptionalBundleFile(engine, COOCCURRENCE_PATH);
	return parseCooccurrence(bytes);
}

/** Read Vite env into a RuntimeConfig; the pubkey is pinned same-origin. */
export function configFromEnv(): RuntimeConfig {
	const bundleBaseUrl = import.meta.env.VITE_BUNDLE_BASE_URL;
	// The pinned key ships in the SPA build (public/public.key), served from the
	// app's OWN trusted origin — never fetched from the untrusted bundle origin.
	const pubkeyUrl = new URL("public.key", document.baseURI).toString();
	const expectedBundleId = import.meta.env.VITE_BUNDLE_ID ?? "amazon-demo";
	const expectedChannel = import.meta.env.VITE_BUNDLE_CHANNEL ?? "stable";
	return { bundleBaseUrl, pubkeyUrl, expectedBundleId, expectedChannel };
}

/**
 * Sync the signed bundle, warm the embedder, and build the in-tab SearchEngine.
 * Idempotent — the first call wins and its result is cached for the tab.
 */
export class EngineRuntime {
	readonly #deps: RuntimeDeps;
	#enginePromise: Promise<SearchEngine> | null = null;
	#ready: SearchEngine | null = null;
	#manifestHash: string | null = null;
	#enginePort: EnginePort | null = null;
	#embedder: Embedder | null = null;
	#chunkBaseUrlByHash = new Map<string, string>();
	#generation = 0;

	public constructor(deps: RuntimeDeps = defaultDeps) {
		this.#deps = deps;
	}

	/** The ready engine, or null before the first successful bootstrap. */
	public engine(): SearchEngine | null {
		return this.#ready;
	}

	/** Content hash of the currently active bundle manifest, or null before boot. */
	public activeManifestHash(): string | null {
		return this.#manifestHash;
	}

	/** Build (or reuse) the engine over the synced bundle, reporting progress. */
	public bootstrap(
		config: RuntimeConfig,
		onStage: OnStage = () => {},
	): Promise<SearchEngine> {
		if (this.#enginePromise === null) {
			const generation = this.#generation;
			this.#enginePromise = this.#build(config, onStage, generation).catch(
				(error) => {
					// Let a failed bootstrap be retried by clearing the memo. A stale
					// build must not clear a newer attempt after explicit dispose().
					if (this.#generation === generation) {
						this.#enginePromise = null;
					}
					throw error;
				},
			);
		}
		return this.#enginePromise;
	}

	/**
	 * Background delta sync + live SQLite hot-swap: checks `/latest` via a
	 * short-lived sync Worker, pulls only missing Gear-CDC chunks, and if the
	 * manifest hash changed, atomically swaps the live `SearchEngine` in place
	 * behind the 150 ms SQLite swap gate without reloading the embedder.
	 * Returns `null` when the active manifest is already up to date.
	 */
	public async syncUpdate(
		config: RuntimeConfig,
		onStage: OnStage = () => {},
		options?: { readonly skipReload?: boolean },
	): Promise<SyncResult | null> {
		const ready = this.#ready;
		if (ready === null) {
			throw new Error(
				"engine not ready — call bootstrap() before syncUpdate()",
			);
		}
		if (ready.reload === undefined) {
			return null;
		}
		const generation = this.#generation;
		const engineClient = this.#deps.spawnEngine();
		this.#enginePort = engineClient;
		try {
			onStage({ kind: "syncing" });
			const useStreamedSqlite =
				engineClient instanceof EngineClient ||
				this.#deps.fetchBytes !== undefined;
			const rawResult = useStreamedSqlite
				? await engineClient.sync(
						config.bundleBaseUrl,
						config.pubkeyUrl,
						config.expectedBundleId,
						config.expectedChannel,
						{ wantedPaths: SYNC_METADATA_PATHS },
					)
				: await engineClient.sync(
						config.bundleBaseUrl,
						config.pubkeyUrl,
						config.expectedBundleId,
						config.expectedChannel,
					);
			this.#assertCurrent(generation);
			if (rawResult.manifestHash === this.#manifestHash) {
				return null;
			}
			const { result, previousChunkBaseUrls } = useStreamedSqlite
				? await applyManifestChunkAccounting(
						rawResult,
						config.bundleBaseUrl,
						this.#deps.fetchBytes ?? fetchBytes,
						this.#chunkBaseUrlByHash,
					)
				: {
						result: rawResult,
						previousChunkBaseUrls: this.#chunkBaseUrlByHash,
					};
			this.#assertCurrent(generation);
			if (options?.skipReload === true) {
				this.#manifestHash = result.manifestHash;
				return result;
			}
			onStage({ kind: "synced", result });
			onStage({ kind: "reassembling" });
			const [{ files }, rankingConfig, cooccurrence] = await Promise.all([
				readBundleFiles(engineClient, {
					revisionKey: result.manifestHash,
					...(useStreamedSqlite
						? {
								streamedSqlite: {
									baseUrl: config.bundleBaseUrl,
									manifestHash: result.manifestHash,
									cachedChunkBaseUrls: previousChunkBaseUrls,
									...(this.#deps.fetchBytes !== undefined
										? { fetchBytes: this.#deps.fetchBytes }
										: {}),
								},
							}
						: {}),
				}),
				readRankingConfig(engineClient),
				readCooccurrence(engineClient),
			]);
			const proofEvidence = await readRankingProofEvidence(
				engineClient,
				rankingConfig,
				config.pubkeyUrl,
				this.#deps.loadPublisherKey ?? defaultLoadPublisherKey,
			);
			this.#assertCurrent(generation);
			await ready.reload(files, rankingConfig, cooccurrence, proofEvidence);
			this.#manifestHash = result.manifestHash;
			onStage({ kind: "ready" });
			return result;
		} finally {
			this.#releaseEngine(engineClient);
		}
	}

	async #build(
		config: RuntimeConfig,
		onStage: OnStage,
		generation: number,
	): Promise<SearchEngine> {
		let engineClient: EnginePort | null = null;
		let embedder: Embedder | null = null;
		let searchEngine: SearchEngine | null = null;
		let preopenedStore: CatalogueStore | null = null;
		try {
			engineClient = this.#deps.spawnEngine();
			this.#enginePort = engineClient;
			onStage({ kind: "syncing" });
			const useStreamedSqlite =
				engineClient instanceof EngineClient ||
				this.#deps.fetchBytes !== undefined;
			const rawResult = useStreamedSqlite
				? await engineClient.sync(
						config.bundleBaseUrl,
						config.pubkeyUrl,
						config.expectedBundleId,
						config.expectedChannel,
						{ wantedPaths: SYNC_METADATA_PATHS },
					)
				: await engineClient.sync(
						config.bundleBaseUrl,
						config.pubkeyUrl,
						config.expectedBundleId,
						config.expectedChannel,
					);
			this.#assertCurrent(generation);
			const { result, previousChunkBaseUrls } = useStreamedSqlite
				? await applyManifestChunkAccounting(
						rawResult,
						config.bundleBaseUrl,
						this.#deps.fetchBytes ?? fetchBytes,
						this.#chunkBaseUrlByHash,
					)
				: {
						result: rawResult,
						previousChunkBaseUrls: this.#chunkBaseUrlByHash,
					};
			this.#assertCurrent(generation);
			onStage({ kind: "synced", result });

			onStage({ kind: "reassembling" });
			const [bundleRead, rankingConfig, cooccurrence] = await Promise.all([
				readBundleFiles(engineClient, {
					revisionKey: result.manifestHash,
					makeCatalogue: this.#deps.makeCatalogue ?? openCatalogueStore,
					...(useStreamedSqlite
						? {
								streamedSqlite: {
									baseUrl: config.bundleBaseUrl,
									manifestHash: result.manifestHash,
									cachedChunkBaseUrls: previousChunkBaseUrls,
									...(this.#deps.fetchBytes !== undefined
										? { fetchBytes: this.#deps.fetchBytes }
										: {}),
								},
							}
						: {}),
				}),
				readRankingConfig(engineClient),
				readCooccurrence(engineClient),
			]);
			const { files } = bundleRead;
			preopenedStore = bundleRead.preopenedStore;
			const proofEvidence = await readRankingProofEvidence(
				engineClient,
				rankingConfig,
				config.pubkeyUrl,
				this.#deps.loadPublisherKey ?? defaultLoadPublisherKey,
			);
			// The sync worker has done its job; release OPFS/IPC resources before
			// loading the model so the two largest allocations do not overlap.
			this.#releaseEngine(engineClient);
			engineClient = null;
			this.#assertCurrent(generation);

			embedder = this.#deps.makeEmbedder();
			this.#embedder = embedder;
			if (config.deferEmbedder !== true) {
				onStage({ kind: "loading-model" });
				// Eager mode: force the ~25 MB model download/compile now so the first
				// user query is fast.
				await embedder.embed(WARMUP_PROMPT);
			}
			this.#assertCurrent(generation);

			const catalogueFactory: CatalogueStoreFactory | undefined =
				preopenedStore !== null
					? () => {
							const store = preopenedStore as CatalogueStore;
							preopenedStore = null;
							return Promise.resolve(store);
						}
					: this.#deps.makeCatalogue;
			searchEngine = await createSearchEngine(
				files,
				embedder,
				rankingConfig,
				cooccurrence,
				proofEvidence,
				catalogueFactory,
			);
			this.#assertCurrent(generation);
			this.#ready = searchEngine;
			this.#manifestHash = result.manifestHash;
			onStage({ kind: "ready" });
			return searchEngine;
		} catch (error) {
			if (preopenedStore !== null) {
				await preopenedStore.dispose();
			}
			if (searchEngine !== null) {
				if (this.#ready === searchEngine) {
					this.#ready = null;
				}
				await searchEngine.dispose();
			}
			if (engineClient !== null) {
				this.#releaseEngine(engineClient);
			}
			if (embedder !== null) {
				this.#releaseEmbedder(embedder);
			}
			throw error;
		}
	}

	/** Release both worker-backed resources and permit a fresh bootstrap. */
	public async dispose(): Promise<void> {
		this.#generation += 1;
		this.#enginePromise = null;
		this.#manifestHash = null;
		this.#chunkBaseUrlByHash.clear();
		const ready = this.#ready;
		this.#ready = null;
		if (ready !== null) {
			await ready.dispose();
		}
		const enginePort = this.#enginePort;
		this.#enginePort = null;
		if (enginePort !== null) {
			disposeResource(enginePort);
		}
		const embedder = this.#embedder;
		this.#embedder = null;
		if (embedder !== null) {
			disposeResource(embedder);
		}
	}

	/**
	 * Wipe the synced signed-bundle cache — chunks, manifests, the durable active
	 * pointer and the rollback floor, all in the library's SQLite cache database
	 * since @gainratio/browser 0.3.0 — through the upstream
	 * `EngineClient.clear()` on a dedicated, short-lived sync Worker.
	 * Nothing else is touched: not the service-worker caches, not the
	 * self-hosted model cache, not the on-device taste log or vector database.
	 *
	 * SECURITY: this discards the anti-rollback floor and returns the device to
	 * first-install trust (the next pointer is verified against the pinned key
	 * exactly as for a new visitor, with no floor). It exists for ONE caller: an
	 * explicit, user-initiated "clear cached catalog" action after a failed
	 * boot. Never call it automatically in response to a `RollbackError` or any
	 * other refusal — that would turn rollback protection into a no-op.
	 *
	 * Refused while a bootstrap is in flight or an engine is live, so it cannot
	 * race the sync it would be wiping. A failed bootstrap clears its memo, so
	 * the boot-failure screen can always reach it.
	 *
	 * Order: (1) tear down any worker a failed boot left behind, so it releases
	 * the Web Lock and its OPFS sync-access handles; (2) run the library clear
	 * on a fresh sync worker, under the cache's Web Lock; (3) release that
	 * worker; (4) delete the 0.2.x IndexedDB floor database the library migrated
	 * from, awaited and bounded (`onblocked` waits; a timeout rejects), so no
	 * pre-migration copy of the floor survives the clear. Any failure rejects — a partial clear is never reported as done.
	 */
	public async clearBundleCache(): Promise<void> {
		if (this.#enginePromise !== null) {
			throw new Error(
				"cannot clear the bundle cache while the engine is booting or running",
			);
		}
		this.#teardownIdleWorkers();
		const port = this.#deps.spawnEngine();
		try {
			if (port.clear === undefined) {
				throw new Error("this engine port cannot clear its bundle cache");
			}
			await port.clear();
		} finally {
			disposeResource(port);
		}
		await (this.#deps.deleteFloorDatabase ?? deleteBundleFloorDatabase)();
		await (this.#deps.clearCatalogueStorage ?? clearCatalogueSqlStorage)();
		this.#chunkBaseUrlByHash.clear();
	}

	/**
	 * Reset the signed-bundle sync cache and anti-rollback floor while keeping
	 * the live SearchEngine and Embedder warm, so an explicit user-triggered
	 * delta-patch replay can re-seed `v1` (`sequence: 16`) and re-apply `v2`
	 * (`sequence: 17`) via `syncUpdate()` without reloading the 23 MB ONNX model.
	 */
	public async resetBundleCacheForUpdate(): Promise<void> {
		const port = this.#deps.spawnEngine();
		try {
			if (port.clear === undefined) {
				throw new Error("this engine port cannot clear its bundle cache");
			}
			await port.clear();
		} finally {
			disposeResource(port);
		}
		await (this.#deps.deleteFloorDatabase ?? deleteBundleFloorDatabase)();
		this.#manifestHash = null;
		this.#chunkBaseUrlByHash.clear();
	}

	/** Release any sync/embedder worker still held while no boot is running. */
	#teardownIdleWorkers(): void {
		const enginePort = this.#enginePort;
		if (enginePort !== null) {
			this.#releaseEngine(enginePort);
		}
		const embedder = this.#embedder;
		if (embedder !== null) {
			this.#releaseEmbedder(embedder);
		}
	}

	#assertCurrent(generation: number): void {
		if (generation !== this.#generation) {
			throw new Error("engine runtime disposed during bootstrap");
		}
	}

	#releaseEngine(enginePort: EnginePort): void {
		if (this.#enginePort !== enginePort) {
			return;
		}
		this.#enginePort = null;
		disposeResource(enginePort);
	}

	#releaseEmbedder(embedder: Embedder): void {
		if (this.#embedder !== embedder) {
			return;
		}
		this.#embedder = null;
		disposeResource(embedder);
	}
}

interface DisposableResource {
	dispose?: () => void;
	terminate?: () => void;
}

function disposeResource(resource: DisposableResource): void {
	if (resource.dispose !== undefined) {
		resource.dispose();
		return;
	}
	resource.terminate?.();
}

/** Re-exported so call sites that only need the pure embedder can build one. */
export { createEmbedder };
