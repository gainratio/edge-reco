// The legacy (0.2.x) IndexedDB copy of the anti-rollback floor.
//
// Since @gainratio/browser 0.3.0 the active pointer and the rollback floor live
// in the library's SQLite cache database on OPFS, and `EngineClient.clear()`
// empties them under the cache's Web Lock. A 0.2.x install also kept the floor
// in an IndexedDB database, which 0.3+ migrates from once. The explicit "clear
// cached catalog" recovery ALSO deletes that legacy database, awaited and
// bounded, so no pre-migration copy of a floor survives the one action meant
// to remove it. Nothing here runs except from that explicit user action.

import { resolveIndexedDbLayout } from "../gainratio";

/**
 * Where the library's 0.2.x default layout kept its IndexedDB floor
 * (`edgeproc-browser-cache`); EdgeReco passes no cache namespace or layout.
 * Derived from the library (`resolveIndexedDbLayout()` now names the legacy
 * location to migrate from) so a changed default can never leave it behind.
 */
export const BUNDLE_FLOOR_DATABASE: string = resolveIndexedDbLayout().database;

/** How long the floor deletion may wait (e.g. through `onblocked`). */
export const FLOOR_DELETE_TIMEOUT_MS = 10_000;

/** The one IDBFactory method this module needs — small so tests can fake it. */
export type IdbDeleteFactory = Pick<IDBFactory, "deleteDatabase">;

/**
 * Delete an IndexedDB database and wait for the outcome, bounded.
 *
 * `onblocked` means another connection (another tab mid-sync, or the clearing
 * Worker still closing) holds the database open; the request stays queued, so
 * this keeps waiting and resolves once the holder lets go. If the bound elapses
 * first it REJECTS — a floor that might survive is never reported as cleared.
 * With no IndexedDB at all there is no floor to remove, so it resolves.
 */
export function deleteDatabaseBounded(
	factory: IdbDeleteFactory | undefined,
	name: string,
	timeoutMs: number,
): Promise<void> {
	if (factory === undefined) {
		return Promise.resolve();
	}
	return new Promise<void>((resolve, reject) => {
		let blocked = false;
		const timer = setTimeout(() => {
			reject(
				new Error(
					blocked
						? "the saved catalog is still open in another tab — close other tabs of this store and try again"
						: "timed out clearing the saved catalog",
				),
			);
		}, timeoutMs);
		const request = factory.deleteDatabase(name);
		request.onsuccess = () => {
			clearTimeout(timer);
			resolve();
		};
		request.onerror = () => {
			clearTimeout(timer);
			reject(request.error ?? new Error("could not clear the saved catalog"));
		};
		request.onblocked = () => {
			blocked = true;
		};
	});
}

/** Production default: delete the library's floor database from this tab. */
export function deleteBundleFloorDatabase(): Promise<void> {
	// Only deleteDatabase is exposed: this module deletes the library's floor
	// and never writes IndexedDB (app/src/storageBoundary.test.ts).
	const factory: IdbDeleteFactory | undefined =
		typeof indexedDB === "undefined"
			? undefined
			: { deleteDatabase: (name) => indexedDB.deleteDatabase(name) };
	return deleteDatabaseBounded(
		factory,
		BUNDLE_FLOOR_DATABASE,
		FLOOR_DELETE_TIMEOUT_MS,
	);
}
