import type { TFunction } from "i18next";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { resolveBundleBaseUrl } from "../api/bundleUrl";
import {
	browse,
	catalog,
	catalogInfo,
	rankingProofEvidence,
	recommendStrategy,
	replayedSignalCount,
	resetSession,
	search,
	similar,
	strategies,
	tasteDurable,
} from "../api/client";
import type { EventType, Product, SearchResult, Strategy } from "../api/types";
import { startMetricsObservers } from "../metrics/observe";
import { record } from "../metrics/store";
import { emitInteraction, resetSignalCaps } from "../signals/emit";
import { useDwellViews } from "../signals/useDwellViews";
import { useDebounced } from "../useDebounced";
import { Header } from "./Header";
import { MetricsStrip } from "./MetricsStrip";
import type { PdpRail } from "./ProductDetail";
import { ProductDetail } from "./ProductDetail";
import { ProductGrid } from "./ProductGrid";
import { type RailData, RailStack } from "./RailStack";
import {
	coBuyRails,
	homeRails,
	trendingInCategoryLabel,
} from "./railSelection";
import { StorageBadge } from "./StorageBadge";
import { Toast } from "./Toast";

const RAIL_LIMIT = 10;
const GRID_LIMIT = 24; // frozen: storefront grid page size
const TOAST_MS = 2200;

interface GridView {
	products: Product[];
	kicker?: string;
	title: string;
}

/** Home shows the grid + stacked rails; product shows the PDP for one item. */
type View = { kind: "browse" } | { kind: "product"; product: Product };

/** The PDP hash route ("#/p/<productId>"); any other hash means browse. */
const PDP_HASH = /^#\/p\/(.+)$/;

/**
 * Resolve the product a location hash points at, or null for the browse view.
 * Hash-based (not path-based) on purpose: a static host serves index.html for
 * every reload/deep link with zero server routing config, keeping the app
 * fully backend-free and offline-capable.
 */
function productFromHash(hash: string): Product | null {
	const id = PDP_HASH.exec(hash)?.[1];
	if (id === undefined) {
		return null;
	}
	const decoded = decodeURIComponent(id);
	return catalog().find((product) => product.id === decoded) ?? null;
}

/** True when the current history entry is a PDP entry this app pushed. */
function isAppPdpEntry(): boolean {
	const state: unknown = window.history.state;
	return (
		typeof state === "object" &&
		state !== null &&
		(state as { nimbusPdp?: unknown }).nimbusPdp === true
	);
}

/**
 * Empty results for a rail spec the engine returned nothing for (degrade). An
 * engine throw is REPORTED through `onError` (the app's error banner) before we
 * degrade, so a real fault (e.g. a fail-closed malformed-bundle error) is
 * user-visible — while the empty-rail UX means one bad rail never crashes the
 * page. A legitimately-empty co-occurrence rail resolves with `results: []`
 * and never lands here, so it isn't reported.
 */
async function loadRail(
	strategy: string,
	label: string,
	onError: (err: unknown) => void,
): Promise<RailData> {
	try {
		const res = await recommendStrategy(strategy, { limit: RAIL_LIMIT });
		return { spec: { strategy, label }, results: res.results };
	} catch (err) {
		onError(err);
		return { spec: { strategy, label }, results: [] };
	}
}

/**
 * Guarded vector-rail fetch: a throw hides the rail upstream. The throw is
 * REPORTED through `onError` (the error banner) before degrading so a real
 * engine fault is user-visible; an empty result is a normal value (resolves,
 * never throws) and is NOT reported — a cold/co-occurrence-less seed just
 * yields no rail.
 */
async function safeResults(
	run: () => Promise<{ results: SearchResult[] }>,
	onError: (err: unknown) => void,
): Promise<SearchResult[]> {
	try {
		return (await run()).results;
	} catch (err) {
		onError(err);
		return [];
	}
}

/**
 * The Nimbus storefront. Mounted only once the engine has bootstrapped, so its
 * data effects run against a ready in-tab engine — there is no network here:
 * search/recommend/browse run in-tab, and a click folds into the in-tab session
 * profile so the For-You rail re-ranks immediately (the demo's hero loop).
 * Clicking a product also opens the PDP seeded with that product's vector
 * rails, pushing a `#/p/<id>` hash entry (no router library) so the browser's
 * Back stays in-app and a reload restores the view — while the taste profile
 * itself survives reloads via the durable in-browser log (signals/tasteLog.ts).
 */
export function Storefront() {
	const { t } = useTranslation("storefront");
	const [query, setQuery] = useState("");
	const debouncedQuery = useDebounced(query, 300);
	const [activeCategory, setActiveCategory] = useState<string | null>(null);
	const [categories, setCategories] = useState<string[]>([]);

	const [grid, setGrid] = useState<GridView>(() => ({
		products: [],
		kicker: t("grid.kickerCatalog"),
		title: t("grid.titleBrowse"),
	}));
	const [gridLoading, setGridLoading] = useState(true);

	const [view, setView] = useState<View>({ kind: "browse" });
	const [rails, setRails] = useState<RailData[]>([]);
	const [pdpRails, setPdpRails] = useState<PdpRail[]>([]);
	const strategyMap = useRef<Record<string, Strategy>>({});
	const [proofEvidence] = useState(rankingProofEvidence);

	// Explicit signals (click | favorite | cart) counted app-side: the engine's
	// parity-locked clickCount only counts clicks, and the badge + cold-start
	// gate must also register favorites/carts. Ambient views never count here.
	// Starts at the count bootstrap replayed from the durable taste log, so the
	// badge stays honest across a reload (taste persisted ⇒ badge persists).
	const [sessionSignals, setSessionSignals] = useState(() =>
		replayedSignalCount(),
	);
	const [cartCount, setCartCount] = useState(0);
	const [favoritedIds, setFavoritedIds] = useState<ReadonlySet<string>>(
		new Set(),
	);
	const [personalizing, setPersonalizing] = useState(false);

	const [error, setError] = useState<string | null>(null);
	const [toast, setToast] = useState<string | null>(null);
	const toastTimer = useRef<number | undefined>(undefined);
	// Monotonic id for grid loads: a slow older search must not clobber a newer
	// one that already resolved (typing "de" then "desk" races two in-flight queries).
	const gridRequest = useRef(0);

	// The engine's own message verbatim when present, else the translated
	// "Unexpected error" fallback — the on-screen copy the error banner renders.
	const toErrorMessage = useCallback(
		(err: unknown): string =>
			err instanceof Error ? err.message : t("banner.unexpectedError"),
		[t],
	);

	// A degraded rail's fault lands in the same banner as every other engine
	// error — surfaced, retryable, and never page-crashing.
	const reportRailError = useCallback(
		(err: unknown) => setError(toErrorMessage(err)),
		[toErrorMessage],
	);

	const refreshRails = useCallback(async () => {
		setPersonalizing(true);
		try {
			const specs = homeRails(strategyMap.current);
			setRails(
				await Promise.all(
					specs.map((s) => loadRail(s.strategy, s.label, reportRailError)),
				),
			);
		} catch (err) {
			setError(toErrorMessage(err));
		} finally {
			setPersonalizing(false);
		}
	}, [toErrorMessage, reportRailError]);

	const loadPdpRails = useCallback(
		async (product: Product) => {
			const map = strategyMap.current;
			const similarLabel = map.similar_items?.label ?? "Similar items";
			const becauseLabel =
				map.because_viewed?.label ?? "Because you viewed this";
			// Co-occurrence rails (FBT first, also-bought second) — seed-driven, so a
			// cold/co-occurrence-less seed yields empty results and the rail is hidden.
			const [fbtSpec, alsoBoughtSpec] = coBuyRails(map);
			const [fbt, alsoBought, similarItems, because, trending] =
				await Promise.all([
					safeResults(
						() =>
							recommendStrategy("frequently_bought_together", {
								seed: product.id,
								limit: RAIL_LIMIT,
							}),
						reportRailError,
					),
					safeResults(
						() =>
							recommendStrategy("also_bought", {
								seed: product.id,
								limit: RAIL_LIMIT,
							}),
						reportRailError,
					),
					safeResults(
						() => similar(product.id, { limit: RAIL_LIMIT }),
						reportRailError,
					),
					safeResults(
						() =>
							recommendStrategy("because_viewed", {
								seed: product.id,
								limit: RAIL_LIMIT,
							}),
						reportRailError,
					),
					safeResults(
						() => recommendStrategy("trending", { limit: RAIL_LIMIT }),
						reportRailError,
					),
				]);
			setPdpRails([
				// "Frequently bought together" sits high, just below the hero.
				{
					key: "frequently_bought_together",
					label: fbtSpec?.label ?? "Frequently bought together",
					results: fbt,
				},
				{ key: "similar_items", label: similarLabel, results: similarItems },
				// "Customers who bought this also bought" below the similar rail.
				{
					key: "also_bought",
					label:
						alsoBoughtSpec?.label ?? "Customers who bought this also bought",
					results: alsoBought,
				},
				{ key: "because_viewed", label: becauseLabel, results: because },
				{
					key: "trending_category",
					label: trendingInCategoryLabel(product),
					results: trending.filter(
						(r) => r.product.category === product.category,
					),
				},
			]);
		},
		[reportRailError],
	);

	const loadGrid = useCallback(async () => {
		const seq = gridRequest.current + 1;
		gridRequest.current = seq;
		setGridLoading(true);
		setError(null);
		try {
			const next = await loadGridInner(debouncedQuery, activeCategory, t);
			// Latest-wins: drop a stale result whose newer query already landed.
			if (seq !== gridRequest.current) return;
			setCategories(next.categories);
			setGrid(next.grid);
		} catch (err) {
			// A superseded query's failure is not the current view — swallow it.
			if (seq === gridRequest.current) setError(toErrorMessage(err));
		} finally {
			// Only the latest request owns the loading flag.
			if (seq === gridRequest.current) setGridLoading(false);
		}
	}, [debouncedQuery, activeCategory, t, toErrorMessage]);

	useEffect(() => {
		void loadGrid();
	}, [loadGrid]);

	useEffect(() => {
		strategyMap.current = strategies();
		void refreshRails();
	}, [refreshRails]);

	useEffect(() => {
		return () => window.clearTimeout(toastTimer.current);
	}, []);

	// Live metrics: Storefront mounts only once the engine is ready, so now() is a
	// sound `readyAt` for the post-sync backend-call observer. We also record the
	// catalog size here (the engine's ntotal) — honest because the engine is ready.
	useEffect(() => {
		const stop = startMetricsObservers({
			readyAt: performance.now(),
			edgeOrigin: new URL(resolveBundleBaseUrl()).origin,
			appOrigin: window.location.origin,
		});
		void catalogInfo().then(({ count }) => record({ productCount: count }));
		return stop;
	}, []);

	const flashToast = useCallback((message: string) => {
		setToast(message);
		window.clearTimeout(toastTimer.current);
		toastTimer.current = window.setTimeout(() => setToast(null), TOAST_MS);
	}, []);

	const emitExplicit = useCallback(
		async (eventType: EventType, product: Product): Promise<boolean> => {
			try {
				const { emitted, message } = await emitInteraction(eventType, product);
				if (!emitted) return false;
				if (message !== null) flashToast(message);
				setSessionSignals((n) => n + 1);
				await refreshRails();
				return true;
			} catch (err) {
				setError(toErrorMessage(err));
				return false;
			}
		},
		[refreshRails, flashToast, toErrorMessage],
	);

	// Open the PDP view. `pushEntry` distinguishes a user navigation (push a
	// real history entry so the browser's Back stays in-app) from a restore
	// (deep link / popstate, where the entry already exists).
	const openProduct = useCallback(
		(product: Product, pushEntry: boolean) => {
			setPdpRails([]);
			setView({ kind: "product", product });
			if (pushEntry) {
				window.history.pushState(
					{ nimbusPdp: true },
					"",
					`#/p/${encodeURIComponent(product.id)}`,
				);
			}
			window.scrollTo({ top: 0 });
			void loadPdpRails(product);
		},
		[loadPdpRails],
	);

	// A pick records the click (so For You keeps learning + last_viewed is set)
	// AND opens the PDP seeded with this product's vector rails.
	const onPick = useCallback(
		async (product: Product) => {
			await emitExplicit("click", product);
			openProduct(product, true);
		},
		[emitExplicit, openProduct],
	);

	// The browser's Back/Forward stays in-app: derive the view from the hash.
	// No document unload happens, so the live profile (and the rails) survive.
	useEffect(() => {
		const onPopState = () => {
			const product = productFromHash(window.location.hash);
			if (product === null) {
				setView({ kind: "browse" });
			} else {
				openProduct(product, false);
			}
		};
		window.addEventListener("popstate", onPopState);
		return () => window.removeEventListener("popstate", onPopState);
	}, [openProduct]);

	// Reload/deep-link restore: a #/p/<id> hash at mount reopens that PDP.
	// The taste itself was already replayed from the durable log by bootstrap;
	// restoring a view is not an interaction, so nothing is emitted here.
	const restoredFromHash = useRef(false);
	useEffect(() => {
		if (restoredFromHash.current) {
			return;
		}
		restoredFromHash.current = true;
		const product = productFromHash(window.location.hash);
		if (product !== null) {
			openProduct(product, false);
		}
	}, [openProduct]);

	const onBack = useCallback(() => {
		// A PDP entry we pushed pops via real history (Back/Forward symmetric);
		// a deep-linked PDP (first entry, nothing of ours to pop) swaps to
		// browse in place so Back never exits the app unexpectedly.
		if (isAppPdpEntry()) {
			window.history.back();
		} else {
			setView({ kind: "browse" });
			window.history.replaceState(null, "", "#/");
		}
	}, []);

	// Clear the durable taste log + live profile + signal caps, then re-rank
	// the rails against the now-empty profile (back to the popularity baseline).
	const onResetTaste = useCallback(async () => {
		try {
			await resetSession();
			resetSignalCaps();
			setSessionSignals(0);
			setFavoritedIds(new Set());
			flashToast(t("rail.tasteReset"));
			await refreshRails();
		} catch (err) {
			setError(toErrorMessage(err));
		}
	}, [flashToast, refreshRails, t, toErrorMessage]);

	const onFavorite = useCallback(
		async (product: Product) => {
			const wasFavorited = favoritedIds.has(product.id);
			setFavoritedIds((prev) => toggle(prev, product.id, wasFavorited));
			// Unfavoriting is visual-only: negative signals are deferred (spec).
			if (!wasFavorited) await emitExplicit("favorite", product);
		},
		[favoritedIds, emitExplicit],
	);

	const onAddToCart = useCallback(
		async (product: Product) => {
			if (await emitExplicit("cart", product)) setCartCount((n) => n + 1);
		},
		[emitExplicit],
	);

	const onDwell = useCallback(
		(product: Product) => {
			// Ambient impression: silent, uncounted, and failures never surface —
			// a missed view must not interrupt browsing.
			void emitInteraction("view", product)
				.then((outcome) => (outcome.emitted ? refreshRails() : undefined))
				.catch(() => undefined);
		},
		[refreshRails],
	);
	const registerDwell = useDwellViews(onDwell);

	const onSelectCategory = useCallback(
		(category: string | null) => {
			setQuery("");
			setActiveCategory(category);
			if (view.kind === "product") {
				// Leaving the PDP forward (not via Back): land a browse entry so
				// the hash matches the view and Back still returns to the PDP.
				window.history.pushState(null, "", "#/");
			}
			setView({ kind: "browse" });
		},
		[view.kind],
	);

	// When a search query is active, surface its results at the TOP of the shop —
	// the "Search results" grid (with a screen-reader "Results for …" announcement)
	// pinned right under the search box — with the personalized rails sliding below. Without this a query paints
	// a 4th section beneath three unchanged rails and reads as if nothing happened.
	const searchedQuery = debouncedQuery.trim();
	const isSearching = searchedQuery !== "";
	const wasSearchingRef = useRef(false);
	useEffect(() => {
		if (isSearching && !wasSearchingRef.current) {
			// Entering search from browse: pull the freshly-surfaced results up.
			window.scrollTo({ top: 0, behavior: "smooth" });
		}
		wasSearchingRef.current = isSearching;
	}, [isSearching]);

	const railStack = (
		<RailStack
			rails={rails}
			proofEvidence={proofEvidence}
			onPick={onPick}
			personalizing={personalizing}
			signalCount={sessionSignals}
			onResetTaste={onResetTaste}
		/>
	);
	const productGrid = (
		<ProductGrid
			products={grid.products}
			{...(grid.kicker === undefined ? {} : { kicker: grid.kicker })}
			title={grid.title}
			loading={gridLoading}
			onPick={onPick}
			onFavorite={onFavorite}
			onAddToCart={onAddToCart}
			favoritedIds={favoritedIds}
			registerDwell={registerDwell}
		/>
	);

	return (
		<>
			<Header
				query={query}
				onQueryChange={setQuery}
				categories={categories}
				activeCategory={activeCategory}
				onSelectCategory={onSelectCategory}
				cartCount={cartCount}
			/>

			<MetricsStrip />

			{/* Browse gets a modifier: its grid (the page h1) precedes the rails in
			    DOM order for a sound heading outline, while CSS `order` keeps the
			    visual stack (rails above grid) unchanged. */}
			<main
				className={
					view.kind === "browse" && !isSearching ? "shop shop--browse" : "shop"
				}
			>
				{error !== null && (
					<div className="banner banner--error" role="alert">
						<div className="banner__title">{t("banner.title")}</div>
						<div>{error}</div>
						<button
							type="button"
							className="banner__retry"
							onClick={() => {
								void loadGrid();
								void refreshRails();
							}}
						>
							{t("banner.retry")}
						</button>
					</div>
				)}

				{view.kind === "product" ? (
					<ProductDetail
						product={view.product}
						rails={pdpRails}
						proofEvidence={proofEvidence}
						onBack={onBack}
						onPick={onPick}
					/>
				) : isSearching ? (
					<>
						{/* Screen-reader-only announcement: sighted shoppers see the query
						    in the search box; a second visible copy only pushed products
						    below the fold on phones. */}
						<div
							className="results-cue visually-hidden"
							role="status"
							aria-live="polite"
						>
							{t("grid.resultsFor", { query: searchedQuery })}
						</div>
						{productGrid}
						{railStack}
					</>
				) : (
					<>
						{productGrid}
						{railStack}
					</>
				)}
			</main>

			<StorageBadge durable={tasteDurable()} />

			<Toast message={toast} />
		</>
	);
}

/** Toggle a product id in a readonly set without mutating it. */
function toggle(
	set: ReadonlySet<string>,
	id: string,
	present: boolean,
): ReadonlySet<string> {
	const next = new Set(set);
	if (present) next.delete(id);
	else next.add(id);
	return next;
}

/** The categories + grid a query/category resolves to (computed, not yet applied). */
interface GridResult {
	categories: string[];
	grid: GridView;
}

/**
 * Compute the grid + category list for the current query/category. Pure of state
 * writes so the caller can apply the result under a latest-wins guard — a stale
 * older query that resolves late is dropped rather than clobbering newer results.
 */
async function loadGridInner(
	debouncedQuery: string,
	activeCategory: string | null,
	t: TFunction,
): Promise<GridResult> {
	const trimmed = debouncedQuery.trim();
	if (trimmed !== "") {
		const res = await search(trimmed, { limit: GRID_LIMIT });
		const products = res.results.map((r) => r.product);
		return {
			categories: deriveCategories(products),
			grid: {
				products,
				// The query already sits in the search box; the title only labels the
				// view, so the shopper reads the query once (no kicker/title echo).
				title: t("grid.titleSearch"),
			},
		};
	}
	const res = await browse(
		activeCategory === null
			? { limit: GRID_LIMIT }
			: { limit: GRID_LIMIT, category: activeCategory },
	);
	return {
		categories: res.categories,
		grid: {
			products: res.products,
			kicker: t("grid.kickerCatalog"),
			title: activeCategory ?? t("grid.titleBrowse"),
		},
	};
}

/** Stable, sorted category list from a product set (used for search views). */
function deriveCategories(products: Product[]): string[] {
	return [...new Set(products.map((p) => p.category))].sort((a, b) =>
		a.localeCompare(b),
	);
}
