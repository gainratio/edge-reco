// Measure the deployed storefront in real, headed Chromium and record the result.
//
//   cd frontend/app && pnpm run measure:live            # default: 7 cold + 7 warm
//   MEASURE_RUNS=5 MEASURE_TARGET=https://… pnpm run measure:live
//
// Cold run: a brand-new browser profile (no HTTP cache, no OPFS, no service
// worker), open the landing, click "Launch", wait for the first product cards.
// Warm run: the same flow in one reused profile after a priming visit, with the
// browser restarted between runs so nothing is held in memory.
//
// Every number is the app's own `window.__edgeprocMetrics` (the in-store strip
// reads the same values), so the landing quotes exactly what a shopper's tab
// measures. The output file is the ONLY source the landing tiles may read;
// landing-figures.test.ts fails if a tile disagrees with it.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { arch, platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const TARGET = process.env.MEASURE_TARGET ?? "https://edge-reco.com/";
const RUNS = Number(process.env.MEASURE_RUNS ?? 7);
const OUT = join(
	dirname(fileURLToPath(import.meta.url)),
	"../src/metrics/live-measurement.json",
);
const CARD = "main article.card";
const QUERIES = [
	"wireless bluetooth headphones",
	"running shoes men",
	"stainless steel water bottle",
	"noise cancelling earbuds",
	"lightweight travel backpack",
	"cotton summer dress",
	"mechanical gaming keyboard",
	"organic skin moisturizer",
	"smart fitness watch",
	"nonstick cooking pan",
];

const metric = (page, key) =>
	page.evaluate((k) => window.__edgeprocMetrics?.[k] ?? null, key);

const median = (xs) => {
	const s = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/** Which part of the first visit a URL belongs to. */
function part(url) {
	const path = new URL(url).pathname;
	if (path.startsWith("/models/")) return "embeddingModel";
	if (path.startsWith("/ort/")) return "onnxRuntimeWasm";
	if (path.startsWith("/assets/")) return "appCode";
	if (/\/(latest|manifest|chunk)\b/.test(path)) return "signedBundle";
	return "other";
}

/** Response bytes per part, counted at the network layer (workers included). */
function countBytes(context) {
	const bytes = {};
	context.on("requestfinished", async (request) => {
		const sizes = await request.sizes().catch(() => null);
		if (!sizes) return;
		const key = part(request.url());
		bytes[key] = (bytes[key] ?? 0) + sizes.responseBodySize;
	});
	return bytes;
}

async function launchAndWait(context) {
	const page = await context.newPage();
	await page.goto(TARGET);
	await page.getByRole("button", { name: /Launch the live demo/ }).click();
	await page.locator(CARD).first().waitFor({ timeout: 180_000 });
	return page;
}

async function searchP50(page) {
	const samples = [];
	for (const query of QUERIES) {
		await page.getByRole("searchbox").fill(query);
		await page.locator(".results-cue", { hasText: query }).waitFor();
		samples.push(await metric(page, "searchMs"));
	}
	return median(samples);
}

const open = (dir) =>
	chromium.launchPersistentContext(dir, {
		headless: false,
		viewport: { width: 1280, height: 900 },
	});

async function coldRun() {
	const dir = mkdtempSync(join(tmpdir(), "edgereco-cold-"));
	const context = await open(dir);
	const bytes = countBytes(context);
	const page = await launchAndWait(context);
	const ms = await metric(page, "coldStartMs");
	await context.close();
	rmSync(dir, { recursive: true, force: true });
	return { ms, bytes };
}

async function warmRun(dir) {
	const context = await open(dir);
	const page = await launchAndWait(context);
	const ms = await metric(page, "coldStartMs");
	const p50 = await searchP50(page);
	const heap = await metric(page, "heapMb");
	const version = context.browser()?.version() ?? chromium.name();
	await context.close();
	return { ms, p50, heap, version };
}

const round1 = (x) => Math.round(x * 10) / 10;
const toMb = (bytes) =>
	Object.fromEntries(
		Object.entries(bytes).map(([k, v]) => [k, round1(v / 1e6)]),
	);

const build = await (await fetch(new URL("/build.json", TARGET))).json();
const cold = [];
for (let i = 0; i < RUNS; i++) cold.push(await coldRun());
const warmDir = mkdtempSync(join(tmpdir(), "edgereco-warm-"));
{
	const context = await open(warmDir);
	await launchAndWait(context); // prime HTTP cache, OPFS, service worker
	await context.close();
}
const warm = [];
for (let i = 0; i < RUNS; i++) warm.push(await warmRun(warmDir));
rmSync(warmDir, { recursive: true, force: true });

const record = {
	schema: "edgereco.live-measurement/v1",
	measuredAt: new Date().toISOString(),
	target: TARGET,
	deployedCommit: build.commit,
	browser: `Chromium ${warm[0].version}, headed, fresh profile per cold run`,
	machine: `${platform()} ${arch()}, unthrottled network`,
	command: "cd frontend/app && pnpm run measure:live",
	coldStartMs: cold.map((r) => round1(r.ms)),
	warmStartMs: warm.map((r) => round1(r.ms)),
	searchP50Ms: warm.map((r) => round1(r.p50)),
	heapMb: warm.map((r) => round1(r.heap)),
	firstVisitDownloadMb: toMb(cold[0].bytes),
};
writeFileSync(OUT, `${JSON.stringify(record, null, "\t")}\n`);
console.log(
	`cold median ${median(record.coldStartMs)} ms, warm median ${median(record.warmStartMs)} ms -> ${OUT}`,
);
