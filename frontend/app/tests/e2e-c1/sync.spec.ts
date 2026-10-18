import { expect, test } from "@playwright/test";

/**
 * C1 — the in-browser sync engine, proven in a REAL browser with REAL OPFS.
 *
 * The harness page spawns the Worker engine; the Worker owns OPFS (sync access
 * handles) and runs the ported `sync_index`. We drive it over the harness's
 * `window.__engineHarness` API and assert against real signals:
 *   - sync verifies + lands the live signed bundle in OPFS and promotes active,
 *   - readFile('catalog_meta.json') reassembles byte-correct (valid JSON),
 *   - the cache is the library's SQLite database on OPFS, and the chunks really
 *     landed on the device: after a reload a fresh Worker fetches nothing,
 *   - a re-sync fetches nothing (chunksFetched == 0 — only-changed-chunks proof),
 *   - a tampered /latest signature is rejected fail-closed (nothing promoted),
 *     surfaces on the main thread as EngineOperationError{code:"integrity"},
 *     and the app's real classifier reads it as bundle.integrity_failed.
 */

const CATALOG = "http://localhost:8910/catalog";
const CATALOG_TAMPERED = "http://localhost:8910/catalog-tampered";
const PUBKEY = "http://localhost:8910/public.key";

interface SyncResult {
	version: string;
	manifestHash: string;
	chunksFetched: number;
	chunksReused: number;
	bytesFetched: number;
	/** Where the chunk cache lives (@gainratio/browser >= 0.3.0). */
	cacheStorage: { persistence: "opfs" | "memory" };
}

declare global {
	interface Window {
		__engineHarness?: {
			sync(baseUrl: string, pubkeyUrl: string): Promise<SyncResult>;
			readFileText(path: string): Promise<string>;
			classify(error: unknown): string;
		};
	}
}

test.beforeEach(async ({ page }) => {
	await page.goto("/engine-harness.html");
	await expect(page.locator("#status")).toHaveText("engine-ready");
	// start each test from an empty OPFS so chunk counts are deterministic
	await page.evaluate(async () => {
		const root = await navigator.storage.getDirectory();
		for await (const name of (
			root as unknown as { keys(): AsyncIterable<string> }
		).keys()) {
			await root.removeEntry(name, { recursive: true });
		}
	});
});

test("sync lands the live signed bundle in OPFS and readFile reassembles", async ({
	page,
}) => {
	const result = await page.evaluate(
		([base, key]) => window.__engineHarness?.sync(base, key),
		[CATALOG, PUBKEY],
	);
	expect(result?.version).toBe("v1");
	expect(result?.chunksReused).toBe(0);
	expect(result?.chunksFetched ?? 0).toBeGreaterThan(0);

	// readFile goes through OPFS chunks → reassembly → file_sha256 check
	const metaText = await page.evaluate(() =>
		window.__engineHarness?.readFileText("catalog_meta.json"),
	);
	expect(metaText).toBeDefined();
	const meta = JSON.parse(metaText ?? "{}") as Record<string, unknown>;
	expect(typeof meta).toBe("object");

	// The chunks landed in the library's SQLite cache on OPFS, not in memory.
	// Since 0.3.0 that database is private to the library's SQL Worker, so the
	// proof is durability: after a reload, a brand-new Worker reuses every chunk.
	expect(result?.cacheStorage.persistence).toBe("opfs");
	await page.reload();
	await expect(page.locator("#status")).toHaveText("engine-ready");
	const afterReload = await page.evaluate(
		([base, key]) => window.__engineHarness?.sync(base, key),
		[CATALOG, PUBKEY],
	);
	expect(afterReload?.cacheStorage.persistence).toBe("opfs");
	expect(afterReload?.chunksFetched).toBe(0);
	expect(afterReload?.chunksReused).toBe(result?.chunksFetched);
});

test("re-sync after first sync fetches only-changed chunks (chunksFetched == 0)", async ({
	page,
}) => {
	const first = await page.evaluate(
		([base, key]) => window.__engineHarness?.sync(base, key),
		[CATALOG, PUBKEY],
	);
	expect(first?.chunksFetched ?? 0).toBeGreaterThan(0);

	const second = await page.evaluate(
		([base, key]) => window.__engineHarness?.sync(base, key),
		[CATALOG, PUBKEY],
	);
	expect(second?.chunksFetched).toBe(0);
	expect(second?.bytesFetched).toBe(0);
	expect(second?.chunksReused).toBe(first?.chunksFetched);
});

test("delta-sync from /catalog (v1) to /catalog-delta (v2) fetches only the 2 changed chunks and reuses 2,059 cached chunks", async ({
	page,
}) => {
	const first = await page.evaluate(
		([base, key]) => window.__engineHarness?.sync(base, key),
		[CATALOG, PUBKEY],
	);
	expect(first?.version).toBe("v1");
	expect(first?.chunksFetched).toBe(2061);
	expect(first?.chunksReused).toBe(0);

	const delta = await page.evaluate(
		([base, key]) => window.__engineHarness?.sync(base, key),
		[`${CATALOG}-delta`, PUBKEY],
	);
	expect(delta?.version).toBe("v2");
	expect(delta?.chunksFetched).toBe(2);
	expect(delta?.chunksReused).toBe(2059);
	expect(delta?.bytesFetched).toBeGreaterThan(0);
	expect(delta?.bytesFetched).toBeLessThan(60_000);
});

test("a tampered /latest signature is rejected fail-closed — nothing promoted", async ({
	page,
}) => {
	const outcome = await page.evaluate(
		async ([base, key]) => {
			try {
				await window.__engineHarness?.sync(base, key);
				return {
					rejected: false,
					message: "",
					name: "",
					code: "",
					canonical: "",
				};
			} catch (error) {
				const code = (error as { code?: unknown } | null)?.code;
				return {
					rejected: true,
					message: error instanceof Error ? error.message : String(error),
					name: error instanceof Error ? error.name : "",
					code: typeof code === "string" ? code : "",
					canonical: window.__engineHarness?.classify(error) ?? "",
				};
			}
		},
		[CATALOG_TAMPERED, PUBKEY],
	);
	expect(outcome.rejected).toBe(true);
	// The Worker's fail-closed refusal crosses the boundary with its stable
	// category intact, and the app classifies it as an integrity failure —
	// never a retryable network error or an unknown one.
	expect(outcome.name).toBe("EngineOperationError");
	expect(outcome.code).toBe("integrity");
	expect(outcome.canonical).toBe("bundle.integrity_failed");

	// nothing landed: no `active` pointer, no chunk dir created with content
	const promoted = await page.evaluate(async () => {
		const root = await navigator.storage.getDirectory();
		try {
			await root.getFileHandle("active");
			return true;
		} catch {
			return false;
		}
	});
	expect(promoted).toBe(false);
});
