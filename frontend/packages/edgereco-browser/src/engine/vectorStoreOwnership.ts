// Which tab may hold the on-device vector database.
//
// The shared SQLite + sqlite-vector Worker stores the catalog index in OPFS via
// SQLite's "opfs-sahpool" VFS. That VFS pre-opens exclusive SyncAccessHandles,
// so only ONE browsing context per origin can have it installed; SQLite's docs
// leave multi-tab coordination to the application
// (https://sqlite.org/wasm/doc/trunk/persistence.md#vfs-opfs-sahpool-concurrency).
//
// We coordinate with the Web Locks API: the first tab takes an exclusive lock
// and keeps it for its lifetime (the browser releases it when the tab closes).
// Every other tab opens the SAME library in its supported in-memory mode. Nothing
// is lost: loadVectorIndex clears and re-imports the whole verified matrix on
// every boot, so the persistent copy is never a warm start.

import type { VectorIndex, VectorIndexFactory } from "@edgeproc/browser/vector";
import type { SqliteVectorWorkerOptions } from "@edgeproc/browser/vector/sqlite";

/** The Web Lock name that marks the tab owning the OPFS vector database. */
export const VECTOR_STORE_LOCK = "edgereco-vector-store";

/** The slice of `navigator.locks` this module uses (a test seam). */
export interface LockManagerLike {
	request(
		name: string,
		options: { readonly ifAvailable: boolean },
		callback: (lock: { readonly name: string } | null) => Promise<unknown>,
	): Promise<unknown>;
}

/** Opens one SQLite vector index (production: createSqliteVectorIndex). */
export type SqliteVectorOpener = (
	options: SqliteVectorWorkerOptions,
) => Promise<VectorIndex>;

export interface TabSafeVectorIndexDeps {
	/** `navigator.locks`, or undefined where the Web Locks API is missing. */
	readonly locks: LockManagerLike | undefined;
	readonly open: SqliteVectorOpener;
}

const BUSY_TEXT =
	/access handles? cannot be created|already be open in another tab/iu;

/** True when OPFS refused because another browsing context holds the file. */
export function isVectorStoreBusyError(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.name === "NoModificationAllowedError" ||
			BUSY_TEXT.test(error.message))
	);
}

/**
 * Try to take the owner lock without waiting. Resolves true once granted (the
 * lock is then held until the tab goes away) or false if another tab has it.
 * With no Web Locks API it resolves true: the OPFS open itself arbitrates, and
 * contention still falls back to memory.
 */
function claimOwnership(locks: LockManagerLike | undefined): Promise<boolean> {
	if (locks === undefined) {
		return Promise.resolve(true);
	}
	return new Promise<boolean>((resolve, reject) => {
		locks
			.request(VECTOR_STORE_LOCK, { ifAvailable: true }, (lock) => {
				resolve(lock !== null);
				// Hold a granted lock for the life of the tab.
				return lock === null ? Promise.resolve() : new Promise(() => undefined);
			})
			.catch(reject);
	});
}

async function openOwned(
	open: SqliteVectorOpener,
	options: SqliteVectorWorkerOptions,
): Promise<VectorIndex> {
	try {
		return await open({ ...options, persistence: "opfs" });
	} catch (error) {
		if (!isVectorStoreBusyError(error)) {
			throw error;
		}
		// e.g. a tab still running a build that never took the lock.
		return open({ ...options, persistence: "memory" });
	}
}

/**
 * A VectorIndexFactory that never fails because another tab has the database
 * open. Create ONE per tab: the owner lease is remembered per factory, so an
 * in-tab retry reopens OPFS instead of competing with itself.
 */
export function tabSafeVectorIndexFactory(
	deps: TabSafeVectorIndexDeps,
): VectorIndexFactory {
	let lease: Promise<boolean> | undefined;
	return async (options) => {
		lease ??= claimOwnership(deps.locks);
		const owner = await lease;
		if (!owner) {
			lease = undefined; // the owner may close; a later retry can claim it
			return deps.open({ ...options, persistence: "memory" });
		}
		return openOwned(deps.open, options);
	};
}
