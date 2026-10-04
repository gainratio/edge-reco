// The ONE file in @edgereco/browser that imports @gainratio/browser.
//
// @gainratio/browser is the shared engine substrate: signed-bundle sync, the
// OPFS cache and its rollback floor, the engine Worker, the SQL Worker (SQLite
// with FTS5 and sqlite-vector) and the network sentinel. Everything else in
// this package reaches it through here, so upgrading, renaming or swapping the
// library touches this file and nothing else. gainratioBoundary.test.ts fails on
// any other production importer; sqlBoundary.test.ts additionally keeps the SQL
// surface inside engine/catalogueSql.ts, the only module that uses it.

export type {
	EngineErrorCode,
	IndexManifest,
	SyncResult,
	VersionPointer,
} from "@gainratio/browser";
export {
	DEFAULT_EMBED_TIMEOUT_MS,
	EngineClient,
	fetchBytes,
	installNetworkSentinel,
	MAX_TRUST_ROOT_BYTES,
	parseTrustRoot,
	resolveIndexedDbLayout,
	WorkerCrashError,
	WorkerTimeoutError,
} from "@gainratio/browser";
export {
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
// The library's engine Worker, bundled by Vite as this app's own Worker chunk
// (the `?worker` import Vite documents for package workers). Constructing it
// runs the library's worker module, which installs the engine handler.
export { default as EngineWorker } from "@gainratio/browser/worker?worker";
