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
import relevance from "./relevance-measurement.json";

const median = (xs: readonly number[]): number => {
	const s = [...xs].sort((a, b) => a - b);
	// Odd length: lo === hi. An empty list yields NaN, which no tile test accepts.
	const lo = s[Math.floor((s.length - 1) / 2)] ?? Number.NaN;
	const hi = s[Math.ceil((s.length - 1) / 2)] ?? Number.NaN;
	return (lo + hi) / 2;
};

const seconds = (ms: number): string => (ms / 1000).toFixed(1);
const pct = (ratio: number): string => `${(ratio * 100).toFixed(1)}`;
const dec2 = (value: number): string => value.toFixed(2);

/** The day the quoted measurement was taken (YYYY-MM-DD), shown on the band. */
export const LANDING_MEASURED_ON = measurement.measuredAt.slice(0, 10);

/** Assay IR scorer provenance string shown on the search-quality band. */
export const QUALITY_SCORER = relevance.scorer;
export const QUALITY_NATURAL_QUERIES = relevance.natural.k10.queryCount;

/** One-time embedding model download on a first visit, as measured. */
export const MODEL_DOWNLOAD = `${Math.round(measurement.embeddingModelMb)} MB`;

/** Products in the committed demo catalog. Guarded against the signed bundle in tests. */
export const CATALOG_PRODUCTS = 1000000;
/** Categories the committed catalog is balanced across (see CLAUDE.md invariant). */
export const CATALOG_CATEGORIES = 12;
/**
 * On-disk size of the committed signed bundle (backend/examples/catalog).
 * Guarded against the bundle's real byte count in landing-figures.test.ts.
 */
export const BUNDLE_SIZE = "79.0 MB";

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
			products: CATALOG_PRODUCTS.toLocaleString("en-US"),
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
		num: CATALOG_PRODUCTS.toLocaleString("en-US"),
		vars: { categories: CATALOG_CATEGORIES, bundle: BUNDLE_SIZE },
	},
];

/** Six IR quality tiles scored by `assay.ranking` (`trec_eval`) over the held-out golden set. */
export const LANDING_QUALITY_METRICS: readonly RepresentativeMetric[] = [
	{
		id: "precision",
		num: pct(relevance.natural.k10.precision),
		unit: "%",
		tone: "pos",
		vars: {
			k: relevance.natural.k10.k,
			p24: `${pct(relevance.natural.k24.precision)}%`,
			k24: relevance.natural.k24.k,
		},
	},
	{
		id: "recall",
		num: pct(relevance.natural.k24.recall),
		unit: "%",
		vars: {
			k24: relevance.natural.k24.k,
			shareOfCeiling: `${pct(relevance.natural.k24.recall / relevance.natural.k24.oracleRecallCeiling)}%`,
			ceiling: `${pct(relevance.natural.k24.oracleRecallCeiling)}%`,
		},
	},
	{
		id: "f1",
		num: dec2(relevance.natural.k24.f1),
		tone: "hot",
		vars: {
			k24: relevance.natural.k24.k,
			shareOfCeiling: `${pct(relevance.natural.k24.f1 / relevance.natural.k24.oracleF1Ceiling)}%`,
			ceiling: dec2(relevance.natural.k24.oracleF1Ceiling),
		},
	},
	{
		id: "ndcg",
		num: dec2(relevance.natural.k10.ndcg),
		tone: "pos",
		vars: {
			k: relevance.natural.k10.k,
			ciLow: dec2(relevance.natural.k10.ndcgCiLow),
			ciHigh: dec2(relevance.natural.k10.ndcgCiHigh),
		},
	},
	{
		id: "mrr",
		num: dec2(relevance.natural.k10.mrr),
		vars: {
			map: dec2(relevance.natural.k10.map),
		},
	},
	{
		id: "negatives",
		num: `${relevance.negatives.fullDepthPages}/${relevance.negatives.queryCount}`,
		tone: "pos",
		vars: {
			empty: relevance.negatives.emptyPositivePages,
		},
	},
];
