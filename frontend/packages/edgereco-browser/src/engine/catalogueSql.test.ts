import { afterEach, describe, expect, it, vi } from "vitest";
import { nodeSqlWorkerFactory } from "./__fixtures__/nodeSqlWorker";

// testSetup.ts wraps this module for every other spec; here we want the real one.
const seam =
	await vi.importActual<typeof import("./catalogueSql")>("./catalogueSql");

/** sha256("edgereco-catalog"), first 16 bytes — the pool main's build created. */
const LEGACY_POOL_DIR = ".edgeproc-vector-aee9d7e7fe483930ecfa7c84cc1508f0";

/** An OPFS root that holds the given directories until they are removed. */
function fakeRoot(entries: Set<string>, failWith?: string) {
	return {
		removeEntry: vi.fn(async (name: string) => {
			if (failWith !== undefined) {
				throw Object.assign(new Error(failWith), { name: failWith });
			}
			if (!entries.delete(name)) {
				throw Object.assign(new Error("missing"), { name: "NotFoundError" });
			}
		}),
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("retireLegacyVectorPool", () => {
	it("removes the vector pool main's build left behind, then reports it absent", async () => {
		const entries = new Set([LEGACY_POOL_DIR, ".edgeproc-sql-keep"]);
		const root = fakeRoot(entries);
		const log = vi.fn();

		expect(await seam.retireLegacyVectorPool({ root, log })).toBe("removed");
		expect(await seam.retireLegacyVectorPool({ root, log })).toBe("absent");

		expect(root.removeEntry).toHaveBeenNthCalledWith(1, LEGACY_POOL_DIR, {
			recursive: true,
		});
		expect([...entries]).toEqual([".edgeproc-sql-keep"]);
		expect(log.mock.calls.map((call) => call[0])).toEqual([
			"[edge-reco] legacy vector pool edgereco-catalog: removed",
			"[edge-reco] legacy vector pool edgereco-catalog: absent",
		]);
	});

	it("leaves a pool another tab still holds and says so", async () => {
		const log = vi.fn();
		const root = fakeRoot(
			new Set([LEGACY_POOL_DIR]),
			"NoModificationAllowedError",
		);

		expect(await seam.retireLegacyVectorPool({ root, log })).toBe("in-use");
		expect(log).toHaveBeenCalledWith(
			"[edge-reco] legacy vector pool edgereco-catalog: in-use",
		);
	});

	it("never fails boot when OPFS itself is missing; it logs the failure", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const root = fakeRoot(new Set(), "SecurityError");

		expect(await seam.retireLegacyVectorPool({ root })).toBe("failed");
		expect(warn).toHaveBeenCalledWith(
			"[edge-reco] legacy vector pool edgereco-catalog: failed",
			expect.any(Error),
		);
	});
});

describe("openCatalogueSql", () => {
	it("opens the named database with FTS5 and sqlite-vector on one connection", async () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
		const sql = await seam.openCatalogueSql({
			workerFactory: nodeSqlWorkerFactory,
		});
		try {
			const [row] = await sql.query(
				"SELECT sqlite_compileoption_used('ENABLE_FTS5') AS fts5, vector_version() AS vector",
			);
			expect(row).toEqual({ fts5: 1, vector: "1.1.2" });
			expect(info).toHaveBeenCalledWith(
				"[edge-reco] catalogue database storage",
				sql.storage,
			);
		} finally {
			await sql.close();
		}
	});
});
