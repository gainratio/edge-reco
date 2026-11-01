import { afterEach, describe, expect, it, vi } from "vitest";
import { nodeSqlWorkerFactory } from "./__fixtures__/nodeSqlWorker";

// testSetup.ts wraps this module for every other spec; here we want the real one.
const seam =
	await vi.importActual<typeof import("./catalogueSql")>("./catalogueSql");

/** sha256("edgereco-catalog"), first 16 bytes — the pool main's build created. */
const LEGACY_POOL_DIR = ".edgeproc-vector-aee9d7e7fe483930ecfa7c84cc1508f0";
/** sha256("edgereco-catalogue"), first 16 bytes — the disposable catalogue SQLite pool. */
const CATALOGUE_POOL_DIR = ".edgeproc-sql-fba783151f3ebce32fd791bb8b6b0ae2";

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

	it("logs to console.info when no logger is given", async () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
		const root = fakeRoot(new Set());

		expect(await seam.retireLegacyVectorPool({ root })).toBe("absent");
		expect(info).toHaveBeenCalledWith(
			"[edge-reco] legacy vector pool edgereco-catalog: absent",
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

describe("openUserSql", () => {
	it("opens the shopper's own database, a separate connection from the catalogue", async () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
		const user = await seam.openUserSql({
			workerFactory: nodeSqlWorkerFactory,
		});
		const catalogue = await seam.openCatalogueSql({
			workerFactory: nodeSqlWorkerFactory,
		});
		try {
			await user.exec("CREATE TABLE only_user(x)");
			expect(
				await catalogue.query(
					"SELECT name FROM sqlite_master WHERE name = 'only_user'",
				),
			).toEqual([]);
			expect(info).toHaveBeenCalledWith(
				"[edge-reco] user database storage",
				user.storage,
			);
		} finally {
			await user.close();
			await catalogue.close();
		}
	});
});

describe("importCatalogueSqlFromChunks & clearCatalogueSqlStorage", () => {
	it("streams SQLite chunks into the catalogue database and reopens with the imported rows", async () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
		const seed = await seam.openCatalogueSql({
			workerFactory: nodeSqlWorkerFactory,
		});
		await seed.exec(
			"CREATE TABLE items(id TEXT PRIMARY KEY); INSERT INTO items VALUES ('x');",
		);
		const exported = await seed.exportDatabase?.();
		await seed.close();
		if (exported === undefined) {
			throw new Error("expected exportDatabase");
		}

		async function* chunked(bytes: Uint8Array, size: number) {
			for (let offset = 0; offset < bytes.byteLength; offset += size) {
				yield bytes.subarray(offset, Math.min(offset + size, bytes.byteLength));
			}
		}

		const storage = await seam.importCatalogueSqlFromChunks(
			chunked(exported, 512),
			{ workerFactory: nodeSqlWorkerFactory },
		);
		expect(storage.persistence).toBe("memory");

		const reopened = await seam.openCatalogueSql({
			workerFactory: nodeSqlWorkerFactory,
		});
		try {
			expect(await reopened.query("SELECT id FROM items")).toEqual([
				{ id: "x" },
			]);
			expect(info).toHaveBeenCalled();
		} finally {
			await reopened.close();
		}
	});

	it("rejects empty chunks in the SQLite chunk stream", async () => {
		async function* emptyChunk() {
			yield new Uint8Array(0);
		}
		await expect(
			seam.importCatalogueSqlFromChunks(emptyChunk(), {
				workerFactory: nodeSqlWorkerFactory,
			}),
		).rejects.toThrow(/non-empty Uint8Array/i);
	});

	it("removes only the edgereco-catalogue OPFS pool while leaving user pools intact", async () => {
		const entries = new Set([CATALOGUE_POOL_DIR, ".edgeproc-sql-user-keep"]);
		const root = fakeRoot(entries);
		const log = vi.fn();

		expect(await seam.clearCatalogueSqlStorage({ root, log })).toBe("removed");
		expect(await seam.clearCatalogueSqlStorage({ root, log })).toBe("absent");
		expect([...entries]).toEqual([".edgeproc-sql-user-keep"]);
		expect(log.mock.calls.map((c) => c[0])).toEqual([
			"[edge-reco] catalogue sql pool edgereco-catalogue: removed",
			"[edge-reco] catalogue sql pool edgereco-catalogue: absent",
		]);
	});

	it("logs a warning and returns failed when clearCatalogueSqlStorage encounters an OPFS error", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const root = fakeRoot(new Set([CATALOGUE_POOL_DIR]), "SecurityError");

		expect(await seam.clearCatalogueSqlStorage({ root })).toBe("failed");
		expect(warn).toHaveBeenCalledWith(
			"[edge-reco] catalogue sql pool edgereco-catalogue: failed",
			expect.any(Error),
		);
	});
});
