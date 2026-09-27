// Figures for the pre-boot Landing page.
//
// The engine isn't running on the landing, so the performance tiles can't be
// measured live there. Instead they quote a RECORDED measurement of the deployed
// site: live-measurement.json, written by `pnpm run measure:live`
// (scripts/measure-live-boot.mjs), which drives real headed Chromium against
// https://edge-reco.com/ — cold runs in a brand-new profile, warm runs in a
// reused one — and stores every raw run. Each tile below is the median of those
// runs, computed here, so no timing or heap figure can be typed in by hand.
// landing-figures.test.ts recomputes every tile from the raw runs.
//
// The CATALOG_* facts are tied to the committed signed bundle (built from
// backend/examples/source/catalog.csv) and guarded the same way. The COPY —
// labels, subs, footnote — lives in the `landing` i18n namespace, which may carry
// no number with a unit of its own; values arrive only by interpolation.
//
// README.md deliberately carries no performance figures — landing-figures.test.ts
// fails if a hardcoded timing or heap claim reappears there.

import measurement from "./live-measurement.json";

const median = (xs: readonly number[]): number => {
	const s = [...xs].sort((a, b) => a - b);
	// Odd length: lo === hi. An empty list yields NaN, which no tile test accepts.
	const lo = s[Math.floor((s.length - 1) / 2)] ?? Number.NaN;
	const hi = s[Math.ceil((s.length - 1) / 2)] ?? Number.NaN;
	return (lo + hi) / 2;
};

const seconds = (ms: number): string => (ms / 1000).toFixed(1);

/** The day the quoted measurement was taken (YYYY-MM-DD), shown on the band. */
export const LANDING_MEASURED_ON = measurement.measuredAt.slice(0, 10);

/** One-time embedding model download on a first visit, as measured. */
export const MODEL_DOWNLOAD = `${Math.round(
	measurement.firstVisitDownloadMb.embeddingModel,
)} MB`;

/** Products in the committed demo catalog. Guarded against the source CSV in tests. */
export const CATALOG_PRODUCTS = 720;
/** Categories the committed catalog is balanced across (see CLAUDE.md invariant). */
export const CATALOG_CATEGORIES = 12;
/**
 * On-disk size of the committed signed bundle (backend/examples/catalog).
 * Guarded against the bundle's real byte count in landing-figures.test.ts.
 */
export const BUNDLE_SIZE = "1.5 MB";

export interface RepresentativeMetric {
	/** Stable key into the `landing` namespace: `metrics.<id>.{label,sub}`. */
	id: string;
	num: string;
	unit?: string;
	tone?: "hot" | "pos";
	/** Interpolation values for the tile's `sub` copy (never reserved `count`). */
	vars?: Record<string, string | number>;
}

/** The six tiles shown in the landing's metric band. */
export const LANDING_METRICS: readonly RepresentativeMetric[] = [
	{
		id: "latency",
		num: `~${Math.round(median(measurement.searchP50Ms))}`,
		unit: "ms",
		tone: "hot",
	},
	{ id: "backendCalls", num: "0", tone: "pos" },
	{
		id: "coldStart",
		num: `~${seconds(median(measurement.coldStartMs))}`,
		unit: "s",
		vars: {
			products: CATALOG_PRODUCTS,
			warm: `${seconds(median(measurement.warmStartMs))} s`,
		},
	},
	{
		id: "heap",
		num: `~${Math.round(median(measurement.heapMb))}`,
		unit: "MB",
	},
	{ id: "cost", num: "$0", tone: "pos" },
	{
		id: "catalog",
		num: String(CATALOG_PRODUCTS),
		vars: { categories: CATALOG_CATEGORIES, bundle: BUNDLE_SIZE },
	},
];
