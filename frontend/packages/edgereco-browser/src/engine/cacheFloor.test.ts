import { resolveIndexedDbLayout } from "@gainratio/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	BUNDLE_FLOOR_DATABASE,
	deleteBundleFloorDatabase,
	deleteDatabaseBounded,
	type IdbDeleteFactory,
} from "./cacheFloor";

/** A scriptable IDBFactory: the test decides which events fire, and when. */
function fakeFactory(
	error: DOMException | null = new DOMException("denied", "UnknownError"),
): IdbDeleteFactory & {
	readonly names: string[];
	fire(event: "success" | "error" | "blocked"): void;
} {
	const names: string[] = [];
	let request: IDBOpenDBRequest | undefined;
	return {
		names,
		deleteDatabase(name: string) {
			names.push(name);
			request = { error } as unknown as IDBOpenDBRequest;
			return request;
		},
		fire(event) {
			const handler = (
				request as unknown as Record<string, (() => void) | null>
			)[`on${event}`];
			handler?.();
		},
	};
}

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("the rollback-floor database", () => {
	it("is the library's own default IndexedDB floor database, derived not hardcoded", () => {
		expect(BUNDLE_FLOOR_DATABASE).toBe(resolveIndexedDbLayout().database);
		expect(BUNDLE_FLOOR_DATABASE).toBe("edgeproc-browser-cache");
	});
});

describe("deleteDatabaseBounded", () => {
	it("resolves once the deletion succeeds", async () => {
		const factory = fakeFactory();
		const pending = deleteDatabaseBounded(factory, "db", 1_000);
		factory.fire("success");
		await expect(pending).resolves.toBeUndefined();
		expect(factory.names).toEqual(["db"]);
	});

	it("keeps waiting through onblocked and resolves when the holder lets go", async () => {
		const factory = fakeFactory();
		const pending = deleteDatabaseBounded(factory, "db", 1_000);
		factory.fire("blocked");
		factory.fire("success");
		await expect(pending).resolves.toBeUndefined();
	});

	it("fails loudly — never silently — when a blocked deletion outlives the bound", async () => {
		vi.useFakeTimers();
		const factory = fakeFactory();
		const pending = deleteDatabaseBounded(factory, "db", 1_000);
		const settled = expect(pending).rejects.toThrow(/another tab/u);
		factory.fire("blocked");
		await vi.advanceTimersByTimeAsync(1_000);
		await settled;
	});

	it("fails when a deletion neither completes nor reports blocked within the bound", async () => {
		vi.useFakeTimers();
		const factory = fakeFactory();
		const pending = deleteDatabaseBounded(factory, "db", 500);
		const settled = expect(pending).rejects.toThrow(/timed out/u);
		await vi.advanceTimersByTimeAsync(500);
		await settled;
	});

	it("surfaces a deletion error", async () => {
		const factory = fakeFactory();
		const pending = deleteDatabaseBounded(factory, "db", 1_000);
		factory.fire("error");
		await expect(pending).rejects.toThrow(/denied/u);
	});

	it("is a no-op when the browser has no IndexedDB (nothing can hold a floor)", async () => {
		await expect(
			deleteDatabaseBounded(undefined, "db", 1_000),
		).resolves.toBeUndefined();
	});

	it("surfaces a deletion error even when the request carries none", async () => {
		const factory = fakeFactory(null);
		const pending = deleteDatabaseBounded(factory, "db", 1_000);
		factory.fire("error");
		await expect(pending).rejects.toThrow(/could not clear/u);
	});
});

describe("deleteBundleFloorDatabase", () => {
	it("deletes exactly the library's floor database through the page's IndexedDB", async () => {
		const factory = fakeFactory();
		vi.stubGlobal("indexedDB", factory);
		const pending = deleteBundleFloorDatabase();
		factory.fire("success");
		await expect(pending).resolves.toBeUndefined();
		expect(factory.names).toEqual([BUNDLE_FLOOR_DATABASE]);
	});

	it("is a no-op where the browser has no IndexedDB", async () => {
		vi.stubGlobal("indexedDB", undefined);
		await expect(deleteBundleFloorDatabase()).resolves.toBeUndefined();
	});
});
