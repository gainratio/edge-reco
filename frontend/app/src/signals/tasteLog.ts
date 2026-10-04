// The taste log seam — the one place the app reads and writes interaction
// history.
//
// WHERE IT LIVES: a `taste_events` table in the shopper's OWN on-device SQLite
// database (edgereco-user), separate from the disposable catalogue database.
// SQLite is the only store for app data: no localStorage, no IndexedDB, no raw
// OPFS files.
//
// WHAT IS STORED: timestamp, event type and product id. No user id, no session
// id, no PII. Nothing here ever leaves the device; the log exists so a reload
// can rebuild the taste profile by replaying the events through the same fold
// used live (api/client.ts bootstrap). A rolling window keeps the newest 500.
//
// FAILURE POLICY: appends and reads degrade to session-only behavior and never
// throw into the interaction path. RESET is the opposite: it either wipes and
// verifies every copy of the shopper's data, or it throws so the UI says so.
// A reset in a tab that does not own the database is routed to the owner tab
// (resetCoordinator.ts).
//
// MIGRATION: older builds kept this log in an OPFS file. migrateLegacyTaste
// copies it into SQLite (idempotent per event), then removes the file — but
// only in the owner tab, so a tab on an in-memory copy never deletes the only
// lasting copy.

import type { EventType, TasteRecord, TasteStore } from "@edgereco/browser";
import {
	type LegacyTasteFile,
	legacyTasteFile,
	parseLegacyTasteLog,
	retireLegacyLocalStorage,
} from "./legacyStorage";
import {
	broadcastBus,
	type ResetBus,
	ResetCoordinator,
} from "./resetCoordinator";

let store: TasteStore | null = null;
let coordinator: ResetCoordinator | null = null;

/** Raised when Reset is pressed but the saved activity could not be opened. */
export class TasteStoreUnavailableError extends Error {
	public constructor() {
		super("Couldn’t clear your saved activity: it could not be opened.");
		this.name = "TasteStoreUnavailableError";
	}
}

/**
 * Bind the user store after boot (null unbinds) and join the cross-tab reset
 * channel. `bus` defaults to the real BroadcastChannel.
 */
export function bindTasteStore(
	next: TasteStore | null,
	bus: ResetBus | null = next === null ? null : broadcastBus(),
	file: () => LegacyTasteFile | null = legacyTasteFile,
): void {
	coordinator?.dispose();
	store = next;
	coordinator =
		next === null
			? null
			: new ResetCoordinator(bus, next, () => wipeOwnerCopy(next, file()));
}

/** Everything this tab can wipe, verified: legacy leftovers, then the table. */
async function wipeOwnerCopy(
	target: TasteStore,
	file: LegacyTasteFile | null,
): Promise<void> {
	retireLegacyLocalStorage();
	await file?.remove();
	await target.clear();
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
 * outside SQLite (the OPFS file and the old localStorage keys), in whichever
 * tab owns them. Throws unless every copy was wiped and verified.
 */
export async function clearTasteLog(): Promise<void> {
	if (coordinator === null) {
		throw new TasteStoreUnavailableError();
	}
	await coordinator.reset();
}

export type LegacyMigration =
	| "none"
	| "copied"
	| "copied-and-retired"
	| "failed";

/**
 * Copy-then-retire for the old OPFS taste file. Idempotent and crash-resumable:
 * the copy skips events already present, so a rerun after a crash copies
 * nothing new and only finishes the retire step, and a rollback-then-forward
 * imports exactly the events the old build logged in between.
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
