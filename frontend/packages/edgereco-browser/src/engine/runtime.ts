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
	EngineClient,
	fetchBytes,
	MAX_TRUST_ROOT_BYTES,
	parseTrustRoot,
	type SyncResult,
} from "@gainratio/browser";
import { deleteBundleFloorDatabase } from "./cacheFloor";
import type { CatalogueStoreFactory } from "./catalogueDb";
import { type CooccurrenceMatrix, parseCooccurrence } from "./cooccurrence";
import EdgeProcWorker from "./edgeprocWorker?worker";
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

/** The four bundle files the in-browser index is assembled from. */
const META_PATH = "catalog_meta.json";
const STATE_PATH = "vector/state.json";
const EMBEDDINGS_PATH = "vector/embeddings.f32";
const PRODUCTS_PATH = "products.jsonl";
/** The signed ranking weights; absent on bundles that predate the feature. */
const RANKING_CONFIG_PATH = "ranking_config.json";
/** Avow envelope containing EdgeReco's static Assay ranking proof. */
const RANKING_RECEIPT_PATH = RANKING_RECEIPT_NAME;
/** The signed co-occurrence matrix; absent on bundles that predate Phase 3. */
const COOCCURRENCE_PATH = "cooccurrence.json";

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
}

/** The sync-Worker surface bootstrap needs: pull the bundle, read its files. */
export interface EnginePort {
	sync(
		baseUrl: string,
		pubkeyUrl: string,
		expectedBundleId?: string,
		expectedChannel?: string,
	): Promise<SyncResult>;
	readFile(path: string): Promise<Uint8Array>;
	/**
	 * Clear the durable signed-bundle cache (OPFS chunks/manifests, the active
	 * pointer and the IndexedDB rollback floor) under the same cross-tab lock as
	 * sync/read. `EngineClient.clear()` satisfies this. Only ever driven by an
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
}

// `no-store`, matching upstream `loadTrustRoot`: the trust root is where a key is
// REVOKED, so an HTTP-cached copy would keep a revoked key verifying the ranking
// proof until the cache expired. It is a few hundred bytes, read once per boot.
const defaultLoadPublisherKey = (url: string): Promise<Uint8Array> =>
	fetchBytes(url, { cache: "no-store", maxBytes: MAX_TRUST_ROOT_BYTES });

/** Bundle the shared side-effect Worker entry from this Vite consumer. */
export function spawnEngineClient(): EngineClient {
	return new EngineClient(new EdgeProcWorker());
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

async function readBundleFiles(engine: EnginePort): Promise<VectorIndexFiles> {
	const [meta, state, embeddings, products] = await Promise.all([
		engine.readFile(META_PATH),
		engine.readFile(STATE_PATH),
		engine.readFile(EMBEDDINGS_PATH),
		engine.readFile(PRODUCTS_PATH),
	]);
	return { meta, state, embeddings, products };
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
	#enginePort: EnginePort | null = null;
	#embedder: Embedder | null = null;
	#generation = 0;

	public constructor(deps: RuntimeDeps = defaultDeps) {
		this.#deps = deps;
	}

	/** The ready engine, or null before the first successful bootstrap. */
	public engine(): SearchEngine | null {
		return this.#ready;
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

	async #build(
		config: RuntimeConfig,
		onStage: OnStage,
		generation: number,
	): Promise<SearchEngine> {
		let engineClient: EnginePort | null = null;
		let embedder: Embedder | null = null;
		let searchEngine: SearchEngine | null = null;
		try {
			engineClient = this.#deps.spawnEngine();
			this.#enginePort = engineClient;
			onStage({ kind: "syncing" });
			const result = await engineClient.sync(
				config.bundleBaseUrl,
				config.pubkeyUrl,
				config.expectedBundleId,
				config.expectedChannel,
			);
			this.#assertCurrent(generation);
			onStage({ kind: "synced", result });

			onStage({ kind: "reassembling" });
			const [files, rankingConfig, cooccurrence] = await Promise.all([
				readBundleFiles(engineClient),
				readRankingConfig(engineClient),
				readCooccurrence(engineClient),
			]);
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

			onStage({ kind: "loading-model" });
			embedder = this.#deps.makeEmbedder();
			this.#embedder = embedder;
			// Force the ~25 MB model download/compile now so "loading-model" reflects
			// real work and the first user query is fast.
			await embedder.embed(WARMUP_PROMPT);
			this.#assertCurrent(generation);

			searchEngine = await createSearchEngine(
				files,
				embedder,
				rankingConfig,
				cooccurrence,
				proofEvidence,
				this.#deps.makeCatalogue,
			);
			this.#assertCurrent(generation);
			this.#ready = searchEngine;
			onStage({ kind: "ready" });
			return searchEngine;
		} catch (error) {
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
	 * Wipe the synced signed-bundle cache — OPFS `chunk/`, `manifest/` and the
	 * durable active pointer, plus the IndexedDB rollback floor — through the
	 * upstream `EngineClient.clear()` on a dedicated, short-lived sync Worker.
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
	 * worker; (4) delete the IndexedDB floor database, awaited and bounded
	 * (`onblocked` waits; a timeout rejects), so the floor cannot silently
	 * survive. Any failure rejects — a partial clear is never reported as done.
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
