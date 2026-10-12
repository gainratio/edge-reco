import { expect, type Page, test } from "@playwright/test";

/**
 * Stuck returning shopper → explicit "Clear cached catalog and retry".
 *
 * @gainratio/browser keeps the stored pointer as the anti-rollback floor even
 * when the current key can't verify it. So a republish with a LOWER `sequence`
 * (a lost/regenerated signing key) or a changed bundle_id/channel refuses on
 * every Retry. This lane proves, against the REAL sync Worker and REAL OPFS,
 * that:
 *
 *   - a rollback refusal shows the tampering warning, Retry alone never
 *     clears, and the clear needs an inline second click ("Yes, clear and
 *     retry") before anything is touched;
 *   - a non-rollback integrity refusal (a changed bundle identity) offers a
 *     single-click clear;
 *   - the refusal survives a reload until the user confirms the clear;
 *   - after the clear, the catalog loads and loads again after a reload, and
 *     nothing outside the edgeproc bundle cache was touched (a
 *     `transformers-cache` CacheStorage entry and an unrelated OPFS file
 *     survive), per the live-user storage covenant.
 *
 * Since @gainratio/browser 0.3.0 the floor lives in a library-owned SQLite
 * database on OPFS, reachable only through the library's SQL Worker. This
 * lane therefore proves the floor by what the shopper sees (a refusal that
 * outlives Retry and a reload; a catalog that loads after the clear), not by
 * reading the library's private storage. The library's own browser suite
 * pins the floor row itself.
 *
 * Only the embedder is stubbed (as in storefront.spec.ts) so no ~25 MB model
 * download gates the run.
 */

const LAUNCH = "▶ Launch the live demo";
const PRODUCT_CARD = "main article.card button.card__overlay";
const CLEAR = "Clear cached catalog and retry";
const CONFIRM = "Yes, clear and retry";
const EMBEDDING_DIM = 384;

/**
 * Where @gainratio/browser 0.2.x kept its IndexedDB rollback floor. The seed
 * writes a 0.2.x-era returning shopper; 0.3+ migrates it into SQLite once.
 */
const FLOOR_DB = "edgeproc-browser-cache";
const FLOOR_STORE = "content-addressed-cache";

interface SeedPointer {
	readonly sequence: number;
	readonly bundle_id: string;
	readonly channel: string;
}

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
	await page.route(/m\.media-amazon\.com/, (route) => route.abort());
});

/**
 * Seed a returning shopper's durable state in the 0.2.x layout: a
 * structurally valid stored pointer in OPFS `active.a` and the IndexedDB
 * floor, which the library migrates into its SQLite floor on first sync, plus
 * two sentinels that the clear must NOT touch.
 */
async function seedReturningShopper(
	page: Page,
	pointer: SeedPointer,
): Promise<void> {
	await page.evaluate(
		async ({ pointer, floorDb, floorStore }) => {
			const stored = JSON.stringify({
				manifest_hash: "f".repeat(64),
				version: `v${pointer.sequence}`,
				bundle_id: pointer.bundle_id,
				channel: pointer.channel,
				sequence: pointer.sequence,
				// Unverifiable on purpose: the floor is kept without re-verifying.
				signature: "A".repeat(88),
			});
			const bytes = new TextEncoder().encode(stored);

			const root = await navigator.storage.getDirectory();
			const slot = await root.getFileHandle("active.a", { create: true });
			const slotWriter = await slot.createWritable();
			await slotWriter.write(bytes);
			await slotWriter.close();
			// An unrelated OPFS file the clear must leave alone.
			const other = await root.getFileHandle("unrelated-sentinel.txt", {
				create: true,
			});
			const otherWriter = await other.createWritable();
			await otherWriter.write("keep me");
			await otherWriter.close();

			await new Promise<void>((resolve, reject) => {
				const open = indexedDB.open(floorDb, 1);
				open.onupgradeneeded = () => {
					open.result.createObjectStore(floorStore);
				};
				open.onerror = () => reject(open.error);
				open.onsuccess = () => {
					const db = open.result;
					const tx = db.transaction(floorStore, "readwrite");
					tx.objectStore(floorStore).put(bytes, "active");
					tx.oncomplete = () => {
						db.close();
						resolve();
					};
					tx.onerror = () => reject(tx.error);
				};
			});

			// The self-hosted model's cache name — the covenant forbids touching it.
			const cache = await caches.open("transformers-cache");
			await cache.put("/sentinel", new Response("model bytes"));
		},
		{ pointer, floorDb: FLOOR_DB, floorStore: FLOOR_STORE },
	);
}

/** The storage-covenant sentinels, still present after the clear? */
async function sentinelsSurvive(page: Page): Promise<boolean> {
	return page.evaluate(async () => {
		// `caches.has` first, so the check itself never creates the cache.
		if (!(await caches.has("transformers-cache"))) {
			return false;
		}
		const model = await (await caches.open("transformers-cache")).match(
			"/sentinel",
		);
		const root = await navigator.storage.getDirectory();
		const file = await (
			await root.getFileHandle("unrelated-sentinel.txt")
		).getFile();
		return (
			model !== undefined &&
			(await model.text()) === "model bytes" &&
			(await file.text()) === "keep me"
		);
	});
}

async function launch(page: Page): Promise<void> {
	await page.getByRole("button", { name: LAUNCH }).click();
}

/**
 * A returning visit: reload the page. A returning shopper's demo boots on its
 * own, so there is no launch button to click.
 */
async function returnVisit(page: Page): Promise<void> {
	await page.reload();
	await expect(page.getByRole("button", { name: LAUNCH })).toHaveCount(0);
}

test("a rollback refusal warns, never clears on Retry, and clears only after the inline confirm", async ({
	page,
}) => {
	const logs: string[] = [];
	page.on("console", (message) => logs.push(message.text()));
	await page.goto("/");
	await seedReturningShopper(page, {
		sequence: 999,
		bundle_id: "amazon-demo",
		channel: "stable",
	});

	await launch(page);
	await expect(page.getByText(/someone is tampering/i)).toBeVisible();
	await expect(page.getByRole("button", { name: CLEAR })).toBeVisible();
	expect(
		logs.some((line) => line.includes("[edge-reco:bundle.integrity_failed]")),
	).toBe(true);

	// Retry alone re-runs the same fail-closed sync — and never clears.
	await page.getByRole("button", { name: "Retry", exact: true }).click();
	await expect(page.getByText(/someone is tampering/i)).toBeVisible();

	// Step one only arms the confirm: still nothing cleared.
	await page.getByRole("button", { name: CLEAR }).click();
	await expect(page.getByRole("button", { name: CONFIRM })).toBeVisible();
	await page.screenshot({ path: "test-results/recovery-rollback-confirm.png" });

	// Walking away and coming back still refuses: the floor is durable.
	await returnVisit(page);
	await expect(page.getByText(/someone is tampering/i)).toBeVisible();
	await page.getByRole("button", { name: CLEAR }).click();

	// Step two clears the bundle cache + both floors, then boots for real.
	await page.getByRole("button", { name: CONFIRM }).click();
	await expect(page.locator(PRODUCT_CARD).first()).toBeVisible({
		timeout: 60_000,
	});
	expect(await sentinelsSurvive(page)).toBe(true);
	await returnVisit(page);
	await expect(page.locator(PRODUCT_CARD).first()).toBeVisible({
		timeout: 60_000,
	});
	await page.screenshot({ path: "test-results/recovery-rollback-loaded.png" });
});

test("a changed bundle identity offers a single-click clear that loads the catalog", async ({
	page,
}) => {
	await page.goto("/");
	await seedReturningShopper(page, {
		sequence: 1,
		bundle_id: "retired-demo",
		channel: "stable",
	});

	await launch(page);
	await expect(page.getByRole("button", { name: CLEAR })).toBeVisible();
	await expect(
		page.getByText(/saved copy of the catalog in this browser/i),
	).toBeVisible();
	await expect(page.getByText(/someone is tampering/i)).toHaveCount(0);

	await page.getByRole("button", { name: CLEAR }).click();
	await expect(page.locator(PRODUCT_CARD).first()).toBeVisible({
		timeout: 60_000,
	});
	expect(await sentinelsSurvive(page)).toBe(true);
	await returnVisit(page);
	await expect(page.locator(PRODUCT_CARD).first()).toBeVisible({
		timeout: 60_000,
	});
});
