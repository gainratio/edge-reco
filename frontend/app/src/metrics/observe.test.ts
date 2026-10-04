// The PerformanceObserver wiring is hard to drive in jsdom, so the per-entry
// counting is factored into the pure `countBackendCalls` helper and tested here
// directly: edge/other count, image/uplink don't, pre-readyAt entries are
// ignored, and unparseable URLs fall through to "other" (i.e. counted).

import {
	NETWORK_SENTINEL_REPORT_KIND,
	type NetworkSentinelReport,
} from "@gainratio/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	countBackendCalls,
	type ObserveOptions,
	startMetricsObservers,
	toResourceEntries,
	toWindowEntries,
} from "./observe";
import { record } from "./store";

// The live wiring (startMetricsObservers) records into the metrics store; mock
// it so we can assert on what the observer + memory poll push without touching
// the real singleton.
vi.mock("./store", () => ({ record: vi.fn() }));

const READY_AT = 100;
const OPTS: ObserveOptions = {
	readyAt: READY_AT,
	edgeOrigin: "https://cdn.example.com",
	eventsUrl: "https://events.example.com/events",
	appOrigin: "http://localhost:4173",
};

function entry(name: string, startTime: number) {
	return { name, startTime };
}

describe("countBackendCalls", () => {
	it("counts edge-origin requests as backend calls", () => {
		const entries = [entry("https://cdn.example.com/latest", 150)];
		expect(countBackendCalls(entries, OPTS)).toBe(1);
	});

	it("counts unknown ('other') origins as backend calls", () => {
		const entries = [entry("https://api.somewhere.com/infer", 150)];
		expect(countBackendCalls(entries, OPTS)).toBe(1);
	});

	it("does NOT count product images", () => {
		const entries = [entry("https://m.media-amazon.com/images/I/abc.jpg", 150)];
		expect(countBackendCalls(entries, OPTS)).toBe(0);
	});

	it("does NOT count same-origin /images/ local product assets", () => {
		// Baked-in bundle images served same-origin (/images/<id>.svg) are static
		// assets, not backend calls — the honest "0 after sync" headline must hold.
		const entries = [entry("http://localhost:4173/images/P1.svg", 150)];
		expect(countBackendCalls(entries, OPTS)).toBe(0);
	});

	it("counts only the backend call in the live PDP's same-origin resource batch", () => {
		// Production observation: opening a PDP can make Chromium fetch delayed
		// PWA/favicon assets after readyAt. Those are static release files, while a
		// same-origin API path is still a real backend call and must remain visible.
		const entries = [
			entry("http://localhost:4173/pwa-192x192.png", 150),
			entry("http://localhost:4173/favicon.svg", 151),
			entry("http://localhost:4173/favicon.ico", 152),
			entry("http://localhost:4173/api/recommendations", 153),
		];
		expect(countBackendCalls(entries, OPTS)).toBe(1);
	});

	it("DOES count a remote host's /images/ path — the local rule must not mask it", () => {
		// The security property behind the "0 backend calls" headline: only the app's
		// OWN origin may claim the /images/ shortcut. A third-party backend that simply
		// happens to serve an /images/ path must still be counted, or an exfiltration
		// call could hide behind an image-shaped URL and the strip would read a lie.
		const entries = [entry("https://api.evil.com/images/leak?d=1", 150)];
		expect(countBackendCalls(entries, OPTS)).toBe(1);
	});

	it("does NOT count the optional uplink beacon", () => {
		const entries = [entry("https://events.example.com/events", 150)];
		expect(countBackendCalls(entries, OPTS)).toBe(0);
	});

	it("ignores entries that started before readyAt", () => {
		const entries = [
			entry("https://cdn.example.com/sync-during-boot", 50),
			entry("https://api.elsewhere.com/boot", 99),
		];
		expect(countBackendCalls(entries, OPTS)).toBe(0);
	});

	it("counts an entry exactly at readyAt (inclusive boundary)", () => {
		const entries = [entry("https://cdn.example.com/latest", READY_AT)];
		expect(countBackendCalls(entries, OPTS)).toBe(1);
	});

	it("sums a mixed batch: only post-ready edge/other count", () => {
		const entries = [
			entry("https://cdn.example.com/manifest", 200), // edge  -> count
			entry("https://m.media-amazon.com/x.jpg", 210), // image -> skip
			entry("https://events.example.com/events", 220), // uplink -> skip
			entry("https://api.foo.com/infer", 230), // other -> count
			entry("https://cdn.example.com/early", 10), // pre-ready -> skip
		];
		expect(countBackendCalls(entries, OPTS)).toBe(2);
	});
});

// `toResourceEntries` is the runtime guard between the raw PerformanceEntry[]
// the browser hands the observer and the {name, startTime} slice the counter
// reads. Its contract is DEGRADE-and-skip, never throw: a malformed entry (the
// two read fields missing or the wrong type) is dropped, valid ones pass through.
describe("toResourceEntries", () => {
	it("passes valid entries through unchanged", () => {
		const raw = [
			{ name: "https://cdn.example.com/latest", startTime: 150 },
			{ name: "https://api.foo.com/infer", startTime: 230 },
		];
		expect(toResourceEntries(raw)).toEqual(raw);
	});

	it("skips entries with a non-string name", () => {
		const raw = [
			{ name: 42, startTime: 150 },
			{ name: "https://cdn.example.com/ok", startTime: 200 },
		];
		expect(toResourceEntries(raw)).toEqual([
			{ name: "https://cdn.example.com/ok", startTime: 200 },
		]);
	});

	it("skips entries with a non-number startTime", () => {
		const raw = [
			{ name: "https://cdn.example.com/bad", startTime: "soon" },
			{ name: "https://cdn.example.com/ok", startTime: 200 },
		];
		expect(toResourceEntries(raw)).toEqual([
			{ name: "https://cdn.example.com/ok", startTime: 200 },
		]);
	});

	it("skips entries missing a read field", () => {
		const raw = [
			{ name: "https://cdn.example.com/no-time" },
			{ startTime: 150 },
		];
		expect(toResourceEntries(raw)).toEqual([]);
	});

	it("skips non-object / nullish entries and never throws", () => {
		const raw = [
			null,
			undefined,
			"x",
			7,
			{ name: "https://ok.com", startTime: 1 },
		];
		expect(toResourceEntries(raw)).toEqual([
			{ name: "https://ok.com", startTime: 1 },
		]);
	});

	it("returns an empty list (not a throw) for an all-malformed batch", () => {
		expect(() => toResourceEntries([null, { name: 1 }, {}])).not.toThrow();
		expect(toResourceEntries([null, { name: 1 }, {}])).toEqual([]);
	});
});

// `startMetricsObservers` is the live wiring the pure helpers feed: a
// PerformanceObserver over "resource" entries plus a ~1s memory poll. It must
// degrade silently where the browser APIs are missing and return a cleanup that
// disconnects both. We stub the globals so jsdom can drive both branches.
type HeapPerformance = Performance & { memory?: { usedJSHeapSize: number } };

class FakeObserver {
	static instances: FakeObserver[] = [];
	observe = vi.fn();
	disconnect = vi.fn();
	readonly flush: () => void;
	constructor(flush: () => void) {
		this.flush = flush;
		FakeObserver.instances.push(this);
	}
}

function setHeapBytes(bytes: number | null): void {
	const perf = performance as HeapPerformance;
	if (bytes === null) {
		delete perf.memory;
	} else {
		perf.memory = { usedJSHeapSize: bytes };
	}
}

const LIVE_OPTS: ObserveOptions = {
	readyAt: 0,
	edgeOrigin: "https://cdn.example.com",
	eventsUrl: null,
};

describe("startMetricsObservers", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		FakeObserver.instances = [];
		vi.mocked(record).mockReset();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		setHeapBytes(null);
	});

	it("subscribes a resource observer + memory poll and cleans both up", () => {
		vi.stubGlobal("PerformanceObserver", FakeObserver);
		vi.spyOn(performance, "getEntriesByType").mockReturnValue([
			{ name: "https://cdn.example.com/manifest", startTime: 5 },
		] as unknown as PerformanceEntryList);
		setHeapBytes(50 * 1024 * 1024); // 50 MB

		const stop = startMetricsObservers(LIVE_OPTS);

		const observer = FakeObserver.instances[0];
		expect(observer?.observe).toHaveBeenCalledWith({
			type: "resource",
			buffered: true,
		});
		// Initial heap sample recorded on start.
		expect(vi.mocked(record)).toHaveBeenCalledWith({ heapMb: 50 });

		// A flush recomputes the running post-ready backend-call total.
		observer?.flush();
		expect(vi.mocked(record)).toHaveBeenCalledWith({ backendCalls: 1 });

		// The poll re-samples the heap every second.
		setHeapBytes(60 * 1024 * 1024);
		vi.advanceTimersByTime(1000);
		expect(vi.mocked(record)).toHaveBeenCalledWith({ heapMb: 60 });

		// Cleanup disconnects the observer and stops the poll.
		stop();
		expect(observer?.disconnect).toHaveBeenCalledOnce();
		vi.mocked(record).mockClear();
		vi.advanceTimersByTime(3000);
		expect(vi.mocked(record)).not.toHaveBeenCalled();
	});

	it("degrades silently when PerformanceObserver + performance.memory are absent", () => {
		vi.stubGlobal("PerformanceObserver", undefined);
		setHeapBytes(null);

		const stop = startMetricsObservers(LIVE_OPTS);

		expect(FakeObserver.instances).toHaveLength(0);
		// No heap sample is fabricated when performance.memory is missing.
		expect(vi.mocked(record)).not.toHaveBeenCalled();
		expect(() => stop()).not.toThrow();
	});
});

// `toWindowEntries` rebases a Worker's report onto THIS context's timeline.
// Every context has its own `timeOrigin`, so a Worker's raw `startTime` is
// meaningless here — reports travel on the shared epoch clock and land back on
// `performance.now()` time, which is what `readyAt` is measured in.
describe("toWindowEntries", () => {
	const TIME_ORIGIN = 1_700_000_000_000;

	it("rebases epoch timestamps onto this context's timeline", () => {
		const raw = [
			{
				name: "https://api.foo.com/infer",
				startedAtEpochMs: TIME_ORIGIN + 900,
			},
		];
		expect(toWindowEntries(raw, TIME_ORIGIN)).toEqual([
			{ name: "https://api.foo.com/infer", startTime: 900 },
		]);
	});

	it("drops malformed entries instead of throwing", () => {
		const raw = [
			null,
			"nope",
			{ name: 1, startedAtEpochMs: TIME_ORIGIN },
			{ name: "https://ok.com/a" },
			{ name: "https://ok.com/b", startedAtEpochMs: TIME_ORIGIN + 5 },
		];
		expect(() => toWindowEntries(raw, TIME_ORIGIN)).not.toThrow();
		expect(toWindowEntries(raw, TIME_ORIGIN)).toEqual([
			{ name: "https://ok.com/b", startTime: 5 },
		]);
	});
});

// THE blind spot this whole seam exists to close. A Worker's fetches never
// appear in the window's resource timeline, so with an EMPTY window timeline
// the counter must still reach 1 from the Worker's report alone. If this can
// pass while the sentinel reader is gone, the counter is measuring the shape of
// the claim rather than the claim.
class ReaderChannel {
	static instances: ReaderChannel[] = [];
	onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
	readonly name: string;
	close = vi.fn();
	constructor(name: string) {
		this.name = name;
		ReaderChannel.instances.push(this);
	}
	deliver(data: unknown): void {
		this.onmessage?.({ data } as MessageEvent<unknown>);
	}
}

function workerReport(entries: readonly unknown[]): NetworkSentinelReport {
	return {
		kind: NETWORK_SENTINEL_REPORT_KIND,
		context: "embedder-worker",
		entries: entries as NetworkSentinelReport["entries"],
	};
}

describe("startMetricsObservers — Worker traffic", () => {
	const TIME_ORIGIN = 1_700_000_000_000;

	beforeEach(() => {
		vi.useFakeTimers();
		FakeObserver.instances = [];
		ReaderChannel.instances = [];
		vi.mocked(record).mockReset();
		vi.stubGlobal("PerformanceObserver", FakeObserver);
		vi.stubGlobal("BroadcastChannel", ReaderChannel);
		vi.spyOn(performance, "timeOrigin", "get").mockReturnValue(TIME_ORIGIN);
		// The window sees NOTHING — exactly the real situation for Worker traffic.
		vi.spyOn(performance, "getEntriesByType").mockReturnValue([]);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("counts a backend call a Worker made, invisible to the window", () => {
		const stop = startMetricsObservers(LIVE_OPTS);
		FakeObserver.instances[0]?.flush();
		expect(vi.mocked(record)).toHaveBeenCalledWith({ backendCalls: 0 });

		ReaderChannel.instances[0]?.deliver(
			workerReport([
				{
					name: "https://api.evil.com/exfil?q=user-query",
					startedAtEpochMs: TIME_ORIGIN + 500,
				},
			]),
		);

		expect(vi.mocked(record)).toHaveBeenLastCalledWith({ backendCalls: 1 });
		stop();
		expect(ReaderChannel.instances[0]?.close).toHaveBeenCalledOnce();
	});

	it("replaces a Worker's slice rather than accumulating across reports", () => {
		// Each report is that context's FULL current view, so re-reporting the
		// same request must not double-count it.
		startMetricsObservers(LIVE_OPTS);
		const entry = {
			name: "https://api.evil.com/exfil",
			startedAtEpochMs: TIME_ORIGIN + 500,
		};
		const channel = ReaderChannel.instances[0];

		channel?.deliver(workerReport([entry]));
		channel?.deliver(workerReport([entry]));

		expect(vi.mocked(record)).toHaveBeenLastCalledWith({ backendCalls: 1 });
	});

	it("sums distinct contexts and still excludes non-backend traffic", () => {
		startMetricsObservers(LIVE_OPTS);
		const channel = ReaderChannel.instances[0];

		channel?.deliver({
			kind: NETWORK_SENTINEL_REPORT_KIND,
			context: "engine-worker",
			entries: [
				{
					name: "https://cdn.example.com/chunk",
					startedAtEpochMs: TIME_ORIGIN + 10,
				},
			],
		});
		channel?.deliver(
			workerReport([
				{
					name: "https://api.foo.com/infer",
					startedAtEpochMs: TIME_ORIGIN + 20,
				},
				{
					name: "https://m.media-amazon.com/x.jpg",
					startedAtEpochMs: TIME_ORIGIN + 30,
				},
			]),
		);

		expect(vi.mocked(record)).toHaveBeenLastCalledWith({ backendCalls: 2 });
	});

	it("ignores a message that is not a sentinel report", () => {
		startMetricsObservers(LIVE_OPTS);
		vi.mocked(record).mockClear();

		ReaderChannel.instances[0]?.deliver({ kind: "something-else" });
		ReaderChannel.instances[0]?.deliver("hello");

		expect(vi.mocked(record)).not.toHaveBeenCalled();
	});

	it("degrades silently without BroadcastChannel", () => {
		vi.stubGlobal("BroadcastChannel", undefined);

		const stop = startMetricsObservers(LIVE_OPTS);

		expect(ReaderChannel.instances).toHaveLength(0);
		expect(() => stop()).not.toThrow();
	});
});
