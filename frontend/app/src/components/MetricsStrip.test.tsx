// MetricsStrip renders LIVE values from the metrics store. The store is a
// singleton, so we record() known values, render, assert, then restore the
// original snapshot (mirrors the store.test.ts isolation pattern).

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getSnapshot, type MetricsSnapshot, record } from "../metrics/store";
import { MetricsStrip } from "./MetricsStrip";

describe("MetricsStrip", () => {
	let before: MetricsSnapshot;

	beforeEach(() => {
		before = getSnapshot();
	});

	afterEach(() => {
		cleanup();
		record(before);
	});

	it("renders live latency, backend calls, cold start, heap, and catalog", () => {
		record({
			recommendMs: 12.4,
			searchMs: 30,
			coldStartMs: 1850,
			heapMb: 42.7,
			productCount: 720,
			backendCalls: 0,
		});
		render(<MetricsStrip />);

		expect(screen.getByText("12 ms")).toBeInTheDocument(); // recommend latency
		expect(screen.getByText("0")).toBeInTheDocument(); // backend calls headline
		expect(screen.getByText("1.9 s")).toBeInTheDocument(); // cold start
		expect(screen.getByText("42.7 MB")).toBeInTheDocument(); // JS heap
		expect(screen.getByText("JS heap")).toBeInTheDocument();
		expect(screen.getByText("720")).toBeInTheDocument(); // catalog
	});

	it("falls back to searchMs for latency when recommend has not run", () => {
		record({ recommendMs: null, searchMs: 8 });
		render(<MetricsStrip />);
		expect(screen.getByText("8 ms")).toBeInTheDocument();
	});

	it("renders sub-ms recommend latency honestly as <1 ms", () => {
		record({ recommendMs: 0.4 });
		render(<MetricsStrip />);
		expect(screen.getByText("<1 ms")).toBeInTheDocument();
	});

	it("HIDES the JS heap tile when heapMb is null (non-Chromium)", () => {
		record({ heapMb: null });
		render(<MetricsStrip />);
		expect(screen.queryByText("JS heap")).not.toBeInTheDocument();
	});

	it("SHOWS the JS heap tile when heapMb is set", () => {
		record({ heapMb: 17.2 });
		render(<MetricsStrip />);
		expect(screen.getByText("JS heap")).toBeInTheDocument();
		expect(screen.getByText("17.2 MB")).toBeInTheDocument();
	});

	it("renders Patch applied when a delta sync updates some chunks and reuses cached chunks", () => {
		record({
			syncStats: {
				version: "v1",
				chunksFetched: 4,
				chunksReused: 56,
				bytesFetched: 120_000,
			},
		});
		render(<MetricsStrip />);
		expect(
			screen.getByText("Patch applied (4 new · 56 cached)"),
		).toBeInTheDocument();
		expect(screen.getByText("catalog sync")).toBeInTheDocument();
	});

	it("renders Cached when all catalog chunks were reused with zero fetches", () => {
		record({
			syncStats: {
				version: "v1",
				chunksFetched: 0,
				chunksReused: 60,
				bytesFetched: 0,
			},
		});
		render(<MetricsStrip />);
		expect(screen.getByText("Cached (60 chunks reused)")).toBeInTheDocument();
	});

	it("renders Synced on initial full catalog download", () => {
		record({
			syncStats: {
				version: "v1",
				chunksFetched: 60,
				chunksReused: 0,
				bytesFetched: 2_800_000,
			},
		});
		render(<MetricsStrip />);
		expect(screen.getByText("Synced (60 chunks)")).toBeInTheDocument();
	});
});
