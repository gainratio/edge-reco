import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "@playwright/test";
// @ts-expect-error -- plain-ESM harness, no types (same shape as tests/e2e-c1/catalog-server.mjs).
import { startPagesServer } from "../e2e-offline/pages-server.mjs";

/**
 * The production build must reach a rendered storefront on WebKit.
 *
 * Found 2026-10-03: in an ephemeral WebKit context (what Safari Private
 * Browsing is) `navigator.storage.getDirectory()` throws UnknownError, the
 * vector store failed to open, and the page stopped at "Couldn't start the
 * engine" with no way forward. The vector store now falls back to the same
 * SQLite engine in memory, so the shopper gets the full storefront.
 */

type Origin = { url: string; close: () => Promise<void> };
let origin: Origin;

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

/** The `storage` object catalogueSql.ts logs once the catalogue database opens. */
interface CatalogueStorage {
	readonly persistence: "opfs" | "memory";
	readonly reason?: string;
	readonly detail?: string;
}

const STORAGE_LOG = "[edge-reco] catalogue database storage";

/**
 * Where WebKit's catalogue database ACTUALLY ended up. Ephemeral WebKit (the
 * Safari Private Browsing stand-in) refuses OPFS — getDirectory() throws
 * UnknownError — so the engine must land in memory with reason
 * "opfs-unavailable". Pinning the exact mode catches a regression either way:
 * a storefront that silently stopped exercising the fallback, or a fallback
 * that started firing for the wrong reason (e.g. "pool-in-use").
 */
const EXPECTED_STORAGE: CatalogueStorage = {
	persistence: "memory",
	reason: "opfs-unavailable",
};

test("the storefront starts on WebKit, searches, and reports its storage mode", async ({
	page,
}) => {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(String(error)));
	const storage = new Promise<CatalogueStorage>((resolve) => {
		page.on("console", async (message) => {
			if (!message.text().startsWith(STORAGE_LOG)) return;
			resolve((await message.args()[1]?.jsonValue()) as CatalogueStorage);
		});
	});

	await page.goto(`${origin.url}/`);
	await page.getByRole("button", { name: "▶ Launch the live demo" }).click();

	await expect(
		page.getByText("Couldn’t start the engine"),
		"the engine must not stop at the error screen",
	).toHaveCount(0, { timeout: 5_000 });
	await expect(page.getByRole("heading", { name: "Browse" })).toBeVisible();
	await expect(page.getByRole("article").first()).toBeVisible();
	await expect(page.getByRole("article")).toHaveCount(24);

	const opened = await storage;
	expect({ persistence: opened.persistence, reason: opened.reason }).toEqual(
		EXPECTED_STORAGE,
	);

	// A real hybrid search (real model, real SQLite FTS5 + vector leg) on the
	// fallback database.
	await page
		.getByRole("searchbox", { name: "Search products" })
		.fill("mechanical gaming keyboard");
	await expect
		.poll(
			() =>
				page
					.locator("main article.card .card__title")
					.first()
					.innerText()
					.catch(() => ""),
			{ message: "search on WebKit should rank a keyboard first" },
		)
		.toMatch(/keyboard/i);
	expect(pageErrors).toEqual([]);
});

test("records whether this WebKit build grants OPFS to ephemeral contexts", async ({
	page,
}) => {
	await page.goto(`${origin.url}/`);
	const opfs = await page.evaluate(async () => {
		try {
			await navigator.storage.getDirectory();
			return "available";
		} catch (error) {
			return (error as Error).name;
		}
	});
	// Informational, not an assertion: macOS WebKit refuses OPFS here (the
	// private-browsing path this lane stands in for); other builds may not. The
	// annotation shows in the report so a lane that stopped covering the
	// fallback is visible rather than silently green.
	test.info().annotations.push({ type: "ephemeral-opfs", description: opfs });
});
