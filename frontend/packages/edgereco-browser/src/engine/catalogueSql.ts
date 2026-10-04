// The ONE file in edge-reco that talks to @gainratio/browser's SQL seam.
//
// @gainratio/browser/sql owns the SQLite build (FTS5, JSON1 and sqlite-vector on
// one connection), its Worker, the OPFS pool, the per-origin owner lock and the
// memory fallback. edge-reco only names its database and runs SQL. Swapping or
// upgrading the engine touches this file and nothing else
// (sqlBoundary.test.ts enforces that).

import {
	type OpfsPoolRemoval,
	type OpfsRoot,
	openSqlDatabase,
	removeOpfsPool,
	type SqlBind,
	type SqlRow,
	type SqlStatement,
	type SqlStorage,
	type SqlWorkerFactory,
	sqliteVectorPoolName,
} from "@gainratio/browser/sql";

export type { SqlBind, SqlRow, SqlStatement, SqlStorage };

/** The catalogue database's stable name (hashed into its OPFS pool). */
export const CATALOGUE_DATABASE = "edgereco-catalogue";

/** The vector index main's build stored in OPFS before this database existed. */
export const LEGACY_VECTOR_INDEX = "edgereco-catalog";

/** The slice of an open SQL database the catalogue uses. */
export interface CatalogueSql {
	/** Where the database actually lives: OPFS, or memory and why. */
	readonly storage: SqlStorage;
	exec(sql: string, bind?: SqlBind): Promise<unknown>;
	query(sql: string, bind?: SqlBind): Promise<ReadonlyArray<SqlRow>>;
	/** All statements in one BEGIN IMMEDIATE … COMMIT. */
	transaction(statements: ReadonlyArray<SqlStatement>): Promise<unknown>;
	close(): Promise<void>;
}

export interface OpenCatalogueSqlDeps {
	/** Tests run the library's Worker handler in-process instead. */
	readonly workerFactory?: SqlWorkerFactory;
}

/**
 * Open the catalogue database in OPFS. When OPFS is unusable or another tab
 * owns the pool it opens in memory instead: loadVectorIndex rebuilds the whole
 * verified catalogue on every boot, so memory loses nothing.
 */
export async function openCatalogueSql(
	deps: OpenCatalogueSqlDeps = {},
): Promise<CatalogueSql> {
	const sql = await openSqlDatabase(
		{ name: CATALOGUE_DATABASE, persistence: "opfs", fallback: "memory" },
		deps.workerFactory === undefined
			? {}
			: { workerFactory: deps.workerFactory },
	);
	console.info("[edge-reco] catalogue database storage", sql.storage);
	return sql;
}

export type LegacyPoolResult = OpfsPoolRemoval | "failed";

export interface RetireLegacyVectorPoolDeps {
	/** Defaults to the origin's OPFS root. */
	readonly root?: OpfsRoot;
	readonly log?: (message: string) => void;
}

/**
 * Delete the OPFS vector pool main's build left on returning visitors' devices.
 * Idempotent: "removed" once, "absent" after; "in-use" while an old tab still
 * holds it (the next boot retries). Never fails boot.
 */
export async function retireLegacyVectorPool(
	deps: RetireLegacyVectorPoolDeps = {},
): Promise<LegacyPoolResult> {
	const label = `[edge-reco] legacy vector pool ${LEGACY_VECTOR_INDEX}`;
	try {
		const pool = await sqliteVectorPoolName(LEGACY_VECTOR_INDEX);
		const result = await removeOpfsPool(
			pool,
			deps.root === undefined ? {} : { root: deps.root },
		);
		(deps.log ?? console.info)(`${label}: ${result}`);
		return result;
	} catch (error) {
		console.warn(`${label}: failed`, error);
		return "failed";
	}
}
