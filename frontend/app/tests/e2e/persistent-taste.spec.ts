import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

/**
 * Durable on-device taste — the four property guards this feature adds:
 *
 *   (a) clicks re-rank the For-You rail (explicit here; also guarded by
 *       storefront.spec.ts's hero-loop test);
 *   (b) a FULL RELOAD retains the taste: the taste log (a table in the
 *       on-device SQLite database, kept in OPFS) replays through the same fold
 *       on boot, so the badge restores and the rail stays personalized — the
 *       "0 backend calls" headline stays true because nothing leaves the tab;
 *   (c) browser Back from the PDP stays IN-APP (hash history + popstate — no
 *       document unload), and a reload on a PDP hash restores the PDP with
 *       taste intact;
 *   (d) "Reset taste" returns the rail to the baseline a brand-new visitor
 *       sees and zeroes the badge.
 *
 *   (e) a RETURNING visitor from an older build (taste in the OPFS file
 *       taste/events.jsonl, a session id and an uplink queue in localStorage)
 *       is migrated: the taste is copied into SQLite and replayed, then the
 *       file and both localStorage keys are gone.
 *
 * REAL vs STUBBED matches storefront.spec.ts: real sync/OPFS/search engine
 * and the real SQLite database for the taste log; only the embedder transport is
 * a deterministic stub so no ~25 MB model download gates the run.
 */

const PRODUCT_CARD = "main article.card button.card__overlay";
const FOR_YOU = "section.rail--row:has(h2:text-is('Recommended for you'))";
const FOR_YOU_BADGE = `${FOR_YOU} .clicks-badge`;
const FOR_YOU_TITLE = `${FOR_YOU} .rail-card__title`;
const BACK = "button.pdp__back";
const RESET_TASTE = `${FOR_YOU} button.rail__reset`;
const LAUNCH = "▶ Launch the live demo";

const EMBEDDING_DIM = 384;

test.beforeEach(async ({ page }) => {
	// Deterministic embedder via the demo's narrow test hook (see
	// storefront.spec.ts for the rationale); images blocked for offline runs.
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
	await page.route(/m\.media-amazon\.com/, (route) => route.abort());
});

/** Cross the launch gate when present and wait for the storefront grid. */
async function launch(page: import("@playwright/test").Page): Promise<void> {
	const launchButton = page.getByRole("button", { name: LAUNCH });
	if (await launchButton.isVisible()) {
		await launchButton.click();
	}
	await expect(page.locator(PRODUCT_CARD).first()).toBeVisible({
		timeout: 60_000,
	});
}

/** The For-You rail's current visible order, joined for comparison. */
async function forYouOrder(
	page: import("@playwright/test").Page,
): Promise<string> {
	return (await page.locator(FOR_YOU_TITLE).allTextContents())
		.map((t) => t.trim())
		.join(" | ");
}

/** Click `n` grid products, returning home after each PDP visit. */
async function clickProducts(
	page: import("@playwright/test").Page,
	n: number,
	badgeStart = 0,
): Promise<void> {
	for (let i = 0; i < n; i += 1) {
		await page.locator(PRODUCT_CARD).nth(i).click();
		await expect(page.locator(".pdp__title")).toBeVisible();
		await page.locator(BACK).click();
		await expect(page.locator(FOR_YOU_BADGE)).toHaveText(
			String(badgeStart + i + 1),
		);
	}
}

test("(a)+(b) clicks personalize the rail, and a FULL RELOAD retains the taste", async ({
	page,
}) => {
	await page.goto("/");
	await launch(page);

	// Settle the initial ambient dwell views, then capture the pre-click order.
	await page.waitForTimeout(2_600);
	const cold = await forYouOrder(page);
	await expect(page.locator(FOR_YOU_BADGE)).toHaveText("0");

	// (a) three clicks re-rank the For-You rail, entirely in-tab.
	await clickProducts(page, 3);
	await expect
		.poll(() => forYouOrder(page), {
			message: "For-You should re-rank after 3 clicks",
		})
		.not.toBe(cold);
	await page.screenshot({ path: "test-results/persist-before-reload.png" });

	// (b) a real document reload — previously this wiped the profile.
	await page.reload();
	await launch(page);
	await expect(page.getByRole("button", { name: LAUNCH })).toHaveCount(0);

	// The badge restores from the replayed SQLite log (views never count) …
	await expect(page.locator(FOR_YOU_BADGE)).toHaveText("3");
	// … and the rail is still personalized, not back to the cold order.
	await expect
		.poll(() => forYouOrder(page), {
			message: "For-You should stay personalized after a reload (replay)",
		})
		.not.toBe(cold);
	await page.screenshot({ path: "test-results/persist-after-reload.png" });
});

test("(c) browser Back leaves the PDP but stays in-app; reload restores the PDP view", async ({
	page,
}) => {
	await page.goto("/");
	await launch(page);

	await page.locator(PRODUCT_CARD).first().click();
	await expect(page.locator(".pdp__title")).toBeVisible();
	expect(new URL(page.url()).hash).toMatch(/^#\/p\//);

	// Browser Back: popstate — NOT a document unload, NOT the Landing page.
	await page.goBack();
	await expect(page.locator(".pdp__title")).not.toBeVisible();
	await expect(page.locator(PRODUCT_CARD).first()).toBeVisible();
	await expect(page.getByRole("button", { name: LAUNCH })).toHaveCount(0);
	// Taste survived: no unload happened, the badge (home view) counts the click.
	await expect(page.locator(FOR_YOU_BADGE)).toHaveText("1");
	await page.screenshot({ path: "test-results/persist-back-in-app.png" });

	// A REAL reload on a PDP hash restores the PDP view — with taste intact.
	// (The storefront mounts straight into the PDP, so wait on the PDP hero,
	// not the browse grid.)
	await page.locator(PRODUCT_CARD).first().click();
	await expect(page.locator(".pdp__title")).toBeVisible();
	await page.reload();
	await expect(page.getByRole("button", { name: LAUNCH })).toHaveCount(0);
	await expect(page.locator(".pdp__title")).toBeVisible({ timeout: 60_000 });
	// Back home: the badge restored BOTH clicks from the replayed log.
	await page.locator(BACK).click();
	await expect(page.locator(FOR_YOU_BADGE)).toHaveText("2");
});

test("(d) Reset taste returns the For-You rail to baseline and zeroes the badge", async ({
	page,
}) => {
	await page.goto("/");
	await launch(page);

	// Settled baseline: the ambient dwell views of the visible grid cards have
	// folded. After a reset the SAME cards re-dwell (caps re-armed), so the
	// profile converges back to this same settled state — affinity bumps are
	// commutative and repetition penalty is set-membership, so the comparison
	// is deterministic.
	await page.waitForTimeout(2_600);
	const settled = await forYouOrder(page);

	await clickProducts(page, 3);
	await expect.poll(() => forYouOrder(page)).not.toBe(settled);

	await page.locator(RESET_TASTE).click();

	// The truth-telling toast + the zeroed badge.
	await expect(page.locator(".toast[role='status']")).toContainText(
		"stored only in this browser",
	);
	await expect(page.locator(FOR_YOU_BADGE)).toHaveText("0");

	// The rail re-ranks back to the settled baseline once the same ambient
	// views re-fold (poll generously; dwell re-fires ~2s after reset).
	await expect
		.poll(() => forYouOrder(page), {
			message: "For-You should return to the baseline after Reset taste",
			timeout: 15_000,
		})
		.toBe(settled);
	await page.screenshot({ path: "test-results/persist-after-reset.png" });

	// And the reset itself is durable: a reload replays an EMPTY log.
	await page.reload();
	await launch(page);
	await expect(page.locator(FOR_YOU_BADGE)).toHaveText("0");
});

/** The first `n` product ids of the committed signed catalog's source. */
function catalogIds(n: number): string[] {
	const path = new URL(
		"../../../../backend/examples/source/catalog.csv",
		import.meta.url,
	);
	return readFileSync(path, "utf8")
		.split("\n")
		.slice(1, n + 1)
		.map((line) => line.split(",")[0] ?? "");
}

test("(e) a returning visitor's old OPFS taste file and localStorage keys migrate into SQLite", async ({
	page,
}) => {
	const ids = catalogIds(3);
	await page.goto("/");
	// What an older build left behind, written while the engine is still cold.
	await page.evaluate(async (productIds: string[]) => {
		localStorage.setItem("nimbus_session_id", "old-session-id");
		localStorage.setItem(
			"nimbus_uplink_queue",
			JSON.stringify([{ event_type: "click", product_id: productIds[0] }]),
		);
		const root = await navigator.storage.getDirectory();
		const dir = await root.getDirectoryHandle("taste", { create: true });
		const file = await dir.getFileHandle("events.jsonl", { create: true });
		const writable = await file.createWritable();
		const lines = productIds.map((productId) =>
			JSON.stringify({
				v: 1,
				ts: "2026-09-01T00:00:00.000Z",
				type: "click",
				productId,
				sessionId: "old-session-id",
			}),
		);
		await writable.write(`${lines.join("\n")}\n`);
		await writable.close();
	}, ids);

	await launch(page);
	// The three old clicks were copied into SQLite and replayed.
	await expect(page.locator(FOR_YOU_BADGE)).toHaveText("3");
	await expect(
		page.getByRole("status").filter({ hasText: "on-device" }),
	).toContainText("saved only in this browser");
	// Copy-then-retire: the old file and both old keys are gone.
	const leftovers = await page.evaluate(async () => {
		const root = await navigator.storage.getDirectory();
		let tasteDir = true;
		try {
			await root.getDirectoryHandle("taste");
		} catch {
			tasteDir = false;
		}
		return {
			tasteDir,
			session: localStorage.getItem("nimbus_session_id"),
			queue: localStorage.getItem("nimbus_uplink_queue"),
		};
	});
	expect(leftovers).toEqual({ tasteDir: false, session: null, queue: null });

	// And the taste now lives in SQLite: it survives a reload with no file.
	await page.reload();
	await launch(page);
	await expect(page.locator(FOR_YOU_BADGE)).toHaveText("3");
});
