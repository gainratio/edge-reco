// What older builds left in the browser OUTSIDE SQLite, and how it is retired.
//
// SQLite is the only store for app data. Older builds also wrote:
//
//   localStorage  nimbus_session_id     a random per-browser id
//                 nimbus_uplink_queue   interaction events waiting to be sent
//                                       to an optional collector
//   OPFS file     taste/events.jsonl    the taste log
//
// The session id and the uplink are gone (no user data leaves the device, so
// there is nothing to send and no id to send it under). Their keys are only
// ever REMOVED here. The taste log is copied into SQLite first and removed
// after (copy-then-retire, see tasteLog.ts).
//
// This is the one module allowed to touch localStorage, and only with
// removeItem: storageBoundary.test.ts fails on any write.

import type { TasteRecord } from "@edgereco/browser";

/** Keys older builds wrote to localStorage. Removed, never read or written. */
export const LEGACY_LOCAL_STORAGE_KEYS: ReadonlyArray<string> = [
	"nimbus_session_id",
	"nimbus_uplink_queue",
];

/** Remove the old localStorage keys. Idempotent; never throws. */
export function retireLegacyLocalStorage(): void {
	for (const key of LEGACY_LOCAL_STORAGE_KEYS) {
		try {
			globalThis.localStorage?.removeItem(key);
		} catch (error) {
			// Blocked storage cannot hold the keys either; nothing to retire.
			console.warn(`[edge-reco] could not remove legacy key ${key}`, error);
		}
	}
}

/** The old OPFS taste file: read once to copy, then removed. */
export interface LegacyTasteFile {
	read(): Promise<string | null>;
	remove(): Promise<void>;
}

const LOG_DIR = "taste";
const LOG_FILE = "events.jsonl";
const EVENT_TYPES: ReadonlySet<string> = new Set([
	"click",
	"view",
	"favorite",
	"cart",
]);

/** The OPFS file on this origin, or null where OPFS is unavailable. */
export function legacyTasteFile(): LegacyTasteFile | null {
	if (
		typeof navigator === "undefined" ||
		typeof navigator.storage?.getDirectory !== "function"
	) {
		return null;
	}
	const dir = async (): Promise<FileSystemDirectoryHandle | null> => {
		const root = await navigator.storage.getDirectory();
		try {
			return await root.getDirectoryHandle(LOG_DIR);
		} catch {
			return null; // never written: nothing to migrate
		}
	};
	return {
		async read(): Promise<string | null> {
			const folder = await dir();
			if (folder === null) {
				return null;
			}
			try {
				return await (await folder.getFileHandle(LOG_FILE))
					.getFile()
					.then((f) => f.text());
			} catch {
				return null;
			}
		},
		async remove(): Promise<void> {
			const root = await navigator.storage.getDirectory();
			try {
				await root.removeEntry(LOG_DIR, { recursive: true });
			} catch (error) {
				// Already gone is fine; anything else must reach the caller.
				if (
					!(error instanceof DOMException && error.name === "NotFoundError")
				) {
					throw error;
				}
			}
		},
	};
}

function parseLine(text: string): TasteRecord | null {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return null; // torn tail
	}
	if (typeof value !== "object" || value === null) {
		return null;
	}
	const r = value as Record<string, unknown>;
	const valid =
		r.v === 1 &&
		typeof r.ts === "string" &&
		typeof r.type === "string" &&
		EVENT_TYPES.has(r.type) &&
		typeof r.productId === "string" &&
		r.productId !== "";
	return valid
		? ({ ts: r.ts, type: r.type, productId: r.productId } as TasteRecord)
		: null;
}

/** Valid events from the old JSONL file, oldest first. Bad lines are skipped. */
export function parseLegacyTasteLog(
	text: string | null,
): ReadonlyArray<TasteRecord> {
	if (text === null) {
		return [];
	}
	const out: TasteRecord[] = [];
	for (const raw of text.split("\n")) {
		const event = raw.trim() === "" ? null : parseLine(raw);
		if (event !== null) {
			out.push(event);
		}
	}
	return out;
}
