// The one place edge-reco loads SQLite itself.
//
// It is the SAME pinned build @edgeproc/browser ships for its vector Worker
// (SQLite 3.53.4 + sqlite-vector 1.1.2, compiled with FTS5, JSON1 and window
// functions), so the app carries one SQLite binary, not two. @edgeproc/browser
// does not export a general SQL surface yet: its Worker only speaks the vector
// protocol, which cannot hold an FTS5 table or run a fusion query. Until it does,
// this file reaches the build by path and pins its version at open
// (assertPinnedRuntime), so an upgrade that moves or changes the build fails
// loudly instead of silently.

// @ts-expect-error -- sqlite3.mjs ships without type declarations; typed below.
import init from "../../node_modules/@edgeproc/browser/dist/vector/sqlite/assets/sqlite3.mjs";
import type { CatalogueSqlDatabase } from "./catalogueDb";

/** The SQLite version this build must report. */
export const PINNED_SQLITE_VERSION = "3.53.4";
/** The sqlite-vector version this build must report. */
export const PINNED_VECTOR_VERSION = "1.1.2";

/** sqlite-wasm's opfs-sahpool VFS handle. */
export interface SahPool {
	readonly OpfsSAHPoolDb: new (filename: string) => CatalogueSqlDatabase;
}

/** The slice of the sqlite3 module object edge-reco uses. */
export interface Sqlite3Module {
	readonly oo1: { readonly DB: new (filename: string) => CatalogueSqlDatabase };
	installOpfsSAHPoolVfs(options: { readonly name: string }): Promise<SahPool>;
}

export interface Sqlite3InitOptions {
	readonly wasmBinary?: Uint8Array;
	readonly print?: (...args: unknown[]) => void;
	readonly printErr?: (...args: unknown[]) => void;
}

export const sqlite3InitModule = init as (
	options?: Sqlite3InitOptions,
) => Promise<Sqlite3Module>;

/** Refuse a SQLite build other than the pinned one. */
export function assertPinnedRuntime(db: CatalogueSqlDatabase): void {
	const row = db.selectObjects(
		"SELECT sqlite_version() AS sqlite, vector_version() AS vector, sqlite_compileoption_used('ENABLE_FTS5') AS fts5",
	)[0];
	if (
		row?.sqlite !== PINNED_SQLITE_VERSION ||
		row.vector !== PINNED_VECTOR_VERSION ||
		row.fts5 !== 1
	) {
		throw new Error(`unexpected SQLite runtime: ${JSON.stringify(row)}`);
	}
}
