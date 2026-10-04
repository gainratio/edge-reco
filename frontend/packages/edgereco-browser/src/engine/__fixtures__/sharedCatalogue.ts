// TEST-ONLY. A catalogue factory whose database outlives the runtime, so a test
// can "reload" (build a fresh runtime) and see the same SQLite data, the way a
// real tab reopens the same OPFS database. The connection reports itself as
// OPFS-backed so the durable paths (copy-then-retire) run; the bytes are still
// in memory, on the in-process Worker. Never bundled.

import { CatalogueDb, type CatalogueStoreFactory } from "../catalogueDb";
import { type CatalogueSql, openCatalogueSql } from "../catalogueSql";
import { nodeSqlWorkerFactory } from "./nodeSqlWorker";

export interface SharedCatalogue {
	readonly factory: CatalogueStoreFactory;
	/** The underlying connection, for direct assertions. */
	readonly sql: CatalogueSql;
}

/** Open one shared database; `durable` picks the storage it reports. */
export async function sharedCatalogue(
	durable = true,
): Promise<SharedCatalogue> {
	const inner = await openCatalogueSql({ workerFactory: nodeSqlWorkerFactory });
	const sql: CatalogueSql = {
		storage: durable
			? { persistence: "opfs", pool: "test-pool", file: "test.db" }
			: { persistence: "memory", reason: "pool-in-use" },
		exec: (text, bind) => inner.exec(text, bind),
		query: (text, bind) => inner.query(text, bind),
		transaction: (statements) => inner.transaction(statements),
		// A runtime dispose must not drop the shared database.
		close: () => Promise.resolve(),
	};
	return {
		factory: ({ dimension }) => CatalogueDb.open(sql, dimension),
		sql,
	};
}
