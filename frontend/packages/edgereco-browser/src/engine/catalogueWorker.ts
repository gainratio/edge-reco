/// <reference lib="webworker" />
// The catalogue Worker: opens the pinned SQLite build (OPFS via opfs-sahpool, or
// memory for a non-owner tab — see vectorStoreOwnership.ts) and answers
// CatalogueClient requests with catalogueDb.ts. Requests run one at a time.

import {
	applyMemoryProfile,
	resolveMemoryProfile,
} from "@edgeproc/browser/sqlite";
import type { CatalogueRequest, CatalogueResponse } from "./catalogueClient";
import { CatalogueDb, type CatalogueSqlDatabase } from "./catalogueDb";
import { assertPinnedRuntime, sqlite3InitModule } from "./catalogueSqlite";
import type { StorePersistence } from "./vectorStoreOwnership";

const POOL_NAME = "edgereco-catalogue";
const DB_FILE = "/edgereco-catalogue.sqlite3";

let catalogue: CatalogueDb | undefined;
let queue = Promise.resolve();

self.onmessage = (event: MessageEvent<CatalogueRequest & { id: number }>) => {
	const request = event.data;
	queue = queue.then(() => answer(request));
};

async function answer(request: CatalogueRequest & { id: number }) {
	let response: CatalogueResponse;
	try {
		response = { id: request.id, ok: true, value: await dispatch(request) };
	} catch (error) {
		response = {
			id: request.id,
			ok: false,
			error: {
				name: error instanceof Error ? error.name : "Error",
				message: error instanceof Error ? error.message : String(error),
			},
		};
	}
	self.postMessage(response);
}

async function dispatch(request: CatalogueRequest): Promise<unknown> {
	if (request.operation === "open") {
		if (catalogue !== undefined) {
			throw new Error("catalogue worker is already open");
		}
		catalogue = await open(request.dimension, request.persistence);
		return undefined;
	}
	if (catalogue === undefined) {
		throw new Error("catalogue worker is not open");
	}
	switch (request.operation) {
		case "replace":
			return catalogue.replace(request.revision);
		case "hybrid":
			return catalogue.hybrid(request.query, request.vector, request.k);
		case "vectorSearch":
			return catalogue.vectorSearch(request.vector, request.k);
		case "nearest":
			return catalogue.nearest(request.productId, request.k);
		case "dispose":
			catalogue.close();
			catalogue = undefined;
			return undefined;
	}
}

async function open(
	dimension: number,
	persistence: StorePersistence,
): Promise<CatalogueDb> {
	const sqlite = await sqlite3InitModule({
		print: () => undefined,
		printErr: (...args) => console.error(...args),
	});
	const raw =
		persistence === "opfs"
			? new (
					await sqlite.installOpfsSAHPoolVfs({ name: POOL_NAME })
				).OpfsSAHPoolDb(DB_FILE)
			: new sqlite.oo1.DB(":memory:");
	try {
		assertPinnedRuntime(raw);
		// Page cache and heap limits sized to the device; conservative on iOS.
		applyMemoryProfile(
			{
				exec: (sql) => raw.exec({ sql }),
				selectObjects: (sql) => raw.selectObjects(sql),
			},
			resolveMemoryProfile("auto"),
		);
		if (persistence === "opfs") {
			applyPrivacyPragmas(raw);
		}
		return new CatalogueDb(raw, dimension);
	} catch (error) {
		raw.close();
		throw error;
	}
}

/** Deleted rows are zeroed and no rollback journal outlives a transaction. */
function applyPrivacyPragmas(db: CatalogueSqlDatabase): void {
	db.exec({ sql: "PRAGMA secure_delete = ON" });
	const journal = db.selectObjects("PRAGMA journal_mode = DELETE")[0]
		?.journal_mode;
	const secureDelete = db.selectObjects("PRAGMA secure_delete")[0]
		?.secure_delete;
	if (journal !== "delete" || secureDelete !== 1) {
		throw new Error("persistent SQLite privacy pragmas were not applied");
	}
}
