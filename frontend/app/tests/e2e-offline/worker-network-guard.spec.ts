import { expect, test } from "@playwright/test";

/**
 * THE "0 backend calls" tile must measure the PROPERTY, not its shape.
 *
 * The storefront's headline claim is that the recommendation pipeline runs
 * entirely in the tab: after sync, nothing leaves the browser. The tile that
 * backs that claim used to be counted from a main-thread `PerformanceObserver`
 * alone — and a Web Worker keeps its OWN resource-timing timeline, invisible to
 * the window. So a `fetch()` issued from inside the app's Worker (where the
 * pipeline actually runs) left the browser while the tile kept proudly showing
 * "0". The counter measured the shape of the claim, not the claim.
 *
 * This spec breaks the PROPERTY: it runs a genuine `fetch()` inside the app's
 * real, live embedder Worker and asserts the tile stops saying zero. Nothing is
 * stubbed — `Worker.evaluate()` executes in that Worker's real global scope, so
 * this is byte-for-byte what a compromised dependency inside the Worker would
 * do.
 *
 * WHY THIS LANE: only the offline/preview config runs the PRODUCTION build with
 * the REAL embedder Worker (the main e2e lane stubs the embedder away, so no
 * app Worker outlives boot there) AND renders the storefront that owns the
 * tile. Real build + real Worker + real tile is the only place the property is
 * observable end to end.
 *
 * WHY A SAME-ORIGIN URL: production ships `connect-src 'self'`, so a
 * same-origin request is the only exfiltration a Worker could actually perform
 * — the realistic attack, not a strawman. `/__exfil__` is not a bundled asset
 * and not the signed-bundle edge origin, so it classifies as a real backend
 * call.
 */

const PRODUCT_CARD = "main article.card button.card__overlay";
const RAIL_CARD = "section.rail--row .rail__track-list img";
const EXFIL_MARKER = "__exfil__";
const EXFIL_PATH = `/${EXFIL_MARKER}?q=what-the-user-searched-for`;

/** The live "backend calls" tile in the storefront metrics strip. */
function backendCallsTile(page: import("@playwright/test").Page) {
	return page
		.locator(".metrics-strip__tile")
		.filter({ hasText: "backend calls" })
		.locator(".metrics-strip__value");
}

/** Cross the launch gate and wait for the storefront to mount (real model). */
async function launch(page: import("@playwright/test").Page): Promise<void> {
	await page.goto("/");
	await page.getByRole("button", { name: "▶ Launch the live demo" }).click();
	await expect(page.locator(PRODUCT_CARD).first()).toBeVisible({
		timeout: 240_000,
	});
}

/**
 * The app's embedder Worker — where every query embedding is computed, and the
 * pipeline context still running when the user is looking at the tile. Picked
 * by its script name, never "any worker": the SQLite Worker is also alive, and
 * attacking it by accident would test a different context.
 */
const EMBEDDER_WORKER = /\/embedderWorker[-.][^/]*\.js(?:$|\?)/u;

async function embedderWorker(page: import("@playwright/test").Page) {
	await expect
		.poll(
			() => page.workers().filter((w) => EMBEDDER_WORKER.test(w.url())).length,
			{
				message: `exactly one embedder Worker must be live (saw ${page
					.workers()
					.map((w) => w.url())
					.join(", ")})`,
				timeout: 30_000,
			},
		)
		.toBe(1);
	const worker = page.workers().find((w) => EMBEDDER_WORKER.test(w.url()));
	if (worker === undefined) {
		throw new Error("embedder Worker vanished between poll and pick");
	}
	return worker;
}

/**
 * Deterministic quiet point for the window's timeline. A visible first card is
 * not "settled": rails populate asynchronously and their images are
 * `loading="lazy"`, so a late layout shift used to pull new images into view
 * AFTER the baseline (the old `networkidle` wait raced that). Wait for the
 * rails to render, force every image to load now, and wait until each one is
 * complete. After this point no window-side image request is still pending.
 */
async function settleWindowTraffic(
	page: import("@playwright/test").Page,
): Promise<void> {
	await expect(page.locator(RAIL_CARD).first()).toBeVisible({
		timeout: 60_000,
	});
	await expect
		.poll(
			() =>
				page.evaluate(() => {
					const images = Array.from(document.images);
					for (const image of images) image.loading = "eager";
					return images.every((image) => image.complete);
				}),
			{
				message: "every storefront image must finish loading",
				timeout: 60_000,
			},
		)
		.toBe(true);
}

/** Every resource URL in a context's OWN performance timeline. */
const RESOURCE_NAMES = () =>
	performance.getEntriesByType("resource").map((entry) => entry.name);

test("a network call issued INSIDE the app's Web Worker is counted by the tile", async ({
	page,
}) => {
	test.setTimeout(300_000);
	await launch(page);

	const tile = backendCallsTile(page);
	await expect(tile).toHaveText("0");
	await settleWindowTraffic(page);
	const before = await page.evaluate(RESOURCE_NAMES);

	// The attack: real fetch, real Worker global scope, real network stack.
	const worker = await embedderWorker(page);
	const leaked = await worker.evaluate(async (path: string) => {
		const response = await fetch(path, { cache: "no-store" }).catch(() => null);
		return response !== null;
	}, EXFIL_PATH);
	expect(
		leaked,
		"the Worker's exfiltration request must reach the network",
	).toBe(true);

	// The tile must stop claiming zero: data left the browser.
	await expect(tile).not.toHaveText("0", { timeout: 30_000 });

	// ATTRIBUTION — without this the test could pass on an unrelated request and
	// would no longer measure the property. The window's own timeline must NOT
	// contain the Worker's request (that blindness is the whole point), the
	// Worker's timeline must, and nothing else may have appeared in the window
	// while the count moved.
	const after = await page.evaluate(RESOURCE_NAMES);
	expect(
		after.some((name) => name.includes(EXFIL_MARKER)),
		"the window must remain blind to the Worker's request",
	).toBe(false);
	expect(
		await worker.evaluate(
			(marker: string) =>
				performance
					.getEntriesByType("resource")
					.some((entry) => entry.name.includes(marker)),
			EXFIL_MARKER,
		),
		"the request must be in the Worker's own timeline",
	).toBe(true);
	expect(
		after.filter((name) => !before.includes(name)),
		"no window-side request may explain the count moving",
	).toEqual([]);

	await page.screenshot({
		path: "test-results/worker-network-guard.png",
		fullPage: false,
	});
});
