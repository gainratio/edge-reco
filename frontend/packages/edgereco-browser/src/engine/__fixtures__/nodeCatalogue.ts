/// <reference types="node" />
// TEST-ONLY: open the pinned SQLite build in Node, in memory, so the catalogue
// SQL runs in Vitest exactly as it runs in the browser Worker. Mirrors
// @edgeproc/browser's own Node adapter (vector/sqlite/node.ts): hand the WASM
// bytes over directly and keep sqlite3.mjs from probing for OPFS.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CatalogueStore, CatalogueStoreOptions } from "../catalogueClient";
import { CatalogueDb, type CatalogueSqlDatabase } from "../catalogueDb";
import { type Sqlite3Module, sqlite3InitModule } from "../catalogueSqlite";

const WASM_PATH = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../../node_modules/@edgeproc/browser/dist/vector/sqlite/assets/sqlite3.wasm",
);

let module: Promise<Sqlite3Module> | undefined;

async function initialize(): Promise<Sqlite3Module> {
	const wasmBinary = new Uint8Array(await readFile(WASM_PATH));
	const original = Object.getOwnPropertyDescriptor(globalThis, "location");
	Object.defineProperty(globalThis, "location", {
		configurable: true,
		value: { href: "https://edgereco.invalid/?opfs-disable&opfs-wl-disable" },
	});
	try {
		return await sqlite3InitModule({
			wasmBinary,
			print: () => undefined,
			printErr: () => undefined,
		});
	} finally {
		if (original === undefined) {
			delete (globalThis as { location?: unknown }).location;
		} else {
			Object.defineProperty(globalThis, "location", original);
		}
	}
}

/** A fresh in-memory database on the pinned SQLite build. */
export async function openNodeDatabase(): Promise<CatalogueSqlDatabase> {
	module ??= initialize();
	const sqlite = await module;
	return new sqlite.oo1.DB(":memory:");
}

/**
 * The CatalogueStore the browser gets from its Worker, run in-process instead:
 * same SQL, same SQLite build, no Worker or OPFS (which Node and jsdom lack).
 */
export async function openNodeCatalogueStore(
	options: CatalogueStoreOptions,
): Promise<CatalogueStore> {
	const db = new CatalogueDb(await openNodeDatabase(), options.dimension);
	return {
		replace: async (revision) => db.replace(revision),
		hybrid: async (query, vector, k) => db.hybrid(query, vector, k),
		vectorSearch: async (vector, k) => db.vectorSearch(vector, k),
		nearest: async (id, k) => db.nearest(id, k),
		dispose: async () => db.close(),
	};
}
