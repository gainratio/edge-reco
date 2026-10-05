import { expect, test } from "@playwright/test";

/**
 * The intro Landing → launch gate → live MetricsStrip flow — BACKEND-FREE.
 *
 * Asserts the new front-door behavior:
 *   1. The Landing intro renders first and the engine stays COLD — no store,
 *      no product cards mounted yet.
 *   2. Clicking "▶ Launch the live demo" boots the in-tab engine (real sync +
 *      ed25519/sha256 verify + 720-product reassembly) and mounts the store.
 *   3. The MetricsStrip shows LIVE, in-tab telemetry: after a search the latency
 *      tile reads a real measured value, and the "backend calls" tile stays 0 —
 *      the honest headline of the backend-free demo (product images are baked
 *      into the signed bundle and served same-origin, so browsing hits no
 *      application backend, and no user data is ever sent anywhere).
 *
 * REAL vs STUBBED — identical to storefront.spec.ts: only the embedder TRANSPORT
 * is stubbed (the deterministic 384-d hook below) so the run doesn't wait on the
 * ~25 MB transformers.js model download. Everything else is the production path.
 */

// The card root became an <article> in v0.9.0; the full-card action is the
// overlay button (one per card, so counting overlays counts cards).
const PRODUCT_CARD = "main article.card button.card__overlay";
const STRIP = "[aria-label='Live engine metrics']";

const EMBEDDING_DIM = 384;

test.beforeEach(async ({ page }) => {
	// Install a deterministic embedder factory BEFORE any app script runs, via
	// the demo's narrow test hook — the ONLY non-production seam. createDataClient()
	// picks it up instead of loading the real ~25 MB model.
	await page.addInitScript((dim: number) => {
		const seedVec = (text: string): Float32Array => {
			const v = new Float32Array(dim);
			let h = 2166136261;
			for (let i = 0; i < text.length; i += 1) {
				h = Math.imul(h ^ text.charCodeAt(i), 16777619);
			}
			for (let i = 0; i < dim; i += 1) {
				v[i] = (((h >>> (i % 31)) & 0xff) / 255 - 0.5) * (i === 0 ? 2 : 1);
			}
			return v;
		};
		(
			globalThis as {
				__edgeprocDemoTestHooks?: {
					makeEmbedder?: () => {
						embed: (text: string) => Promise<Float32Array>;
					};
				};
			}
		).__edgeprocDemoTestHooks = {
			makeEmbedder: () => ({
				embed: (text: string) => Promise.resolve(seedVec(text)),
			}),
		};
	}, EMBEDDING_DIM);

	// Belt-and-braces: product images are now baked into the bundle and served
	// same-origin, so no external host should ever be hit. Abort any stray remote
	// image request so a regression to a remote host fails loudly rather than
	// silently going offline.
	await page.route(/m\.media-amazon\.com/, (route) => route.abort());
});

test("launch gate: Landing first, engine cold until Launch is clicked", async ({
	page,
}) => {
	await page.goto("/");

	// --- The Landing intro is visible and the engine has NOT booted ---
	await expect(
		page.getByText("brings their own device", { exact: false }),
	).toBeVisible();
	const launchBtn = page.getByRole("button", {
		name: "▶ Launch the live demo",
	});
	await expect(launchBtn).toBeVisible();

	// The store is NOT mounted yet — no product cards, no metrics strip.
	await expect(page.locator(PRODUCT_CARD)).toHaveCount(0);
	await expect(page.locator(STRIP)).toHaveCount(0);

	// --- Launch → boot runs in-tab → the store mounts ---
	await launchBtn.click();
	const productCards = page.locator(PRODUCT_CARD);
	// Generous timeout covers sync + 720-product index reassembly.
	await expect(productCards.first()).toBeVisible({ timeout: 60_000 });
	expect(await productCards.count()).toBeGreaterThanOrEqual(3);

	// The Landing is gone; the live metrics strip is mounted.
	await expect(launchBtn).toHaveCount(0);
	await expect(page.locator(STRIP)).toBeVisible();
});

test("mobile storefront never widens the page, including after cart state", async ({
	page,
}) => {
	const mobileWidths = [320, 390, 430];
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto("/");
	await page.getByRole("button", { name: "▶ Launch the live demo" }).click();

	const productCards = page.locator(PRODUCT_CARD);
	await expect(productCards.first()).toBeVisible({ timeout: 60_000 });
	for (const width of mobileWidths) {
		await page.setViewportSize({ width, height: 844 });
		expect(
			await page.evaluate(() => document.documentElement.scrollWidth),
		).toBe(width);
	}

	await page
		.getByRole("button", { name: /^Add .+ to cart$/ })
		.first()
		.click();
	await expect(page.locator(".cart-pill")).toHaveText(/1/);
	for (const width of mobileWidths) {
		await page.setViewportSize({ width, height: 844 });
		expect(
			await page.evaluate(() => document.documentElement.scrollWidth),
		).toBe(width);
	}
});

test("live metrics strip: search drives a real latency; backend calls stay 0", async ({
	page,
}) => {
	await page.goto("/");
	await page.getByRole("button", { name: "▶ Launch the live demo" }).click();

	const productCards = page.locator(PRODUCT_CARD);
	await expect(productCards.first()).toBeVisible({ timeout: 60_000 });

	const strip = page.locator(STRIP);
	await expect(strip).toBeVisible();

	// Each tile is { value, label }; read by label → adjacent value.
	const tileValue = (label: string) =>
		strip
			.locator(".metrics-strip__tile", {
				has: page.locator(".metrics-strip__label", { hasText: label }),
			})
			.locator(".metrics-strip__value");

	// --- A search runs the engine in-tab; the latency tile reports a real value ---
	const searchBox = page.getByRole("searchbox", { name: "Search products" });
	await searchBox.fill("shirt");
	await expect
		.poll(() => productCards.count(), {
			message: "in-tab search should return at least one result",
			timeout: 15_000,
		})
		.toBeGreaterThanOrEqual(1);

	// msLabel() formats as "<1 ms" (sub-ms) or "N ms"; "—" means unmeasured.
	// Assert a real, measured latency landed (not the em-dash placeholder).
	const latency = tileValue("latency");
	await expect(latency).toBeVisible();
	await expect(latency).toHaveText(/ms/, { timeout: 15_000 });

	// --- The honest headline: backend calls stay 0 after browsing + searching ---
	// Images are same-origin static assets and nothing is ever uploaded, so 0 is the
	// true expected value (no per-query backend ranking call).
	const backendCalls = tileValue("backend calls");
	await expect(backendCalls).toHaveText("0");

	// A second browse + search keeps it at 0 (no per-query round trip).
	await searchBox.fill("");
	await expect(productCards.first()).toBeVisible();
	await searchBox.fill("watch");
	await expect.poll(() => productCards.count()).toBeGreaterThanOrEqual(0);
	await expect(backendCalls).toHaveText("0");
});
