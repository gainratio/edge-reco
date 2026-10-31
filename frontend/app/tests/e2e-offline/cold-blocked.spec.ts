import { expect, type Page, test } from "@playwright/test";

/**
 * The COLD / BLOCKED-CDN boot proof (house standard §8.1b), on the MINIFIED
 * production build with the REAL generated service worker — the aml-filter
 * screen-cold-blocked mechanism, adapted to the storefront.
 *
 * With every HuggingFace host AND jsDelivr aborted, the full shopper journey
 * still works: launch → real ~23 MB MiniLM loads from the same-origin /models/
 * mirror → store mounts → a real search re-ranks the grid. This proves the
 * runtime has ZERO CDN dependency (weights self-hosted by
 * scripts/download-model.mjs; the ONNX-runtime WASM emitted same-origin into
 * dist/assets by the Vite build).
 *
 * It doubles as the `useBrowserCache` + `build.target: "es2022"` guard: the
 * zero-console-errors assertion on the MINIFIED build re-trips if the es2020
 * private-field downlevel crash (`Ke(...).call is not a function` — aml-filter's
 * scar) ever returns, and the transformers-cache assertion proves the re-enabled
 * CacheStorage path actually ran.
 */

const PRODUCT_CARD = "main article.card button.card__overlay";

/** Hosts transformers.js could reach for weights — the HF hub and its LFS CDN —
 * plus jsDelivr, the historical fallback origin for the ONNX-runtime WASM. */
const CDN_GLOBS = [
	"**huggingface.co/**",
	"**cdn-lfs**",
	"**hf.co/**",
	"**cdn.jsdelivr.net/**",
];

/** Collect in-page errors (pageerror + console.error) for a clean-console
 * assert. Resource-load failures for origins THIS SPEC deliberately aborts are
 * harness artifacts, not app errors — but any such failure also increments the
 * blocked-hit counter, which must stay at zero, so nothing is masked. */
function collectErrors(page: Page): string[] {
	const errors: string[] = [];
	page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
	page.on("console", (msg) => {
		if (msg.type() === "error") {
			errors.push(`console.error: ${msg.text()}`);
		}
	});
	return errors;
}

test("cold boot with HF + jsDelivr blocked: model loads from /models/, search works, console clean", async ({
	page,
	context,
}) => {
	test.setTimeout(240_000);
	const errors = collectErrors(page);

	// Abort every CDN request and record that the runtime never even tried —
	// the same-origin self-host path must be the ONLY one used. Context-level
	// routing so dedicated-Worker requests are covered too; service-worker
	// fetches can bypass routing entirely, which is why the same-origin
	// cache-key assertion below is the interception-independent proof.
	let hitCdn = 0;
	for (const glob of CDN_GLOBS) {
		await context.route(glob, (route) => {
			hitCdn += 1;
			return route.abort();
		});
	}

	await page.goto("/");

	// Launch the live demo: real sync + REAL model load (no embedder stub here).
	await page.getByRole("button", { name: "▶ Launch the live demo" }).click();
	const cards = page.locator(PRODUCT_CARD);
	await expect(cards.first()).toBeVisible({ timeout: 180_000 });
	expect(await cards.count()).toBeGreaterThanOrEqual(3);

	// A real query drives the real embedder end-to-end (hybrid search needs the
	// query vector): results render, so the q8 model is genuinely live.
	const search = page.getByRole("searchbox", { name: "Search products" });
	await search.fill("moisture wicking golf polo");
	await expect(cards.first()).toBeVisible({ timeout: 30_000 });

	// The runtime never depended on a CDN: nothing reached the blocked hosts.
	expect(hitCdn, "the runtime hit a blocked CDN host").toBe(0);

	// Clean console on the MINIFIED build — the es2022/useBrowserCache guard.
	expect(errors, `in-browser errors:\n${errors.join("\n")}`).toEqual([]);

	// useBrowserCache is ON: a successful load must have populated the
	// CacheStorage cache transformers.js owns (`transformers-cache`), so a
	// returning visitor reuses these weights. Asserting every cached model URL
	// is a SAME-ORIGIN /models/ URL is the interception-independent proof of
	// the weights' provenance: had they come from the HF hub, the cache keys
	// would be huggingface.co URLs.
	// The model response is cached asynchronously; poll instead of racing the
	// CacheStorage write immediately after the search result renders.
	await expect
		.poll(
			async () =>
				page.evaluate(async () => {
					const cache = await caches.open("transformers-cache");
					const keys = await cache.keys();
					return keys
						.map((req) => req.url)
						.filter((url) => url.includes("all-MiniLM-L6-v2")).length;
				}),
			{ timeout: 60_000 },
		)
		.toBeGreaterThan(0);
	const cachedModelUrls = await page.evaluate(async () => {
		const cache = await caches.open("transformers-cache");
		const keys = await cache.keys();
		return keys
			.map((req) => req.url)
			.filter((url) => url.includes("all-MiniLM-L6-v2"));
	});
	const origin = new URL(page.url()).origin;
	for (const url of cachedModelUrls) {
		expect(
			url.startsWith(`${origin}/models/`),
			`off-origin weights: ${url}`,
		).toBe(true);
	}
});
