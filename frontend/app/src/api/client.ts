// The data layer — backend-free. Every call that used to hit the FastAPI backend
// now runs the in-browser engine (@edgereco/browser) over the synced signed bundle:
//
//   search()   -> engine.search(query)        (embed in-tab -> BM25⊕vector -> RRF -> rerank)
//   recommend()-> engine.recommend()          (popularity pool reranked by the live profile)
//   browse()   -> engine.browse()             (catalog listing over products.jsonl)
//   sendEvent()-> fold the click into the in-tab SessionProfile and append it
//                 to the taste log in the on-device SQLite database. NO network:
//                 no user data ever leaves the device.
//
// The whole point of the demo lives in sendEvent: a click updates the in-browser
// profile, so the very next recommend() re-ranks toward your taste — entirely
// in-tab, no round trip. The SearchResponse/RecommendResponse/BrowseResponse
// shapes are byte-identical to the old HTTP contract, so the components that
// consume this module did not change.
//
// bootstrap() must resolve before any of these calls (App gates the UI on it).

import {
	applyInteraction,
	type BootStage,
	buildProfile,
	configFromEnv,
	defaultRuntimeDeps,
	type Embedder,
	EngineRuntime,
	emptyProfile,
	type InteractionWeights,
	type OnStage,
	openTasteStore,
	type RankingProofEvidence,
	type RuntimeConfig,
	type RuntimeDeps,
	type SearchEngine,
	type SessionProfile,
	type TasteStore,
} from "@edgereco/browser";
import { record } from "../metrics/store";
import { retireLegacyLocalStorage } from "../signals/legacyStorage";
import {
	appendTasteEvent,
	bindTasteStore,
	clearTasteLog,
	migrateLegacyTaste,
	readTasteEvents,
	tasteDurable as tasteLogDurable,
} from "../signals/tasteLog";
import { resolveBundleBaseUrl } from "./bundleUrl";
import type {
	BrowseResponse,
	InteractionEvent,
	Product,
	RecommendResponse,
	SearchResponse,
	Strategy,
} from "./types";

interface SearchOptions {
	readonly limit?: number;
	readonly category?: string;
}

interface BrowseOptions {
	readonly category?: string;
	readonly limit?: number;
	readonly offset?: number;
}

/**
 * Options for a strategy-aware recommend. `seed` is required by the vector
 * strategies (`similar_items` / `because_viewed`) and ignored by the rest.
 */
interface RecommendStrategyOptions {
	readonly limit?: number;
	readonly seed?: string;
}

/** Options for the seed-based similar-items rail. */
interface SimilarOptions {
	readonly limit?: number;
	readonly strategy?: string;
}

/**
 * Strategies that re-rank with the live session profile. The rest
 * (`trending`, `new_arrivals`, `similar_items`) are intentionally stable —
 * popularity/freshness/seed-driven — so they get an empty profile and never
 * shuffle as the user interacts.
 */
const PERSONALIZED_STRATEGIES: ReadonlySet<string> = new Set([
	"for_you",
	"because_viewed",
]);

/**
 * A test-only hook on `window` for the Playwright e2e: replaces the default
 * embedder factory before the App calls bootstrap, so the backend-free hero
 * loop can run against the REAL sync + REAL search engine without waiting on
 * the ~25 MB transformers.js model download (the one slow/flaky external
 * fetch). Production never sets it.
 *
 * Lives in the demo (not in `@edgereco/browser`) because this is a property of
 * how this demo wires its e2e, not of the engine package itself.
 */
interface DemoTestHooks {
	readonly makeEmbedder?: () => Embedder;
}
declare global {
	interface Window {
		__edgeprocDemoTestHooks?: DemoTestHooks;
	}
}

/**
 * The app's runtime config: reuse the package's configFromEnv() (which pins
 * the verify key same-origin via document.baseURI) but absolutize the bundle
 * URL app-side, so an app-relative VITE_BUNDLE_BASE_URL (the GitHub Pages
 * build) reaches the sync Worker as the absolute URL it requires.
 */
function appRuntimeConfig(): RuntimeConfig {
	return { ...configFromEnv(), bundleBaseUrl: resolveBundleBaseUrl() };
}

/** The data-layer API. Created once per app/test session via createDataClient. */
export interface DataClient {
	bootstrap(onStage?: OnStage, config?: RuntimeConfig): Promise<void>;
	/**
	 * Clear ONLY the cached signed catalog (OPFS bundle + its rollback floor) so
	 * the next bootstrap re-syncs from scratch. The explicit, user-initiated
	 * recovery for a stuck integrity refusal — never called automatically.
	 */
	clearCatalogCache(): Promise<void>;
	/** Clear the live profile AND the durable taste log (the Reset-taste path). */
	resetSession(): Promise<void>;
	/** True when the taste log survives a reload (SQLite database in OPFS). */
	tasteDurable(): boolean;
	/**
	 * How many explicit signals (click | favorite | cart) the last bootstrap
	 * replayed from the durable log — the honest starting value for the
	 * For-You badge after a reload. Ambient views never count.
	 */
	replayedSignalCount(): number;
	search(q: string, opts?: SearchOptions): Promise<SearchResponse>;
	recommend(limit?: number): Promise<RecommendResponse>;
	recommendStrategy(
		strategy: string,
		opts?: RecommendStrategyOptions,
	): Promise<RecommendResponse>;
	similar(productId: string, opts?: SimilarOptions): Promise<RecommendResponse>;
	strategies(): Record<string, Strategy>;
	rankingProofEvidence(): RankingProofEvidence;
	catalog(): ReadonlyArray<Product>;
	browse(opts?: BrowseOptions): Promise<BrowseResponse>;
	sendEvent(evt: InteractionEvent): Promise<void>;
	catalogInfo(): Promise<{ readonly count: number }>;
}

/**
 * Build a data client over a fresh EngineRuntime. The closure captures the
 * runtime, the in-tab session profile, and the catalog id->product map; no
 * module-level mutable state is involved. Tests pass their own RuntimeDeps;
 * the production app uses `defaultRuntimeDeps()` (real Workers) with an
 * optional embedder override from `window.__edgeprocDemoTestHooks`.
 */
/** Runtime deps plus the user-database opener (tests inject a shared one). */
export interface ClientDeps extends Partial<RuntimeDeps> {
	readonly openTasteStore?: () => Promise<TasteStore>;
}

/**
 * Open the shopper's user database once per client. A failure degrades to
 * session-only taste (appends/reads no-op) and makes Reset fail visibly.
 */
async function openUserStore(
	open: () => Promise<TasteStore>,
): Promise<TasteStore | null> {
	try {
		return await open();
	} catch (error) {
		console.warn("[edge-reco] user database unavailable", error);
		return null;
	}
}

export function createDataClient(deps: ClientDeps = {}): DataClient {
	const runtime = new EngineRuntime(resolveDeps(deps));
	let userStore: Promise<TasteStore | null> | null = null;
	let profile: SessionProfile = emptyProfile();
	let productById: ReadonlyMap<string, Product> = new Map();
	// The SIGNED BUNDLE's per-event-type affinity bumps, captured at bootstrap.
	// The fold must use these (mirror of the Python session fold) — the typed
	// defaults apply only before bootstrap, when no product resolves anyway.
	let interactionWeights: InteractionWeights | undefined;
	// Explicit signals restored from the durable log by the last bootstrap.
	let replayedSignals = 0;

	function requireEngine(): SearchEngine {
		const engine = runtime.engine();
		if (engine === null) {
			throw new Error("engine not ready — call bootstrap() first");
		}
		return engine;
	}

	return {
		async bootstrap(
			onStage: OnStage = () => {},
			config: RuntimeConfig = appRuntimeConfig(),
		): Promise<void> {
			const engine = await runtime.bootstrap(config, (stage) => {
				warnIfExpired(stage);
				onStage(stage);
			});
			productById = new Map(engine.catalog().map((p) => [p.id, p]));
			interactionWeights = engine.interactionWeights();
			// The taste log lives in the shopper's own SQLite database, separate
			// from the disposable catalogue. Bind it, copy in anything an older
			// build left outside SQLite, and drop the old localStorage keys
			// (session id, uplink queue) — no longer used.
			userStore ??= openUserStore(deps.openTasteStore ?? openTasteStore);
			const store = await userStore;
			bindTasteStore(store);
			if (store !== null) {
				await migrateLegacyTaste(store);
			}
			retireLegacyLocalStorage();
			// Deterministic replay: rebuild the taste profile from the durable
			// log through the SAME fold used live (buildProfile ≡ repeated
			// applyInteraction), with the SAME bundle weights. Unknown product
			// ids (a catalog that moved on) are skipped, matching the fold.
			const logged = await readTasteEvents();
			profile = buildProfile(
				logged.map((event) => ({
					event_type: event.type,
					product_id: event.productId,
					timestamp: event.ts,
				})),
				productById,
				interactionWeights,
			);
			replayedSignals = logged.filter(
				(event) => event.type !== "view" && productById.has(event.productId),
			).length;
		},
		clearCatalogCache(): Promise<void> {
			return runtime.clearBundleCache();
		},
		resetSession(): Promise<void> {
			profile = emptyProfile();
			replayedSignals = 0;
			return clearTasteLog();
		},
		replayedSignalCount(): number {
			return replayedSignals;
		},
		tasteDurable(): boolean {
			return tasteLogDurable();
		},
		search(q: string, opts?: SearchOptions): Promise<SearchResponse> {
			return requireEngine().search(q, {
				profile,
				...(opts?.limit !== undefined ? { limit: opts.limit } : {}),
				...(opts?.category !== undefined ? { category: opts.category } : {}),
			});
		},
		recommend(limit?: number): Promise<RecommendResponse> {
			return Promise.resolve(
				requireEngine().recommend({
					profile,
					...(limit !== undefined ? { limit } : {}),
				}),
			);
		},
		recommendStrategy(
			strategy: string,
			opts?: RecommendStrategyOptions,
		): Promise<RecommendResponse> {
			const liveProfile = PERSONALIZED_STRATEGIES.has(strategy)
				? profile
				: emptyProfile();
			return Promise.resolve(
				requireEngine().recommend({
					profile: liveProfile,
					strategy,
					...(opts?.limit !== undefined ? { limit: opts.limit } : {}),
					...(opts?.seed !== undefined ? { seed: opts.seed } : {}),
				}),
			);
		},
		similar(
			productId: string,
			opts?: SimilarOptions,
		): Promise<RecommendResponse> {
			// similar_items is a stable, seed-driven rail: empty profile so the
			// ordering depends on the seed, not the session.
			return Promise.resolve(
				requireEngine().similar(productId, {
					profile: emptyProfile(),
					...(opts?.limit !== undefined ? { limit: opts.limit } : {}),
					...(opts?.strategy !== undefined ? { strategy: opts.strategy } : {}),
				}),
			);
		},
		strategies(): Record<string, Strategy> {
			return requireEngine().strategies();
		},
		rankingProofEvidence(): RankingProofEvidence {
			return requireEngine().rankingProofEvidence();
		},
		catalog(): ReadonlyArray<Product> {
			return requireEngine().catalog();
		},
		browse(opts?: BrowseOptions): Promise<BrowseResponse> {
			return Promise.resolve(
				requireEngine().browse({
					...(opts?.limit !== undefined ? { limit: opts.limit } : {}),
					...(opts?.category !== undefined ? { category: opts.category } : {}),
				}),
			);
		},
		async sendEvent(evt: InteractionEvent): Promise<void> {
			const product = productById.get(evt.product_id);
			if (product !== undefined) {
				profile = applyInteraction(
					profile,
					product,
					evt.event_type,
					interactionWeights,
				);
				// Land the event in the on-device SQLite taste log so a reload can
				// replay it (appendTasteEvent never throws — a storage failure
				// degrades to session-only behavior). Awaited so the event is
				// stored before the UI acknowledges the interaction.
				await appendTasteEvent(evt.event_type, evt.product_id);
			}
		},
		catalogInfo(): Promise<{ readonly count: number }> {
			return Promise.resolve({ count: requireEngine().ntotal });
		},
	};
}

/**
 * Surface an expired signed pointer. Offline, the engine may serve an
 * already-verified cached bundle whose pointer is past its signed `expires_at`
 * (`SyncResult.expired`): the bytes are intact and authentic, but the publisher
 * no longer vouches that they are current. The publisher sets no `expires_at`
 * today, so this is a coded, greppable developer breadcrumb — not UI copy.
 */
function warnIfExpired(stage: BootStage): void {
	if (stage.kind === "synced" && stage.result.expired === true) {
		console.warn(
			`[edge-reco:bundle.expired] serving the verified cached catalog ${stage.result.version}; its signed pointer is past expires_at, so it may be out of date`,
		);
	}
}

/**
 * Compose the final RuntimeDeps:
 *   explicit caller-passed dep > demo test hook (window) > package default.
 * The demo test hook is honored only for `makeEmbedder`; everything else uses
 * the real Worker-backed defaults from `@edgereco/browser`.
 */
function resolveDeps(deps: ClientDeps): RuntimeDeps {
	const base = defaultRuntimeDeps();
	const hookEmbedder =
		typeof window !== "undefined"
			? window.__edgeprocDemoTestHooks?.makeEmbedder
			: undefined;
	const loadPublisherKey = deps.loadPublisherKey ?? base.loadPublisherKey;
	const deleteFloorDatabase =
		deps.deleteFloorDatabase ?? base.deleteFloorDatabase;
	const makeCatalogue = deps.makeCatalogue ?? base.makeCatalogue;
	return {
		spawnEngine: deps.spawnEngine ?? base.spawnEngine,
		makeEmbedder: deps.makeEmbedder ?? hookEmbedder ?? base.makeEmbedder,
		...(loadPublisherKey !== undefined ? { loadPublisherKey } : {}),
		...(deleteFloorDatabase !== undefined ? { deleteFloorDatabase } : {}),
		...(makeCatalogue !== undefined ? { makeCatalogue } : {}),
	};
}

// --- The singleton the demo's App + components consume ----------------------

let active: DataClient = createDataClient();

/**
 * Test seam: rebind the active client to one built with injected deps and
 * clear the session, so a unit test can bootstrap over fixture data without a
 * browser. Not used by the app, which always uses the default Worker-backed
 * client.
 */
export function __setRuntimeForTests(deps: RuntimeDeps & ClientDeps): void {
	active = createDataClient(deps);
}

export function bootstrap(
	onStage?: OnStage,
	config?: RuntimeConfig,
): Promise<void> {
	return active.bootstrap(onStage, config);
}
export function clearCatalogCache(): Promise<void> {
	return active.clearCatalogCache();
}
export function resetSession(): Promise<void> {
	return active.resetSession();
}
export function replayedSignalCount(): number {
	return active.replayedSignalCount();
}
export function tasteDurable(): boolean {
	return active.tasteDurable();
}
export async function search(
	q: string,
	opts?: SearchOptions,
): Promise<SearchResponse> {
	const t0 = performance.now();
	const res = await active.search(q, opts);
	record({ searchMs: performance.now() - t0 });
	return res;
}
export async function recommend(limit?: number): Promise<RecommendResponse> {
	const t0 = performance.now();
	const res = await active.recommend(limit);
	record({ recommendMs: performance.now() - t0 });
	return res;
}
export async function recommendStrategy(
	strategy: string,
	opts?: RecommendStrategyOptions,
): Promise<RecommendResponse> {
	const t0 = performance.now();
	const res = await active.recommendStrategy(strategy, opts);
	record({ recommendMs: performance.now() - t0 });
	return res;
}
export async function similar(
	productId: string,
	opts?: SimilarOptions,
): Promise<RecommendResponse> {
	const t0 = performance.now();
	const res = await active.similar(productId, opts);
	record({ recommendMs: performance.now() - t0 });
	return res;
}
export function strategies(): Record<string, Strategy> {
	return active.strategies();
}
export function rankingProofEvidence(): RankingProofEvidence {
	return active.rankingProofEvidence();
}
export function catalog(): ReadonlyArray<Product> {
	return active.catalog();
}
export function browse(opts?: BrowseOptions): Promise<BrowseResponse> {
	return active.browse(opts);
}
export function sendEvent(evt: InteractionEvent): Promise<void> {
	return active.sendEvent(evt);
}
export function catalogInfo(): Promise<{ readonly count: number }> {
	return active.catalogInfo();
}
