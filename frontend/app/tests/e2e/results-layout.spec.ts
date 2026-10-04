import { expect, type Page, test } from "@playwright/test";

/**
 * Search-results layout on a phone and a desktop, in a real browser.
 *
 * Three shopper-visible promises, each one a bug Harish hit on a 390px phone:
 *   1. The query shows ONCE — in the search box. No banner or heading repeats it.
 *   2. The first product card is in the first viewport on a phone: the header,
 *      metrics strip and results label must not push it below the fold.
 *   3. Nothing is cut off: no horizontal page overflow, and every metrics-strip
 *      tile sits fully inside the strip (wrapped, not clipped off the right edge).
 *
 * Same backend-free harness as storefront.spec.ts: the real engine over the real
 * signed 720-product bundle, with only the embedder transport stubbed.
 */

const QUERY = "stadium seat";
const EMBEDDING_DIM = 384;
const GRID_CARD = "main .grid-section article.card";
// Phone budget for the first card's top edge (document px). The pre-fix stack
// put it at ~455px; the header + results label must leave room above the fold.
const PHONE_FIRST_CARD_TOP_MAX = 400;

const VIEWPORTS = [
	{ name: "phone", width: 390, height: 844 },
	{ name: "desktop", width: 1440, height: 900 },
] as const;

test.beforeEach(async ({ page }) => {
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
});

/** Launch, search, and wait until the result grid (not skeletons) has landed. */
async function searchFor(page: Page, query: string): Promise<void> {
	await page.goto("/");
	await page.getByRole("button", { name: "▶ Launch the live demo" }).click();
	await expect(page.locator(GRID_CARD).first()).toBeVisible({
		timeout: 60_000,
	});
	await page.getByRole("searchbox").fill(query);
	// The polite live region names the landed query (screen-reader announcement).
	await expect(page.locator(".results-cue")).toContainText(query);
	await expect(page.locator("main .section-head__count")).toBeVisible();
	await expect(page.locator("main .grid-section .skeleton")).toHaveCount(0);
	await expect(page.locator(GRID_CARD).first()).toBeVisible();
	// Entering search smooth-scrolls to the top; settle there before measuring.
	await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
}

/** How often the UI (not a product title) echoes `query` in text a sighted shopper can see. */
function visibleQueryCount(page: Page, query: string): Promise<number> {
	return page.evaluate((q) => {
		const walker = document.createTreeWalker(
			document.body,
			NodeFilter.SHOW_TEXT,
		);
		let count = 0;
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			const el = node.parentElement;
			if (!el?.checkVisibility({ visibilityProperty: true })) continue;
			// Product titles may legitimately contain the words; count UI echoes only.
			if (el.closest("article.card, li.rail-card")) continue;
			const rect = el.getBoundingClientRect();
			// A 1px clipped live region is screen-reader-only, not visible copy.
			if (rect.width <= 1 || rect.height <= 1) continue;
			count += (node.textContent ?? "").toLowerCase().split(q).length - 1;
		}
		return count;
	}, query.toLowerCase());
}

for (const vp of VIEWPORTS) {
	test.describe(`search results at ${vp.width}x${vp.height}`, () => {
		test.use({ viewport: { width: vp.width, height: vp.height } });

		test("the query shows once, in the search box only", async ({ page }) => {
			await searchFor(page, QUERY);
			await expect(page.getByRole("searchbox")).toHaveValue(QUERY);
			expect(await visibleQueryCount(page, QUERY)).toBe(0);
		});

		test("no horizontal overflow and the metrics strip is not clipped", async ({
			page,
		}) => {
			await searchFor(page, QUERY);
			const layout = await page.evaluate(() => {
				const strip = document.querySelector(".metrics-strip");
				const box = strip?.getBoundingClientRect();
				// The sticky header paints over anything above its bottom edge.
				const headerBottom =
					document.querySelector(".nimbus-header")?.getBoundingClientRect()
						.bottom ?? 0;
				const tiles = [
					...document.querySelectorAll(".metrics-strip__tile"),
				].map((t) => t.getBoundingClientRect());
				const clipped = tiles.filter(
					(t) =>
						box === undefined ||
						t.left < box.left - 0.5 ||
						t.right > box.right + 0.5 ||
						t.right > window.innerWidth + 0.5 ||
						t.top < headerBottom - 0.5,
				).length;
				const tooWide = [...document.querySelectorAll("body *")].filter(
					(el) => el.getBoundingClientRect().width > window.innerWidth + 0.5,
				).length;
				return {
					scrollWidth: document.documentElement.scrollWidth,
					innerWidth: window.innerWidth,
					tiles: tiles.length,
					clipped,
					tooWide,
				};
			});
			expect(layout.scrollWidth).toBeLessThanOrEqual(layout.innerWidth);
			expect(layout.tooWide).toBe(0);
			expect(layout.tiles).toBeGreaterThanOrEqual(4);
			expect(layout.clipped).toBe(0);
		});

		test("the first product card starts in the first viewport", async ({
			page,
		}) => {
			await searchFor(page, QUERY);
			const top = await page
				.locator(GRID_CARD)
				.first()
				.evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
			const budget =
				vp.width < 720 ? PHONE_FIRST_CARD_TOP_MAX : vp.height * 0.6;
			expect(top).toBeLessThan(budget);
		});
	});
}
