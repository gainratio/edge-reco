import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import landingCopy from "../locales/en/landing.json";
import {
	BUNDLE_SIZE,
	CATALOG_PRODUCTS,
	LANDING_MEASURED_ON,
	LANDING_METRICS,
} from "./landing-figures";
import measurement from "./live-measurement.json";

const here = dirname(fileURLToPath(import.meta.url)); // …/frontend/app/src/metrics
const repoRoot = join(here, "../../../..");
const readme = () => readFileSync(join(repoRoot, "README.md"), "utf8");

/** Total bytes of every file under `dir`, recursively. */
const dirBytes = (dir: string): number =>
	readdirSync(dir, { withFileTypes: true }).reduce((sum, entry) => {
		const path = join(dir, entry.name);
		return sum + (entry.isDirectory() ? dirBytes(path) : statSync(path).size);
	}, 0);

/**
 * How far BUNDLE_SIZE may sit from the bundle's real byte count: ±10%.
 *
 * Rounding a real size to one decimal place ("1.5 MB") already costs up to
 * ±0.05 MB — about 3% here — so a tighter band would go red on a republish that
 * changed nothing meaningful. 10% still leaves headroom for ordinary chunk churn
 * while catching the failure that actually happened: the constant read "2.2 MB"
 * against a 1.5 MB bundle, ~45% high, and rendered that to users in two places.
 */
const BUNDLE_SIZE_TOLERANCE = 0.1;

const tile = (id: string) => {
	const found = LANDING_METRICS.find((m) => m.id === id);
	if (!found) throw new Error(`no landing tile with id "${id}"`);
	return found;
};

/** Median of the raw runs, computed here rather than trusted from the source. */
const median = (xs: readonly number[]): number => {
	const s = [...xs].sort((a, b) => a - b);
	// Odd length: lo === hi. An empty list yields NaN, which no tile test accepts.
	const lo = s[Math.floor((s.length - 1) / 2)] ?? Number.NaN;
	const hi = s[Math.ceil((s.length - 1) / 2)] ?? Number.NaN;
	return (lo + hi) / 2;
};

/** Every string leaf of a nested i18n catalog. */
const strings = (node: unknown): string[] =>
	typeof node === "string"
		? [node]
		: Object.values(node as Record<string, unknown>).flatMap(strings);

// Guard the representative catalog count against the committed bundle source, so
// the landing's "720" can't silently rot if the catalog ever changes. This is the
// single place the number is asserted true — every landing reference derives from it.
describe("landing-figures", () => {
	it("CATALOG_PRODUCTS matches the committed catalog source row count", () => {
		const csv = join(repoRoot, "backend/examples/source/catalog.csv");
		const dataRows = readFileSync(csv, "utf8").trim().split("\n").length - 1; // minus header
		expect(CATALOG_PRODUCTS).toBe(dataRows);
	});

	// Same idea as the count guard above, for the other figure tied to the committed
	// bundle. BUNDLE_SIZE renders to users twice (the catalog tile's sub-label and the
	// landing footnote) and was unguarded, so it drifted ~45% high without anything
	// failing. Measure the bundle instead of trusting the string.
	it("BUNDLE_SIZE matches the committed bundle's size on disk", () => {
		const measuredMb =
			dirBytes(join(repoRoot, "backend/examples/catalog")) / 1e6;
		const claimedMb = Number.parseFloat(BUNDLE_SIZE); // "1.5 MB" -> 1.5
		const drift = Math.abs(claimedMb - measuredMb) / measuredMb;
		expect(drift).toBeLessThanOrEqual(BUNDLE_SIZE_TOLERANCE);
	});

	it("exposes exactly six representative tiles", () => {
		expect(LANDING_METRICS).toHaveLength(6);
	});
});

// This repo once published THREE different values for the same three metrics —
// README.md, these tiles, and the live app all disagreed, and nothing failed.
// These tests make that specific silent drift impossible: the figures live here
// and only here, and they must stay in the neighbourhood of a real measurement.
describe("performance figures live in exactly one place", () => {
	it("README.md states no millisecond timing", () => {
		// The only `<n>ms` strings the README ever held were the perf claims.
		expect(readme().match(/\d+(\.\d+)?\s?ms\b/g)).toBeNull();
	});

	it("README.md states no JS heap size", () => {
		// Scoped to heap so legitimate artifact sizes ("~23 MB" model) still pass.
		const heapClaim =
			/heap[^.\n]*?\d+(\.\d+)?\s?(MB|MiB)|\d+(\.\d+)?\s?(MB|MiB)[^.\n]*?heap/i;
		expect(readme()).not.toMatch(heapClaim);
	});

	it("README.md states no cold-boot time", () => {
		const bootClaim =
			/cold (boot|start)[^.\n]*?\d+(\.\d+)?\s?s\b|\d+(\.\d+)?\s?s\b[^.\n]*?cold (boot|start)/i;
		expect(readme()).not.toMatch(bootClaim);
	});

	it("README.md pins no deployed commit SHA", () => {
		// It once claimed bcd1713… was deployed while a89e0ba… actually was. A SHA
		// goes stale on the very next deploy; build.json is the live answer.
		expect(readme().match(/\b[0-9a-f]{40}\b/g)).toBeNull();
	});
});

// The landing once said "~1.2 s" to first results. A real first visit to the live
// site took over twice that, because the number came from a local headless run
// serving the model from localhost. Now every performance tile is computed from
// live-measurement.json (written by `pnpm run measure:live` against the deployed
// site), and these tests recompute each figure from the raw runs.
describe("landing performance tiles quote the recorded live measurement", () => {
	it("the recording is a real multi-run measurement of the live site", () => {
		expect(measurement.target).toBe("https://edge-reco.com/");
		expect(measurement.coldStartMs.length).toBeGreaterThanOrEqual(5);
		expect(measurement.warmStartMs.length).toBeGreaterThanOrEqual(5);
		expect(measurement.searchP50Ms.length).toBeGreaterThanOrEqual(5);
		expect(measurement.heapMb.length).toBeGreaterThanOrEqual(5);
	});

	it("the first-visit tile is the median cold run, in seconds", () => {
		const coldS = median(measurement.coldStartMs) / 1000;
		expect(tile("coldStart").num).toBe(`~${coldS.toFixed(1)}`);
		expect(tile("coldStart").unit).toBe("s");
	});

	it("the first-visit tile's sub-line is the median warm run", () => {
		const warmS = median(measurement.warmStartMs) / 1000;
		expect(tile("coldStart").vars?.warm).toBe(`${warmS.toFixed(1)} s`);
	});

	it("the latency tile is the median per-session search p50", () => {
		const p50 = Math.round(median(measurement.searchP50Ms));
		expect(tile("latency").num).toBe(`~${p50}`);
	});

	it("the heap tile is the median heap reading", () => {
		const heap = Math.round(median(measurement.heapMb));
		expect(tile("heap").num).toBe(`~${heap}`);
	});

	it("the band names the date of the measurement it quotes", () => {
		expect(LANDING_MEASURED_ON).toBe(measurement.measuredAt.slice(0, 10));
	});

	it("the landing copy hardcodes no timing or size of its own", () => {
		// Numbers reach the page only through interpolation from this module.
		const unitClaim = /\d+(\.\d+)?\s?(ms|s|MB|MiB)\b/;
		for (const text of strings(landingCopy)) {
			expect(text).not.toMatch(unitClaim);
		}
	});
});
