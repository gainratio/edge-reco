// The taste log seam — the one place the app reads and writes interaction
// history.
//
// WHERE IT LIVES: a `taste_events` table in the on-device SQLite database (the
// same database as the catalogue, owned by @edgereco/browser). SQLite is the
// only store for app data: no localStorage, no IndexedDB, no raw OPFS files.
//
// WHAT IS STORED: timestamp, event type and product id. No user id, no session
// id, no PII. Nothing here ever leaves the device; the log exists so a reload
// can rebuild the taste profile by replaying the events through the same fold
// used live (api/client.ts bootstrap). A rolling window keeps the newest 500.
//
// LIFECYCLE: the engine opens the database at boot; bootstrap binds the store
// here. Before that (or if the database failed to open) every call no-ops.
// A storage failure degrades to session-only behavior and never throws into
// the interaction path.
//
// MIGRATION: older builds kept this log in an OPFS file. migrateLegacyTaste
// copies it into SQLite (rows and a marker commit in one transaction), then
// removes the file — but only when the database is durable, so a tab running
// on an in-memory database never deletes the only lasting copy.

import type { EventType, TasteRecord, TasteStore } from "@edgereco/browser";
import {
	type LegacyTasteFile,
	legacyTasteFile,
	parseLegacyTasteLog,
	retireLegacyLocalStorage,
} from "./legacyStorage";

let store: TasteStore | null = null;

/** Bind the engine's store after boot (null unbinds). */
export function bindTasteStore(next: TasteStore | null): void {
	store = next;
}

/** True when the taste log survives a reload (database in OPFS). */
export function tasteDurable(): boolean {
	return store?.durable ?? false;
}

async function safely<T>(
	operation: (bound: TasteStore) => Promise<T>,
	fallback: T,
): Promise<T> {
	if (store === null) {
		return fallback;
	}
	try {
		return await operation(store);
	} catch (error) {
		console.warn(
			"taste log unavailable, continuing without persistence",
			error,
		);
		return fallback;
	}
}

/** Append one interaction (never throws). */
export function appendTasteEvent(
	type: EventType,
	productId: string,
): Promise<void> {
	const record = { ts: new Date().toISOString(), type, productId };
	return safely((bound) => bound.append(record), undefined);
}

/** All logged events, oldest first — the boot-time replay input. */
export function readTasteEvents(): Promise<ReadonlyArray<TasteRecord>> {
	return safely((bound) => bound.list(), []);
}

/**
 * The "Reset taste" wipe: the SQLite table, plus anything an older build left
 * outside SQLite (the OPFS file and the old localStorage keys).
 */
export async function clearTasteLog(): Promise<void> {
	retireLegacyLocalStorage();
	await removeLegacyFile(legacyTasteFile());
	await safely((bound) => bound.clear(), undefined);
}

async function removeLegacyFile(file: LegacyTasteFile | null): Promise<void> {
	try {
		await file?.remove();
	} catch (error) {
		console.warn("[edge-reco] could not remove the legacy taste file", error);
	}
}

export type LegacyMigration =
	| "none"
	| "copied"
	| "copied-and-retired"
	| "failed";

/**
 * Copy-then-retire for the old OPFS taste file. Idempotent and crash-resumable:
 * the copy is guarded by a marker written in the same transaction, so a rerun
 * after a crash copies nothing and only finishes the retire step.
 */
export async function migrateLegacyTaste(
	target: TasteStore,
	file: LegacyTasteFile | null = legacyTasteFile(),
): Promise<LegacyMigration> {
	if (file === null) {
		return "none";
	}
	try {
		const text = await file.read();
		if (text === null) {
			return "none";
		}
		await target.importLegacy(parseLegacyTasteLog(text));
		if (!target.durable) {
			return "copied";
		}
		await file.remove();
		return "copied-and-retired";
	} catch (error) {
		console.warn(
			"[edge-reco] legacy taste migration failed; will retry",
			error,
		);
		return "failed";
	}
}
