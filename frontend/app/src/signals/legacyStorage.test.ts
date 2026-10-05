// Retiring what older builds left in the browser outside SQLite.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	LEGACY_LOCAL_STORAGE_KEYS,
	legacyTasteFile,
	parseLegacyTasteLog,
	retireLegacyLocalStorage,
} from "./legacyStorage";

describe("LEGACY_LOCAL_STORAGE_KEYS", () => {
	it("names the session id and the uplink queue the old builds wrote", () => {
		expect(LEGACY_LOCAL_STORAGE_KEYS).toEqual([
			"nimbus_session_id",
			"nimbus_uplink_queue",
		]);
	});
});

describe("retireLegacyLocalStorage", () => {
	beforeEach(() => localStorage.clear());
	afterEach(() => vi.unstubAllGlobals());

	it("removes the old session id and uplink queue, and nothing else", () => {
		localStorage.setItem("nimbus_session_id", "abc");
		localStorage.setItem("nimbus_uplink_queue", '[{"product_id":"P1"}]');
		localStorage.setItem("someone-else", "keep");
		retireLegacyLocalStorage();
		expect(localStorage.getItem("nimbus_session_id")).toBeNull();
		expect(localStorage.getItem("nimbus_uplink_queue")).toBeNull();
		expect(localStorage.getItem("someone-else")).toBe("keep");
	});

	it("is idempotent", () => {
		retireLegacyLocalStorage();
		retireLegacyLocalStorage();
		expect(localStorage.length).toBe(0);
	});

	it("never throws when storage is blocked", () => {
		vi.stubGlobal("localStorage", {
			removeItem: () => {
				throw new Error("SecurityError");
			},
		});
		expect(() => retireLegacyLocalStorage()).not.toThrow();
	});

	it("never throws when there is no localStorage at all", () => {
		vi.stubGlobal("localStorage", undefined);
		expect(() => retireLegacyLocalStorage()).not.toThrow();
	});
});

describe("parseLegacyTasteLog", () => {
	const good = (id: string): string =>
		JSON.stringify({
			v: 1,
			ts: "t",
			type: "click",
			productId: id,
			sessionId: "s",
		});

	it("drops the session id and keeps ts, type and product id", () => {
		expect(parseLegacyTasteLog(`${good("P1")}\n`)).toEqual([
			{ ts: "t", type: "click", productId: "P1" },
		]);
	});

	it("skips torn, non-object and structurally invalid lines", () => {
		const bad = [
			'{"v":1,"ts',
			"42",
			"null",
			JSON.stringify({ v: 2, ts: "t", type: "click", productId: "X" }),
			JSON.stringify({ v: 1, ts: "t", type: "purchase", productId: "Y" }),
			JSON.stringify({ v: 1, ts: "t", type: "click", productId: "" }),
			JSON.stringify({ v: 1, ts: 5, type: "click", productId: "Z" }),
		];
		const text = [good("P1"), ...bad, "", good("P2")].join("\n");
		expect(parseLegacyTasteLog(text).map((e) => e.productId)).toEqual([
			"P1",
			"P2",
		]);
	});

	it("reads an empty or missing file as no events", () => {
		expect(parseLegacyTasteLog("")).toEqual([]);
		expect(parseLegacyTasteLog(null)).toEqual([]);
	});
});

/** An OPFS root holding (or not) taste/events.jsonl; removal can be forced to fail. */
function fakeOpfs(text: string | null, removeError?: Error) {
	const removeEntry = vi.fn(async () => {
		if (removeError !== undefined) throw removeError;
	});
	const root = {
		getDirectoryHandle: vi.fn(async () => {
			if (text === null) throw new DOMException("no dir", "NotFoundError");
			return {
				getFileHandle: async () => ({
					getFile: async () => ({ text: async () => text }),
				}),
			};
		}),
		removeEntry,
	};
	vi.stubGlobal("navigator", {
		storage: { getDirectory: async () => root },
	});
	return { removeEntry };
}

describe("legacyTasteFile (the old OPFS taste log)", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("is null where OPFS is missing", () => {
		vi.stubGlobal("navigator", {});
		expect(legacyTasteFile()).toBeNull();
	});

	it("reads the old file's text, and null when it was never written", async () => {
		fakeOpfs('{"x":1}\n');
		expect(await legacyTasteFile()?.read()).toBe('{"x":1}\n');
		fakeOpfs(null);
		expect(await legacyTasteFile()?.read()).toBeNull();
	});

	it("remove() deletes the folder and treats already-gone as done", async () => {
		const { removeEntry } = fakeOpfs("");
		await legacyTasteFile()?.remove();
		expect(removeEntry).toHaveBeenCalledWith("taste", { recursive: true });
		fakeOpfs("", new DOMException("gone", "NotFoundError"));
		await expect(legacyTasteFile()?.remove()).resolves.toBeUndefined();
	});

	it("remove() surfaces any other failure, so Reset cannot report success", async () => {
		fakeOpfs("", new DOMException("held", "NoModificationAllowedError"));
		await expect(legacyTasteFile()?.remove()).rejects.toThrow("held");
	});
});
