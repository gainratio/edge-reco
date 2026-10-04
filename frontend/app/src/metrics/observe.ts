// Live observers that feed the metrics store from real browser signals:
//   - PerformanceObserver on "resource" entries -> count POST-READY backend calls
//     (edge/other), excluding 3rd-party product images and the optional uplink
//     beacon. In the normal backend-free demo this stays 0 after sync.
//   - The Worker network sentinel -> the SAME count, over the traffic of every
//     Worker the engine owns. A Worker keeps its own resource-timing timeline,
//     so the observer above is blind to it: without this the counter would keep
//     reading 0 while a request left the browser from inside the pipeline. Each
//     Worker publishes its own view; entries arrive on the shared epoch clock
//     and are rebased onto this context's timeline before they are counted.
//   - A ~1s memory poll -> main-thread JS heap (Chromium-only via
//     performance.memory). Left null on non-Chromium — never fabricated.
//
// All wiring is guarded so unsupported browsers (no PerformanceObserver, no
// BroadcastChannel, no performance.memory) degrade silently rather than throw.

import {
	isNetworkSentinelReport,
	NETWORK_SENTINEL_CHANNEL,
} from "@gainratio/browser";
import { classifyResource } from "./classify";
import { record } from "./store";

const MEMORY_POLL_MS = 1000;
const BYTES_PER_MB = 1024 * 1024;
/** Source key for this context's own entries in the merged count. */
const WINDOW_SOURCE = "window";

export interface ObserveOptions {
	/** performance.now() captured when the engine became ready. */
	readonly readyAt: number;
	/** The signed-bundle CDN origin (VITE_BUNDLE_BASE_URL). */
	readonly edgeOrigin: string;
	/** The optional analytics uplink URL (VITE_EVENTS_URL); may be undefined. */
	readonly eventsUrl?: string | null | undefined;
	/** The app's own origin; release-owned static assets are not backend calls. */
	readonly appOrigin?: string | null | undefined;
}

/** The slice of a PerformanceResourceTiming the counter actually reads. */
export interface ResourceEntryLike {
	readonly name: string;
	readonly startTime: number;
}

/** Merge one context's full view of its own traffic into the running count. */
type CountSink = (
	source: string,
	entries: readonly ResourceEntryLike[],
) => void;

/**
 * Runtime guard from the raw `PerformanceEntry[]` the browser hands the observer
 * to the {name, startTime} slice the counter reads. Unlike the signed-bundle
 * vectorIndex path (which fails CLOSED), this reads LIVE, untrusted browser
 * objects, so its contract is DEGRADE-and-skip: an entry missing either read
 * field — or of the wrong type — is dropped, never thrown on. Throwing here would
 * escape the PerformanceObserver callback and break metrics in odd browsers,
 * which is exactly what `startMetricsObservers` promises never to do.
 */
export function toResourceEntries(
	raw: readonly unknown[],
): readonly ResourceEntryLike[] {
	const out: ResourceEntryLike[] = [];
	for (const entry of raw) {
		if (typeof entry !== "object" || entry === null) {
			continue;
		}
		const { name, startTime } = entry as Record<string, unknown>;
		if (typeof name === "string" && typeof startTime === "number") {
			out.push({ name, startTime });
		}
	}
	return out;
}

/**
 * Pure counting helper (unit-tested directly). Given the resource entries seen
 * so far and the classify options, return the count of entries that represent a
 * real backend call: classified "edge" or "other", and starting at/after
 * `readyAt`. Static assets, images, and the uplink beacon are excluded;
 * pre-ready entries (the sync itself, the model fetch) are ignored.
 */
export function countBackendCalls(
	entries: readonly ResourceEntryLike[],
	opts: ObserveOptions,
): number {
	let count = 0;
	for (const entry of entries) {
		if (entry.startTime < opts.readyAt) {
			continue;
		}
		const bucket = classifyResource(entry.name, {
			edgeOrigin: opts.edgeOrigin,
			eventsUrl: opts.eventsUrl ?? null,
			appOrigin: opts.appOrigin ?? null,
		});
		if (bucket === "edge" || bucket === "other") {
			count += 1;
		}
	}
	return count;
}

/**
 * Runtime guard from a sentinel report's entries — same DEGRADE-and-skip
 * contract as {@link toResourceEntries}, and equally untrusted: the channel is
 * same-origin, which is not the same as trustworthy. Each entry's shared-clock
 * `startedAtEpochMs` is rebased onto this context's `performance.now()`
 * timeline so it is comparable with `readyAt`.
 */
export function toWindowEntries(
	raw: readonly unknown[],
	timeOrigin: number,
): readonly ResourceEntryLike[] {
	const out: ResourceEntryLike[] = [];
	for (const entry of raw) {
		if (typeof entry !== "object" || entry === null) {
			continue;
		}
		const { name, startedAtEpochMs } = entry as Record<string, unknown>;
		if (typeof name === "string" && typeof startedAtEpochMs === "number") {
			out.push({ name, startTime: startedAtEpochMs - timeOrigin });
		}
	}
	return out;
}

/** Narrow type for the Chromium-only `performance.memory` extension. */
type MemoryPerformance = Performance & {
	memory?: { usedJSHeapSize: number };
};

function readHeapMb(): number | null {
	if (typeof performance === "undefined") {
		return null;
	}
	const memory = (performance as MemoryPerformance).memory;
	if (memory === undefined) {
		return null;
	}
	return Math.round((memory.usedJSHeapSize / BYTES_PER_MB) * 10) / 10;
}

/**
 * Start the live metrics observers. Returns a cleanup function that disconnects
 * the observer and clears the memory poll. Safe to call in environments missing
 * PerformanceObserver/performance — it no-ops the unsupported parts.
 */
export function startMetricsObservers(opts: ObserveOptions): () => void {
	const count = createCountSink(opts);
	const stopResources = startResourceObserver(count);
	const stopSentinel = startWorkerSentinelReader(count);
	const stopMemory = startMemoryPoll();
	return () => {
		stopResources();
		stopSentinel();
		stopMemory();
	};
}

/**
 * One running total across every reporting context. Each source publishes its
 * FULL current view, so a report replaces that source's slice rather than
 * accumulating — which keeps the count correct however flushes batch.
 */
function createCountSink(opts: ObserveOptions): CountSink {
	const bySource = new Map<string, readonly ResourceEntryLike[]>();
	return (source, entries) => {
		bySource.set(source, entries);
		const all = Array.from(bySource.values()).flat();
		record({ backendCalls: countBackendCalls(all, opts) });
	};
}

function startResourceObserver(count: CountSink): () => void {
	if (typeof PerformanceObserver === "undefined") {
		return () => {};
	}
	// getEntriesByType returns the full buffered list, so each flush republishes
	// this context's whole view.
	const observer = new PerformanceObserver(() => {
		count(
			WINDOW_SOURCE,
			toResourceEntries(performance.getEntriesByType("resource")),
		);
	});
	observer.observe({ type: "resource", buffered: true });
	return () => observer.disconnect();
}

/**
 * Read the Workers' network reports. This is what closes the blind spot: the
 * window's PerformanceObserver above can never see a Worker's fetches, so
 * without this the tile would keep reading 0 while the pipeline talked to the
 * network.
 */
function startWorkerSentinelReader(count: CountSink): () => void {
	if (
		typeof BroadcastChannel === "undefined" ||
		typeof performance === "undefined"
	) {
		return () => {};
	}
	const channel = new BroadcastChannel(NETWORK_SENTINEL_CHANNEL);
	channel.onmessage = (event: MessageEvent<unknown>) => {
		const report = event.data;
		if (!isNetworkSentinelReport(report)) {
			return;
		}
		count(
			report.context,
			toWindowEntries(report.entries, performance.timeOrigin),
		);
	};
	return () => channel.close();
}

function startMemoryPoll(): () => void {
	const initial = readHeapMb();
	if (initial === null) {
		return () => {};
	}
	record({ heapMb: initial });
	const id = setInterval(() => {
		const heapMb = readHeapMb();
		if (heapMb !== null) {
			record({ heapMb });
		}
	}, MEMORY_POLL_MS);
	return () => clearInterval(id);
}
