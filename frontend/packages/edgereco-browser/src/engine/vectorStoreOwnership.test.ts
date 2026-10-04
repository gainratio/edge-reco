import { FlatVectorIndex } from "@edgeproc/browser/vector";
import type { SqliteVectorWorkerOptions } from "@edgeproc/browser/vector/sqlite";
import { describe, expect, it, vi } from "vitest";
import {
	isVectorStoreBusyError,
	type LockManagerLike,
	tabSafeVectorIndexFactory,
	VECTOR_STORE_LOCK,
} from "./vectorStoreOwnership";

/**
 * An in-memory stand-in for `navigator.locks` with Web Locks' exclusive-mode
 * semantics for `ifAvailable`: the callback gets `null` while another holder has
 * the name, and a lock is held until the callback's promise settles.
 */
class FakeLocks implements LockManagerLike {
	readonly held = new Set<string>();

	public request(
		name: string,
		options: { readonly ifAvailable: boolean },
		callback: (lock: { readonly name: string } | null) => Promise<unknown>,
	): Promise<unknown> {
		if (this.held.has(name) && options.ifAvailable) {
			return callback(null);
		}
		this.held.add(name);
		return callback({ name }).finally(() => this.held.delete(name));
	}
}

function contentionError(): Error {
	return new Error(
		"could not open the local vector database — this index may already be open in another tab (Failed to execute 'createSyncAccessHandle' on 'FileSystemFileHandle': Access Handles cannot be created if there is another open Access Handle or Writable stream associated with the same file.)",
	);
}

function recordingOpener(
	fail?: (options: SqliteVectorWorkerOptions) => Error | undefined,
) {
	const calls: SqliteVectorWorkerOptions[] = [];
	const open = vi.fn((options: SqliteVectorWorkerOptions) => {
		calls.push(options);
		const error = fail?.(options);
		return error === undefined
			? Promise.resolve(new FlatVectorIndex(options))
			: Promise.reject(error);
	});
	return { calls, open };
}

const OPTIONS = { name: "edgereco-catalog", dimension: 2 } as const;

describe("tabSafeVectorIndexFactory — one OPFS owner per browser profile", () => {
	it("the first tab claims the lock and opens the persistent OPFS store", async () => {
		const locks = new FakeLocks();
		const { calls, open } = recordingOpener();

		const index = await tabSafeVectorIndexFactory({ locks, open })(OPTIONS);

		expect(calls).toEqual([{ ...OPTIONS, persistence: "opfs" }]);
		expect(locks.held.has(VECTOR_STORE_LOCK)).toBe(true);
		await index.dispose();
	});

	it("keeps the lock for the life of the tab, so a retry in the same tab reopens OPFS", async () => {
		const locks = new FakeLocks();
		const { calls, open } = recordingOpener();
		const factory = tabSafeVectorIndexFactory({ locks, open });

		await (await factory(OPTIONS)).dispose();
		await (await factory(OPTIONS)).dispose();

		expect(calls.map((c) => c.persistence)).toEqual(["opfs", "opfs"]);
		expect(locks.held.has(VECTOR_STORE_LOCK)).toBe(true);
	});

	it("a second tab that finds the lock held uses the in-memory SQLite store instead of failing", async () => {
		const locks = new FakeLocks();
		const owner = recordingOpener();
		await tabSafeVectorIndexFactory({ locks, open: owner.open })(OPTIONS);

		const second = recordingOpener();
		const index = await tabSafeVectorIndexFactory({
			locks,
			open: second.open,
		})(OPTIONS);

		expect(second.calls).toEqual([{ ...OPTIONS, persistence: "memory" }]);
		await index.dispose();
	});

	it("falls back to memory when OPFS is still busy although this tab holds the lock", async () => {
		// e.g. a tab running an older build that never took the lock.
		const locks = new FakeLocks();
		const { calls, open } = recordingOpener((options) =>
			options.persistence === "opfs" ? contentionError() : undefined,
		);

		const index = await tabSafeVectorIndexFactory({ locks, open })(OPTIONS);

		expect(calls.map((c) => c.persistence)).toEqual(["opfs", "memory"]);
		await index.dispose();
	});

	it("without the Web Locks API it tries OPFS, then memory on contention", async () => {
		const { calls, open } = recordingOpener((options) =>
			options.persistence === "opfs" ? contentionError() : undefined,
		);

		const index = await tabSafeVectorIndexFactory({ locks: undefined, open })(
			OPTIONS,
		);

		expect(calls.map((c) => c.persistence)).toEqual(["opfs", "memory"]);
		await index.dispose();
	});

	// Reverses the old contract ("does not hide a real OPFS failure"). Playwright's
	// default (ephemeral) WebKit context has no OPFS at all
	// (navigator.storage.getDirectory() throws UnknownError), and the persistent
	// copy is never a warm start, so refusing to run there bought nothing.
	it("falls back to memory when OPFS is unusable for any reason, and says why", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const broken = new Error(
			"could not open the local vector database (The operation failed for an unknown transient reason (e.g. out of memory).)",
		);
		const { calls, open } = recordingOpener((o) =>
			o.persistence === "opfs" ? broken : undefined,
		);

		const index = await tabSafeVectorIndexFactory({
			locks: new FakeLocks(),
			open,
		})(OPTIONS);

		expect(calls.map((c) => c.persistence)).toEqual(["opfs", "memory"]);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("in-memory"),
			broken,
		);
		await index.dispose();
		warn.mockRestore();
	});

	it("still fails loudly when the in-memory store cannot open either", async () => {
		const broken = new Error("wasm unavailable");
		const { calls, open } = recordingOpener(() => broken);

		await expect(
			tabSafeVectorIndexFactory({ locks: new FakeLocks(), open })(OPTIONS),
		).rejects.toBe(broken);
		expect(calls.map((c) => c.persistence)).toEqual(["opfs", "memory"]);
	});
});

describe("isVectorStoreBusyError", () => {
	it("recognises the SQLite pool's another-tab contention error", () => {
		expect(isVectorStoreBusyError(contentionError())).toBe(true);
		const named = new Error("x");
		named.name = "NoModificationAllowedError";
		expect(isVectorStoreBusyError(named)).toBe(true);
	});

	it("does not treat other failures as contention", () => {
		expect(isVectorStoreBusyError(new Error("disk full"))).toBe(false);
		expect(isVectorStoreBusyError("Access Handles cannot be created")).toBe(
			false,
		);
	});
});
