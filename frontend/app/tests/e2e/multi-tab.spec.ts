import type { BrowserContext, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

/**
 * Several tabs of the store open at once, in ONE browser profile.
 *
 * The on-device vector database lives in OPFS behind SQLite's `opfs-sahpool`
 * VFS, and a SyncAccessHandle is exclusive per file: only one tab at a time can
 * hold it. Before the fix, the second tab failed to boot with "malformed catalog
 * bundle: … may already be open in another tab" and rendered zero products.
 *
 * The contract proven here: every tab renders the storefront, a vector-backed
 * PDP rail works in each, closing the tab that owns the database leaves the
 * others working, a new tab opened after that works, and reloads work.
 *
 * All pages share one BrowserContext, so they share OPFS, Web Locks and
 * sessionStorage-per-tab semantics exactly like real browser tabs.
 */

const PRODUCT_CARD = "main article.card button.card__overlay";
const SIMILAR_ITEM =
	"section.rail--row:has(h2:text-is('Similar items')) li.rail-card";
const EMBEDDING_DIM = 384;

/** The same deterministic embedder stub the storefront suite installs. */
async function stubEmbedder(context: BrowserContext): Promise<void> {
	await context.addInitScript((dim: number) => {
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
	await context.route(/m\.media-amazon\.com/, (route) => route.abort());
}

/** Open a fresh tab, cross the launch gate, and wait for real product cards. */
async function openStoreTab(context: BrowserContext): Promise<Page> {
	const page = await context.newPage();
	await page.goto("/");
	await page.getByRole("button", { name: "▶ Launch the live demo" }).click();
	await expectStorefront(page);
	return page;
}

async function expectStorefront(page: Page): Promise<void> {
	await expect(page.locator(".boot__error")).toHaveCount(0);
	await expect(page.locator(PRODUCT_CARD).first()).toBeVisible({
		timeout: 60_000,
	});
	await expect(page.locator(".boot__error")).toHaveCount(0);
}

/** Open a PDP: its Similar-items rail is a vector-index nearest() query. */
async function expectVectorRail(page: Page): Promise<void> {
	await page.locator(PRODUCT_CARD).first().click();
	await expect(page.locator(SIMILAR_ITEM).first()).toBeVisible();
	await page.locator("button.pdp__back").click();
	await expect(page.locator(PRODUCT_CARD).first()).toBeVisible();
}

test("a second tab in the same browser renders the storefront", async ({
	context,
}) => {
	await stubEmbedder(context);
	const first = await openStoreTab(context);
	const second = await openStoreTab(context);

	await expectVectorRail(first);
	await expectVectorRail(second);
});

test("closing the owning tab leaves other tabs working; new tabs and reloads boot", async ({
	context,
}) => {
	await stubEmbedder(context);
	const owner = await openStoreTab(context);
	const second = await openStoreTab(context);

	await owner.close();
	await expectVectorRail(second);

	const third = await openStoreTab(context);
	await expectVectorRail(third);

	await second.reload();
	await expectStorefront(second);
	await third.reload();
	await expectStorefront(third);
	await expectVectorRail(second);
	await expectVectorRail(third);
});
