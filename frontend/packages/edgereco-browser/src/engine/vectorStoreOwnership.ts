// Which tab may hold the on-device catalogue database.
//
// The catalogue Worker (catalogueWorker.ts) stores products, the FTS5 keyword
// index and the vectors in OPFS via SQLite's "opfs-sahpool" VFS. That VFS
// pre-opens exclusive SyncAccessHandles, so only ONE browsing context per origin
// can have it installed; SQLite's docs leave multi-tab coordination to the
// application
// (https://sqlite.org/wasm/doc/trunk/persistence.md#vfs-opfs-sahpool-concurrency).
//
// We coordinate with the Web Locks API: the first tab takes an exclusive lock
// and keeps it for its lifetime (the browser releases it when the tab closes).
// Every other tab opens the SAME SQLite build in memory. Nothing is lost:
// loadVectorIndex replaces the whole verified catalogue on every boot, so the
// persistent copy is never a warm start.
//
// KNOWN GAP: a second tab's catalogue lives in its WASM heap, not OPFS. SQLite's
// multi-connection OPFS VFSes ("opfs", "opfs-wl") need SharedArrayBuffer, i.e. a
// cross-origin-isolated page (COOP + COEP), and edge-reco does not send COEP.

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

/** Where SQLite keeps a store: the shared OPFS file, or this tab's memory. */
export type StorePersistence = "opfs" | "memory";

/** Opens one store with the given persistence (production: the catalogue Worker). */
export type PersistentOpener<O, T> = (
	options: O & { readonly persistence: StorePersistence },
) => Promise<T>;

export interface TabSafeVectorIndexDeps<O, T> {
	/** `navigator.locks`, or undefined where the Web Locks API is missing. */
	readonly locks: LockManagerLike | undefined;
	readonly open: PersistentOpener<O, T>;
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

async function openOwned<O, T>(
	open: PersistentOpener<O, T>,
	options: O,
): Promise<T> {
	try {
		return await open({ ...options, persistence: "opfs" });
	} catch (error) {
		// Busy (e.g. a tab still running a build that never took the lock) or
		// unusable (ephemeral WebKit contexts have no OPFS:
		// navigator.storage.getDirectory() throws UnknownError). The
		// persistent copy is never a warm start, so memory loses nothing. If memory
		// cannot open either, that error is the one the caller sees.
		console.warn(
			"[edge-reco] on-device catalogue: OPFS unavailable, using the in-memory database for this tab",
			error,
		);
		return open({ ...options, persistence: "memory" });
	}
}

/**
 * A store factory that never fails because another tab has the database open.
 * Create ONE per tab: the owner lease is remembered per factory, so an in-tab
 * retry reopens OPFS instead of competing with itself.
 */
export function tabSafeVectorIndexFactory<O, T>(
	deps: TabSafeVectorIndexDeps<O, T>,
): (options: O) => Promise<T> {
	let lease: Promise<boolean> | undefined;
	return async (options: O) => {
		lease ??= claimOwnership(deps.locks);
		const owner = await lease;
		if (!owner) {
			lease = undefined; // the owner may close; a later retry can claim it
			return deps.open({ ...options, persistence: "memory" });
		}
		return openOwned(deps.open, options);
	};
}
