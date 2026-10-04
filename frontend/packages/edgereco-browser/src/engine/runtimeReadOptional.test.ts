// runtime.ts reads two OPTIONAL bundle files (ranking_config.json,
// cooccurrence.json). The seam must distinguish ABSENT (an older bundle, where the
// sync layer rejects with a typed "not in manifest" error) from a REAL read error
// (IPC/read failure, corrupt chunk): absent → undefined (caller degrades), real
// error → propagate (fail closed). This locks that branching so an unexpected
// fault can never masquerade as "older bundle".

import type { SyncResult } from "@gainratio/browser";
import { describe, expect, it } from "vitest";
import { type EnginePort, readOptionalBundleFile } from "./runtime";

function port(readFile: (path: string) => Promise<Uint8Array>): EnginePort {
	return {
		readFile,
		sync: () => Promise.reject(new Error("not used")) as Promise<SyncResult>,
	};
}

describe("readOptionalBundleFile", () => {
	it("returns the bytes when the file is present", async () => {
		const bytes = new Uint8Array([1, 2, 3]);
		const engine = port(() => Promise.resolve(bytes));
		await expect(
			readOptionalBundleFile(engine, "ranking_config.json"),
		).resolves.toBe(bytes);
	});

	it("returns undefined for the typed 'not in manifest' rejection (older bundle)", async () => {
		const engine = port((path) =>
			Promise.reject(new Error(`file ${path} not in manifest`)),
		);
		await expect(
			readOptionalBundleFile(engine, "cooccurrence.json"),
		).resolves.toBeUndefined();
	});

	it("propagates an unexpected read/IPC error (fail closed, not 'older bundle')", async () => {
		const engine = port(() =>
			Promise.reject(new Error("worker IPC channel closed")),
		);
		await expect(
			readOptionalBundleFile(engine, "ranking_config.json"),
		).rejects.toThrow(/IPC/);
	});

	it("propagates a non-matching not-found message (different path) rather than swallowing", async () => {
		// Only the EXACT typed message for THIS path is "absent"; anything else is a
		// real fault and must surface.
		const engine = port(() =>
			Promise.reject(new Error("file some_other_file not in manifest")),
		);
		await expect(
			readOptionalBundleFile(engine, "ranking_config.json"),
		).rejects.toThrow();
	});
});
