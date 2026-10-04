// The IndexedDB half of the signed-bundle cache: the anti-rollback floor.
//
// @gainratio/browser keeps its durable active pointer twice — in OPFS and in an
// IndexedDB database — and treats the higher of the two as the rollback floor.
// `EngineClient.clear()` empties both under the cache's Web Lock. The explicit
// "clear cached catalog" recovery then ALSO deletes the floor database, awaited
// and bounded, so a floor can never silently survive the one action meant to
// remove it. Nothing here runs except from that explicit user action.

import { resolveIndexedDbLayout } from "@gainratio/browser";

/**
 * The library's default floor database (`edgeproc-browser-cache`) — the one
 * EdgeReco's sync uses, since it passes no cache namespace or layout. Derived
 * from the library so a future default can never leave a stale floor behind.
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
	return deleteDatabaseBounded(
		typeof indexedDB === "undefined" ? undefined : indexedDB,
		BUNDLE_FLOOR_DATABASE,
		FLOOR_DELETE_TIMEOUT_MS,
	);
}
