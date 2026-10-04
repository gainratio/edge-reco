// TEST-ONLY. A user database that outlives the data client, so a test can
// "reload" (build a fresh client) and see the same SQLite data, the way a real
// tab reopens the same OPFS database. `storage` picks what the connection
// reports (owner / secondary / volatile); the bytes stay in memory on the
// in-process Worker. Never bundled.

import { type CatalogueSql, openUserSql } from "../catalogueSql";
import { SqlTasteStore, type TasteStore } from "../tasteStore";
import { nodeSqlWorkerFactory } from "./nodeSqlWorker";

export type SharedStorage = "owner" | "secondary" | "volatile";

export interface SharedUserDb {
	/** Opens a TasteStore over the shared database. */
	readonly open: () => Promise<TasteStore>;
	/** The underlying connection, for direct assertions. */
	readonly sql: CatalogueSql;
}

const STORAGE: Readonly<Record<SharedStorage, CatalogueSql["storage"]>> = {
	owner: { persistence: "opfs", pool: "test-pool", file: "test.db" },
	secondary: { persistence: "memory", reason: "pool-in-use" },
	volatile: { persistence: "memory", reason: "opfs-unavailable" },
};

/** Open one shared user database reporting the given storage. */
export async function sharedUserDb(
	storage: SharedStorage = "owner",
): Promise<SharedUserDb> {
	const inner = await openUserSql({ workerFactory: nodeSqlWorkerFactory });
	const sql: CatalogueSql = {
		storage: STORAGE[storage],
		exec: (text, bind) => inner.exec(text, bind),
		query: (text, bind) => inner.query(text, bind),
		transaction: (statements) => inner.transaction(statements),
		close: () => Promise.resolve(),
	};
	return { open: () => SqlTasteStore.open(sql), sql };
}
