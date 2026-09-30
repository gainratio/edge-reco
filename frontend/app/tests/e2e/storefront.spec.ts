import { expect, test } from "@playwright/test";

/**
 * The Nimbus storefront — proven FULLY BACKEND-FREE in a real browser, now with
 * the multi-strategy storefront: stacked home rails + a state-based PDP.
 *
 * NO application backend runs. The only servers are a static SPA (Vite) and a
 * dumb static file origin for the signed bundle (catalog-server.mjs). The test
 * asserts the whole in-tab pipeline:
 *
 *   boot screen → sync the signed bundle into OPFS (real ed25519 + sha256 +
 *   content-addressed chunks, in a Worker) → storefront mounts over the real
 *   720-product synthetic catalog → the home shows ≥3 labeled strategy rails →
 *   clicking a product folds the click into the in-tab session profile (NO
 *   network), opens a PDP seeded with vector rails, and the For-You rail
 *   re-ranks on return.
 *
 * REAL vs STUBBED:
 *   - REAL: the sync engine (OPFS, signature + chunk verification, reassembly of
 *     the 720-product catalog), the BM25 ⊕ vector → RRF → session-rerank search
 *     engine, the multi-strategy recommend()/similar() surface, and the in-tab
 *     session profile / click→re-rank loop.
 *   - STUBBED: only the embedder TRANSPORT (a deterministic 384-d embedder via
 *     `window.__edgeprocDemoTestHooks.makeEmbedder`) so the test does not wait
 *     on the ~25 MB transformers.js model download. The vector leg still runs
 *     against the real index.
 *   - Product images are now baked into the signed bundle as license-clean SVGs
 *     the app ships same-origin under /images/<id>.svg, so the cards render REAL
 *     images (not the gradient-tile fallback). No external image host is hit; the
 *     run stays offline + deterministic. The m.media-amazon.com abort below is a
 *     belt-and-braces guard that nothing regresses back to a remote image host.
 */

// The card root is an <article> in v0.9.0; the full-card action is the overlay
// button (one per card, so counting overlays counts cards).
const PRODUCT_CARD = "main article.card button.card__overlay";
// The For-You rail: a labeled scroll section whose heading is "Recommended for you".
const FOR_YOU = "section.rail--row:has(h2:text-is('Recommended for you'))";
const FOR_YOU_BADGE = `${FOR_YOU} .clicks-badge`;
const FOR_YOU_TITLE = `${FOR_YOU} .rail-card__title`;
// The PDP "Similar items" rail.
const SIMILAR = "section.rail--row:has(h2:text-is('Similar items'))";
const SIMILAR_ITEM = `${SIMILAR} li.rail-card`;
// The PDP co-occurrence rails (seed-driven; absent for a co-occurrence-less seed).
const FBT = "section.rail--row:has(h2:text-is('Frequently bought together'))";
const ALSO_BOUGHT =
	"section.rail--row:has(h2:text-is('Customers who bought this also bought'))";
const BACK = "button.pdp__back";

const EMBEDDING_DIM = 384;

test.beforeEach(async ({ page }) => {
	// Install a deterministic embedder factory BEFORE any app script runs, via
	// the demo's narrow test hook. createDataClient() picks it up instead of
	// loading the real ~25 MB model. The hook lives in the demo (not in the
	// engine package) and is the ONLY non-production seam this test relies on.
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

	// Belt-and-braces: images are now baked into the bundle and served same-origin
	// (/images/<id>.svg), so no external host should ever be hit. Abort any stray
	// remote image request so a regression to a remote host fails loudly instead
	// of silently going offline. (Not part of the engine under test.)
	await page.route(/m\.media-amazon\.com/, (route) => route.abort());
});

/** Cross the launch gate and wait for the storefront grid to mount. */
async function launch(page: import("@playwright/test").Page): Promise<void> {
	await page.goto("/");
	await page.getByRole("button", { name: "▶ Launch the live demo" }).click();
	await expect(page.locator(PRODUCT_CARD).first()).toBeVisible({
		timeout: 60_000,
	});
}

test("storefront renders REAL product images, not gradient placeholders", async ({
	page,
}) => {
	// Regression guard for the shipped-placeholders bug: every card must render a
	// same-origin /images/<id>.svg that ACTUALLY LOADS (naturalWidth > 0) — never
	// the .pimg-tile gradient fallback. If the baked images or the local rewrite
	// regress, this fails loudly instead of quietly serving placeholder tiles.
	await launch(page);

	const firstImg = page
		.locator("main article.card .card__media img.pimg")
		.first();
	await expect(firstImg).toBeVisible();
	await expect(firstImg).toHaveAttribute("src", /^\/images\//);

	// The image decoded: a broken/blocked image reports naturalWidth === 0.
	await expect
		.poll(
			() => firstImg.evaluate((el) => (el as HTMLImageElement).naturalWidth),
			{
				message: "the baked local product image must actually load",
				timeout: 15_000,
			},
		)
		.toBeGreaterThan(0);

	// No card fell back to the gradient placeholder tile.
	await expect(page.locator("main article.card .pimg-tile")).toHaveCount(0);
});

test("home shows ≥3 labeled strategy rails over the catalog grid", async ({
	page,
}) => {
	await launch(page);

	expect(await page.locator(PRODUCT_CARD).count()).toBeGreaterThanOrEqual(3);

	// The home stack: For You + Trending + New arrivals, each a labeled region.
	const rails = page.locator("main .rail-stack section.rail--row");
	expect(await rails.count()).toBeGreaterThanOrEqual(3);
	await expect(page.locator("h2:text-is('Recommended for you')")).toBeVisible();
	await expect(page.locator("h2:text-is('Trending now')")).toBeVisible();
	await expect(page.locator("h2:text-is('New arrivals')")).toBeVisible();

	// The For-You hero-loop badge starts at zero (no clicks acknowledged yet).
	await expect(page.locator(FOR_YOU_BADGE)).toHaveText("0");
});

test("clicking a product opens a PDP with a seeded Similar-items rail; Back returns", async ({
	page,
}) => {
	await launch(page);

	// Capture the seed product's title before navigating.
	const firstCard = page.locator("main article.card").first();
	const seedTitle = (
		await firstCard.locator(".card__title").innerText()
	).trim();

	await page.locator(PRODUCT_CARD).first().click();

	// PDP is up: the hero shows the product, and the Similar-items rail is
	// non-empty and EXCLUDES the seed (vector kNN drops the seed itself).
	await expect(page.locator(".pdp__title")).toBeVisible();
	await expect(page.locator(SIMILAR)).toBeVisible();
	await expect
		.poll(() => page.locator(SIMILAR_ITEM).count(), {
			message: "Similar-items rail should be seeded and non-empty",
			timeout: 15_000,
		})
		.toBeGreaterThanOrEqual(1);
	const similarTitles = (
		await page.locator(`${SIMILAR} .rail-card__title`).allTextContents()
	).map((t) => t.trim());
	expect(similarTitles).not.toContain(seedTitle);

	// Back returns to the browse grid + home rails.
	await page.locator(BACK).click();
	await expect(page.locator(PRODUCT_CARD).first()).toBeVisible();
	await expect(page.locator("h2:text-is('Recommended for you')")).toBeVisible();
});

test("PDP co-occurrence rails: a present also-bought / FBT rail is non-empty and excludes the seed", async ({
	page,
}) => {
	await launch(page);

	// Co-occurrence is seed-driven: a given product may have no co-purchase
	// neighbours (rail absent is valid). The seed demo gives 291 products
	// neighbours, so scanning a handful of products reliably surfaces at least
	// one populated co-buy rail — that is the case we assert hard.
	const cards = page.locator("main article.card");
	let sawCoBuyRail = false;

	for (let i = 0; i < 8 && !sawCoBuyRail; i++) {
		const seedTitle = (
			await cards.nth(i).locator(".card__title").innerText()
		).trim();
		await page.locator(PRODUCT_CARD).nth(i).click();
		await expect(page.locator(".pdp__title")).toBeVisible();

		for (const rail of [FBT, ALSO_BOUGHT]) {
			// Let the seeded recommend() resolve before deciding the rail is absent.
			await page.waitForTimeout(400);
			if ((await page.locator(rail).count()) === 0) continue;
			sawCoBuyRail = true;

			const items = page.locator(`${rail} li.rail-card`);
			expect(await items.count()).toBeGreaterThanOrEqual(1);
			const titles = (
				await page.locator(`${rail} .rail-card__title`).allTextContents()
			).map((t) => t.trim());
			// Co-occurrence never recommends the seed back to itself.
			expect(titles).not.toContain(seedTitle);
		}

		await page.locator(BACK).click();
		await expect(page.locator(PRODUCT_CARD).first()).toBeVisible();
	}

	// The seed demo has co-occurrence data: at least one of the scanned products
	// must surface a populated co-buy rail, or the integration is silently broken.
	expect(sawCoBuyRail).toBe(true);
});

test("clicks record + re-rank the For-You rail (backend-free hero loop)", async ({
	page,
}) => {
	await launch(page);

	// Settle the initial ambient dwell views, then capture the For-You order.
	await page.waitForTimeout(2_600);
	const before = (await page.locator(FOR_YOU_TITLE).allTextContents()).map(
		(t) => t.trim(),
	);
	await expect(page.locator(FOR_YOU_BADGE)).toHaveText("0");

	// Click 3 products. Each click records into the in-tab profile (badge ++)
	// and opens the PDP; Back returns home for the next click. No network.
	for (let i = 0; i < 3; i++) {
		await page.locator(PRODUCT_CARD).nth(i).click();
		await expect(page.locator(".pdp__title")).toBeVisible();
		await page.locator(BACK).click();
		await expect(page.locator(FOR_YOU_BADGE)).toHaveText(String(i + 1));
	}

	// The For-You rail re-ranked from the clicks, entirely in-tab.
	await expect
		.poll(
			async () =>
				(await page.locator(FOR_YOU_TITLE).allTextContents())
					.map((t) => t.trim())
					.join(" | "),
			{ message: "For-You rail should re-rank after 3 clicks (no backend)" },
		)
		.not.toBe(before.join(" | "));

	// "why?" reveals the complete Assay formula and Avow evidence for a pick. The in-app
	// Back now pops REAL history (v0.13.0), so the browser restores the browse
	// scroll position — scroll home first to unstack the sticky rails before
	// poking the For-You card's control.
	await page.evaluate(() => window.scrollTo(0, 0));
	const topCard = page.locator(`${FOR_YOU} li.rail-card`).first();
	await topCard.getByRole("button", { name: "why?" }).click();
	await expect(
		topCard.getByRole("heading", { name: "How calculated — Assay" }),
	).toBeVisible();
	await expect(topCard.locator(".why__row")).toHaveCount(9);
	await expect(
		topCard.getByRole("heading", { name: "Config provenance — Avow" }),
	).toBeVisible();

	await page.screenshot({
		path: "test-results/storefront.png",
		fullPage: true,
	});
});

for (const viewport of [
	{ name: "mobile", width: 320, height: 844 },
	{ name: "desktop", width: 1280, height: 900 },
] as const) {
	test(`Why equations remain fully readable without horizontal clipping on ${viewport.name}`, async ({
		page,
	}) => {
		await page.setViewportSize(viewport);
		await launch(page);

		const topCard = page.locator(`${FOR_YOU} li.rail-card`).first();
		await topCard.getByRole("button", { name: "why?" }).click();
		const equations = topCard.locator(".why__label-val");
		await expect(equations).toHaveCount(9);
		await expect(equations.first()).toBeVisible();
		const binary64Equation =
			"0.12345678901234568 × 0.9876543210987654 = +0.1219326311370218";
		await equations.first().evaluate((element, text) => {
			element.textContent = text;
		}, binary64Equation);
		await expect(equations.first()).toHaveText(binary64Equation);

		const layout = await equations.evaluateAll((elements) =>
			elements.map((element) => {
				const popover = element.closest<HTMLElement>(".why");
				const inner = element.closest<HTMLElement>(".why__inner");
				const card = element.closest<HTMLElement>(".rail-card");
				const range = document.createRange();
				range.selectNodeContents(element);
				const innerBounds = inner?.getBoundingClientRect();
				return {
					text: element.textContent ?? "",
					cardWidth: card?.clientWidth ?? Number.POSITIVE_INFINITY,
					noHorizontalOverflow:
						popover !== null && popover.scrollWidth <= popover.clientWidth + 1,
					linesInsidePopover:
						innerBounds !== undefined &&
						Array.from(range.getClientRects()).every(
							(line) =>
								line.left >= innerBounds.left - 1 &&
								line.right <= innerBounds.right + 1,
						),
				};
			}),
		);

		expect(layout.some(({ text }) => text === binary64Equation)).toBe(true);
		for (const equationLayout of layout) {
			expect(equationLayout.cardWidth, equationLayout.text).toBeLessThanOrEqual(
				280,
			);
			expect(equationLayout.noHorizontalOverflow, equationLayout.text).toBe(
				true,
			);
			expect(equationLayout.linesInsidePopover, equationLayout.text).toBe(true);
		}
	});
}

test("graded signals: favorite + cart count toward the For-You badge", async ({
	page,
}) => {
	await launch(page);
	await page.waitForTimeout(2_600);

	const firstCardActions = page
		.locator("main article.card")
		.first()
		.locator(".card__actions button");
	const toast = page.locator(".toast[role='status']");

	await firstCardActions.nth(0).click(); // favorite
	await expect(page.locator(FOR_YOU_BADGE)).toHaveText("1");
	await expect(firstCardActions.nth(0)).toHaveAttribute("aria-pressed", "true");
	await expect(toast).toContainText("strong signal");

	await firstCardActions.nth(1).click(); // add to cart
	await expect(page.locator(FOR_YOU_BADGE)).toHaveText("2");
	await expect(page.locator(".cart-pill")).toHaveText(/1/);
	await expect(toast).toContainText("nothing is purchased"); // first-add honesty
});
