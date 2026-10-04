import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "@playwright/test";
// @ts-expect-error -- plain-ESM harness, no types (same shape as tests/e2e-c1/catalog-server.mjs).
import { startPagesServer } from "../e2e-offline/pages-server.mjs";

/**
 * The shopper journey on the production build, per browser engine: boot the
 * engine, run a real search (the REAL embedding model, no stub), open a
 * product page and read it.
 *
 * Runs under playwright.browsers.config.ts on Firefox (Gecko) and Edge. The
 * Chromium lane (tests/e2e) and the WebKit lane (tests/e2e-webkit) cover the
 * other two engines.
 */

interface Origin {
	readonly url: string;
	close(): Promise<void>;
}
let origin: Origin;

const CARD = "main article.card";
const CARD_ACTION = `${CARD} button.card__overlay`;

test.beforeAll(async () => {
	const dist = join(dirname(test.info().config.configFile ?? ""), "dist");
	if (!existsSync(join(dist, "index.html"))) {
		throw new Error(`no production build at ${dist} — run build:pages first`);
	}
	origin = await startPagesServer({ root: dist });
});

test.afterAll(async () => {
	await origin?.close();
});

test("boot, search and open a product page", async ({ page }) => {
	test.setTimeout(300_000);
	const edgeChannel = test.info().project.metadata.edgeChannel;
	if (edgeChannel === false) {
		test.info().annotations.push({
			type: "edge-channel",
			description:
				"Microsoft Edge is not installed here; ran stock Chromium (Edge's engine) instead",
		});
	}
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(String(error)));

	await page.goto(`${origin.url}/`);
	const launchedAt = Date.now();
	await page.getByRole("button", { name: "▶ Launch the live demo" }).click();
	await expect(page.locator(CARD).first()).toBeVisible({ timeout: 240_000 });
	test.info().annotations.push({
		type: "boot-ms",
		description: String(Date.now() - launchedAt),
	});

	const search = page.getByRole("searchbox", { name: "Search products" });
	await search.fill("mechanical gaming keyboard");
	await expect
		.poll(
			() =>
				page
					.locator(`${CARD} .card__title`)
					.first()
					.innerText()
					.catch(() => ""),
			{
				message: "a real hybrid search should rank a keyboard first",
				timeout: 60_000,
			},
		)
		.toMatch(/keyboard/i);

	const firstCard = page.locator(CARD).first();
	const title = (await firstCard.locator(".card__title").innerText()).trim();
	await page.locator(CARD_ACTION).first().click();

	const product = page.getByRole("article", { name: title });
	await expect(product.getByRole("heading", { level: 1 })).toHaveText(title);
	await expect(product.locator(".pdp__price")).toHaveText(/\d/);
	await expect(product.locator(".pdp__cat")).not.toBeEmpty();
	await expect(
		page.locator("section.rail--row:has(h2:text-is('Similar items'))"),
	).toBeVisible();
	expect(pageErrors).toEqual([]);
});
