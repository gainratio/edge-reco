// The taste-log seam over the engine's SQLite taste table.
//
// The store is the REAL SqlTasteStore on the pinned SQLite build (in-process
// Worker). The legacy OPFS file is an in-memory stand-in (jsdom has no OPFS);
// the real browser path is proven by tests/e2e/persistent-taste.spec.ts.

import type { TasteStore } from "@edgereco/browser";
import { sharedCatalogue } from "@edgereco/browser/testing/sharedCatalogue";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LegacyTasteFile } from "./legacyStorage";
import {
	appendTasteEvent,
	bindTasteStore,
	clearTasteLog,
	migrateLegacyTaste,
	readTasteEvents,
	tasteDurable,
} from "./tasteLog";

async function sqlStore(durable = true): Promise<TasteStore> {
	const { factory } = await sharedCatalogue(durable);
	return (await factory({ dimension: 2 })).taste;
}

/** The old OPFS file, in memory, with a removal counter. */
function legacyFile(initial: string | null): LegacyTasteFile & {
	contents: () => string | null;
} {
	let text = initial;
	return {
		read: () => Promise.resolve(text),
		remove: () => {
			text = null;
			return Promise.resolve();
		},
		contents: () => text,
	};
}

function line(productId: string, type = "click"): string {
	return JSON.stringify({
		v: 1,
		ts: "2026-07-21T00:00:00.000Z",
		type,
		productId,
		sessionId: "s-1",
	});
}

beforeEach(() => {
	localStorage.clear();
});

afterEach(() => {
	bindTasteStore(null);
});

describe("taste log over SQLite", () => {
	it("round-trips appended events without any session id", async () => {
		bindTasteStore(await sqlStore());
		await appendTasteEvent("click", "B0TEST01");
		const [event] = await readTasteEvents();
		expect(event?.type).toBe("click");
		expect(event?.productId).toBe("B0TEST01");
		expect(typeof event?.ts).toBe("string");
		expect(Object.keys(event ?? {}).sort()).toEqual([
			"productId",
			"ts",
			"type",
		]);
	});

	it("writes nothing to localStorage", async () => {
		bindTasteStore(await sqlStore());
		await appendTasteEvent("click", "P1");
		expect(localStorage.length).toBe(0);
	});

	it("clearTasteLog empties the table", async () => {
		bindTasteStore(await sqlStore());
		await appendTasteEvent("click", "P1");
		await clearTasteLog();
		expect(await readTasteEvents()).toEqual([]);
	});

	it("reports durability from the bound store", async () => {
		bindTasteStore(await sqlStore(true));
		expect(tasteDurable()).toBe(true);
		bindTasteStore(await sqlStore(false));
		expect(tasteDurable()).toBe(false);
		bindTasteStore(null);
		expect(tasteDurable()).toBe(false);
	});

	it("with no store bound (engine not booted) every op no-ops safely", async () => {
		await expect(appendTasteEvent("click", "P1")).resolves.toBeUndefined();
		await expect(readTasteEvents()).resolves.toEqual([]);
		await expect(clearTasteLog()).resolves.toBeUndefined();
	});

	it("a failing store degrades to session-only, never throws", async () => {
		const broken: TasteStore = {
			durable: true,
			append: () => Promise.reject(new Error("disk")),
			list: () => Promise.reject(new Error("disk")),
			clear: () => Promise.reject(new Error("disk")),
			importLegacy: () => Promise.reject(new Error("disk")),
		};
		bindTasteStore(broken);
		await expect(appendTasteEvent("click", "P1")).resolves.toBeUndefined();
		await expect(readTasteEvents()).resolves.toEqual([]);
		await expect(clearTasteLog()).resolves.toBeUndefined();
	});
});

describe("legacy OPFS taste file: copy-then-retire", () => {
	it("copies valid events into SQLite, then retires the file", async () => {
		const store = await sqlStore(true);
		const file = legacyFile(`${line("P1")}\n${line("P2", "cart")}\n{"v":1,"ts`);
		expect(await migrateLegacyTaste(store, file)).toBe("copied-and-retired");
		bindTasteStore(store);
		expect((await readTasteEvents()).map((e) => e.productId)).toEqual([
			"P1",
			"P2",
		]);
		expect(file.contents()).toBeNull();
	});

	it("is crash-resumable: a rerun after the copy never duplicates, and still retires", async () => {
		const store = await sqlStore(true);
		const text = `${line("P1")}\n`;
		// The copy committed but the tab died before the file was removed.
		await store.importLegacy([
			{ ts: "2026-07-21T00:00:00.000Z", type: "click", productId: "P1" },
		]);
		const file = legacyFile(text);
		await migrateLegacyTaste(store, file);
		bindTasteStore(store);
		expect(await readTasteEvents()).toHaveLength(1);
		expect(file.contents()).toBeNull();
	});

	it("keeps the file when the database is not durable (memory tab)", async () => {
		const store = await sqlStore(false);
		const file = legacyFile(`${line("P1")}\n`);
		expect(await migrateLegacyTaste(store, file)).toBe("copied");
		expect(file.contents()).not.toBeNull();
	});

	it("does nothing when there is no legacy file", async () => {
		const store = await sqlStore(true);
		expect(await migrateLegacyTaste(store, legacyFile(null))).toBe("none");
		expect(await migrateLegacyTaste(store, null)).toBe("none");
	});

	it("never fails boot when the legacy file cannot be read", async () => {
		const store = await sqlStore(true);
		const broken: LegacyTasteFile = {
			read: () => Promise.reject(new Error("opfs")),
			remove: () => Promise.reject(new Error("opfs")),
		};
		expect(await migrateLegacyTaste(store, broken)).toBe("failed");
	});
});
