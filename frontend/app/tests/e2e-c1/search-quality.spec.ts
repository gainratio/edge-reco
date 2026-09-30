import { expect, test } from "@playwright/test";

const PRODUCT_CARD = "main article.card";
// The synthetic catalog stocks several men's waterproof boots that score within a
// hair of each other, so the pin is "a hiking boot comes first", not one title.
const WATERPROOF_BOOT = /^\S.* Men's .*(Hiking|Trail) Boot \| /;
const BOOT_BUDGET_MS = 30_000;
const SEARCH_P50_BUDGET_MS = 300;
const SEARCH_P95_BUDGET_MS = 750;
const HEAP_BUDGET_MB = 512;
const BLOCKED_RUNTIME_CDNS = [
	"**huggingface.co/**",
	"**cdn-lfs**",
	"**hf.co/**",
	"**cdn.jsdelivr.net/**",
];
const BENCHMARK_QUERIES = [
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

function percentile(samples: readonly number[], quantile: number): number {
	const ordered = [...samples].sort((left, right) => left - right);
	return (
		ordered[Math.ceil(ordered.length * quantile) - 1] ??
		Number.POSITIVE_INFINITY
	);
}

test("real search is relevant, local, clean, and inside release budgets", async ({
	page,
	context,
}) => {
	test.setTimeout(180_000);
	const errors: string[] = [];
	const thirdPartyRequests: string[] = [];
	let blockedRuntimeCdnHits = 0;
	let sqliteWasmRequests = 0;
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") errors.push(message.text());
	});
	context.on("request", (request) => {
		if (/\/sqlite3(?:-[^/]+)?\.wasm(?:\?|$)/.test(request.url())) {
			sqliteWasmRequests += 1;
		}
	});
	page.on("request", (request) => {
		const origin = new URL(request.url()).origin;
		const allowed =
			origin === "http://localhost:5174" || origin === "http://localhost:8910";
		if (!allowed) {
			thirdPartyRequests.push(request.url());
		}
	});
	for (const glob of BLOCKED_RUNTIME_CDNS) {
		await context.route(glob, (route) => {
			blockedRuntimeCdnHits += 1;
			return route.abort();
		});
	}
	await page.goto("/");
	await page.getByRole("button", { name: "▶ Launch the live demo" }).click();
	await expect(page.locator(PRODUCT_CARD).first()).toBeVisible({
		timeout: 120_000,
	});

	await page.getByRole("searchbox").fill("waterproof hiking boot");
	await expect(page.locator(".results-cue")).toContainText(
		"waterproof hiking boot",
	);
	await expect(page.locator(`${PRODUCT_CARD} .card__title`).first()).toHaveText(
		WATERPROOF_BOOT,
	);

	const bootMs = await page.evaluate(
		() => window.__edgeprocMetrics?.coldStartMs ?? null,
	);
	expect(bootMs, "cold-start metric was not recorded").not.toBeNull();
	expect(bootMs ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
		BOOT_BUDGET_MS,
	);

	const samples: number[] = [];
	for (const query of BENCHMARK_QUERIES) {
		await page.getByRole("searchbox").fill(query);
		await expect(page.locator(".results-cue")).toContainText(query);
		const searchMs = await page.evaluate(
			() => window.__edgeprocMetrics?.searchMs ?? null,
		);
		expect(searchMs, `missing latency for ${query}`).not.toBeNull();
		samples.push(searchMs ?? Number.POSITIVE_INFINITY);
	}

	const p50 = percentile(samples, 0.5);
	const p95 = percentile(samples, 0.95);
	expect(p50).toBeLessThanOrEqual(SEARCH_P50_BUDGET_MS);
	expect(p95).toBeLessThanOrEqual(SEARCH_P95_BUDGET_MS);
	const backendCalls = await page.evaluate(
		() => window.__edgeprocMetrics?.backendCalls ?? null,
	);
	const heapMb = await page.evaluate(
		() => window.__edgeprocMetrics?.heapMb ?? null,
	);
	expect(heapMb, "Chromium heap metric was not recorded").not.toBeNull();
	expect(heapMb ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
		HEAP_BUDGET_MB,
	);
	expect(backendCalls).toBe(0);
	expect(
		sqliteWasmRequests,
		"the storefront never loaded the shared sqlite-vector WASM runtime",
	).toBeGreaterThan(0);
	const opfsEntries = await page.evaluate(async () => {
		const root = await navigator.storage.getDirectory();
		const names: string[] = [];
		const walk = async (
			directory: FileSystemDirectoryHandle,
			prefix = "",
		): Promise<void> => {
			for await (const [name, handle] of (
				directory as unknown as {
					entries(): AsyncIterable<
						[string, FileSystemFileHandle | FileSystemDirectoryHandle]
					>;
				}
			).entries()) {
				const path = `${prefix}${name}`;
				names.push(path);
				if (handle.kind === "directory") {
					await walk(handle, `${path}/`);
				}
			}
		};
		await walk(root);
		return names;
	});
	expect(
		opfsEntries.some((name) => name.includes("edgeproc-vector-")),
		`sqlite-vector did not create its OPFS SAH-pool; found ${JSON.stringify(opfsEntries)}`,
	).toBe(true);
	expect(
		blockedRuntimeCdnHits,
		"runtime attempted third-party CDN egress",
	).toBe(0);
	expect(
		thirdPartyRequests,
		"traffic left the app and signed-bundle origins",
	).toEqual([]);
	console.log(
		`release metrics: boot=${bootMs?.toFixed(1)}ms search_p50=${p50.toFixed(1)}ms search_p95=${p95.toFixed(1)}ms heap=${heapMb?.toFixed(1)}MiB`,
	);
	expect(errors).toEqual([]);
});
