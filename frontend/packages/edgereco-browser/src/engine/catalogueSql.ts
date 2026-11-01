// The ONE module in edge-reco that uses @gainratio/browser's SQL surface (it
// reaches the library through the package seam, ../gainratio.ts).
//
// @gainratio/browser/sql owns the SQLite build (FTS5, JSON1 and sqlite-vector on
// one connection), its Worker, the OPFS pool, the per-origin owner lock and the
// memory fallback. edge-reco only names its database and runs SQL. Swapping or
// upgrading the SQL engine touches this file and the seam, nothing else
// (sqlBoundary.test.ts and gainratioBoundary.test.ts enforce that).

import {
	importDatabaseFromStream,
	type OpfsPoolRemoval,
	type OpfsRoot,
	openSqlDatabase,
	removeOpfsPool,
	type SqlBind,
	type SqlImportOptions,
	type SqlImportResult,
	type SqlRow,
	type SqlStatement,
	type SqlStorage,
	type SqlWorkerFactory,
	sqlDatabasePoolName,
	sqliteVectorPoolName,
} from "../gainratio";

export type {
	SqlBind,
	SqlImportOptions,
	SqlImportResult,
	SqlRow,
	SqlStatement,
	SqlStorage,
};

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
	/** Atomically validate and swap in a canonical SQLite database image. */
	importDatabase?(
		bytes: Uint8Array,
		options?: SqlImportOptions,
	): Promise<SqlImportResult>;
	/** Serialize the open SQLite database into a standalone SQLite image. */
	exportDatabase?(): Promise<Uint8Array>;
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
export function openCatalogueSql(
	deps: OpenCatalogueSqlDeps = {},
): Promise<CatalogueSql> {
	return openNamedSql(CATALOGUE_DATABASE, "catalogue", deps);
}

/**
 * Stream a canonical SQLite database chunk-by-chunk directly into the
 * catalogue's OPFS database (`edgereco-catalogue`), without materializing a
 * full-file `Uint8Array` or an in-memory SQLite database.
 *
 * The caller must close any active `CatalogueSql` connection to
 * `edgereco-catalogue` before calling this function and reopen afterward, so
 * the exclusive OPFS pool lock and `FileSystemSyncAccessHandle`s are free.
 */
export async function importCatalogueSqlFromChunks(
	chunks: AsyncIterable<Uint8Array>,
	deps: OpenCatalogueSqlDeps = {},
): Promise<SqlStorage> {
	let streamError: unknown;
	const stream = chunksToReadableStream(chunks, (error) => {
		streamError = error;
	});
	try {
		return await importDatabaseFromStream(CATALOGUE_DATABASE, stream, {
			memoryProfile: "auto",
			...deps,
		});
	} catch (error) {
		if (streamError !== undefined) {
			throw streamError;
		}
		throw error;
	}
}

function chunksToReadableStream(
	chunks: AsyncIterable<Uint8Array>,
	onError?: (error: unknown) => void,
): ReadableStream<Uint8Array> {
	const iterator = chunks[Symbol.asyncIterator]();
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const next = await iterator.next();
				if (next.done) {
					controller.close();
					return;
				}
				const chunk = next.value;
				if (!ArrayBuffer.isView(chunk) || chunk.byteLength === 0) {
					throw new TypeError(
						"SQLite chunk stream must yield non-empty Uint8Array chunks",
					);
				}
				const view = chunk as ArrayBufferView;
				controller.enqueue(
					chunk instanceof Uint8Array
						? chunk
						: new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
				);
			} catch (error) {
				onError?.(error);
				throw error;
			}
		},
		async cancel(reason) {
			await iterator.return?.(reason);
		},
	});
}

/** OPFS first, memory when refused or owned elsewhere; logs where it landed. */
async function openNamedSql(
	name: string,
	label: string,
	deps: OpenCatalogueSqlDeps,
): Promise<CatalogueSql> {
	const sql = await openSqlDatabase(
		{
			name,
			persistence: "opfs",
			fallback: "memory",
			memoryProfile: "auto",
		},
		deps,
	);
	console.info(`[edge-reco] ${label} database storage`, sql.storage);
	return sql;
}

/**
 * The shopper's own database: taste history and any future preferences. It is
 * SEPARATE from the catalogue on purpose. The catalogue database is disposable
 * (rebuilt from the signed bundle every boot); this one is user data, so it is
 * never rebuilt, never deleted on a catalogue refresh, and it is the one a
 * future export/import covers.
 */
export const USER_DATABASE = "edgereco-user";

/**
 * Open the user database in OPFS. When OPFS is refused it runs in memory
 * ("opfs-unavailable"); when another tab owns the pool it runs in memory
 * ("pool-in-use") and the owner tab holds the durable copy.
 */
export function openUserSql(
	deps: OpenCatalogueSqlDeps = {},
): Promise<CatalogueSql> {
	return openNamedSql(USER_DATABASE, "user", deps);
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
		const result = await removeOpfsPool(pool, deps);
		(deps.log ?? console.info)(`${label}: ${result}`);
		return result;
	} catch (error) {
		console.warn(`${label}: failed`, error);
		return "failed";
	}
}

/**
 * Remove the disposable `edgereco-catalogue` OPFS SQLite pool while leaving
 * `edgereco-user` taste data untouched. Used by explicit cache resets and
 * guarded one-time recovery from a corrupt or interrupted catalogue swap.
 */
export async function clearCatalogueSqlStorage(
	deps: RetireLegacyVectorPoolDeps = {},
): Promise<LegacyPoolResult> {
	const label = `[edge-reco] catalogue sql pool ${CATALOGUE_DATABASE}`;
	try {
		const pool = await sqlDatabasePoolName(CATALOGUE_DATABASE);
		const result = await removeOpfsPool(pool, deps);
		(deps.log ?? console.info)(`${label}: ${result}`);
		return result;
	} catch (error) {
		console.warn(`${label}: failed`, error);
		return "failed";
	}
}
