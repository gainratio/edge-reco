import { useSyncExternalStore } from "react";

export interface CatalogSyncStats {
	readonly version: string;
	readonly chunksFetched: number;
	readonly chunksReused: number;
	readonly bytesFetched: number;
}

/**
 * Live metrics snapshot shown in the in-tab metrics UI.
 * All timing fields are `null` until the first measurement arrives.
 */
export interface MetricsSnapshot {
	/** Last search() round-trip latency, ms. */
	searchMs: number | null;
	/** Last recommend() round-trip latency, ms. */
	recommendMs: number | null;
	/** Engine boot → ready latency, ms. */
	coldStartMs: number | null;
	/** Main-thread JS heap size (Chromium performance.memory); null if unavailable. */
	heapMb: number | null;
	/** Catalog size (number of indexed products). */
	productCount: number | null;
	/** Count of post-sync same-origin/edge network calls. Starts at 0. */
	backendCalls: number;
	/** Latest signed catalog chunk/delta-sync statistics, or null before sync. */
	syncStats?: CatalogSyncStats | null;
}

const INITIAL_SNAPSHOT: MetricsSnapshot = {
	searchMs: null,
	recommendMs: null,
	coldStartMs: null,
	heapMb: null,
	productCount: null,
	backendCalls: 0,
	syncStats: null,
};

// ---- Singleton store state --------------------------------------------------

let current: MetricsSnapshot = { ...INITIAL_SNAPSHOT };
const listeners = new Set<() => void>();

// ---- Public API ------------------------------------------------------------

/**
 * Shallow-merge `patch` into the current snapshot and notify subscribers.
 * Creates a new snapshot object so React's `useSyncExternalStore` can detect
 * the change via reference equality.
 */
export function record(patch: Partial<MetricsSnapshot>): void {
	current = { ...current, ...patch };
	// Mirror to window for Playwright / DevTools inspection.
	if (typeof window !== "undefined") {
		window.__edgeprocMetrics = current;
	}
	for (const listener of listeners) {
		listener();
	}
}

/**
 * Return the current snapshot.
 * The reference is stable between `record()` calls, which satisfies
 * `useSyncExternalStore`'s requirement that the same reference be returned
 * when nothing has changed (preventing render loops).
 */
export function getSnapshot(): MetricsSnapshot {
	return current;
}

/**
 * Subscribe to snapshot changes. Returns an unsubscribe function.
 * Safe to call multiple times; safe to call the returned fn more than once.
 */
export function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

// ---- React hook ------------------------------------------------------------

/**
 * React hook: returns the live `MetricsSnapshot` and re-renders on changes.
 * Backed by `useSyncExternalStore` (React 18+) for concurrent-mode safety.
 */
export function useMetrics(): MetricsSnapshot {
	return useSyncExternalStore(subscribe, getSnapshot);
}

// ---- Window global declaration (mirrors client.ts pattern) -----------------

declare global {
	interface Window {
		__edgeprocMetrics?: MetricsSnapshot;
	}
}
