/// <reference types="node" />
// TEST-ONLY. Node and jsdom have no Worker or OPFS, so this stands in for
// @gainratio/browser's SQL Worker: it runs the library's OWN Worker-side handler
// and engine in-process, on the same pinned sqlite3.wasm, in memory. Every
// request and response is structured-cloned exactly as postMessage would. The
// production client (openSqlDatabase) is unchanged; only the far side of the
// message channel moves in-process.
//
// @gainratio/browser 0.2.0 exports no entry for its SQL Worker internals
// (SqlEngine, createSqlWorkerHandler) or its sqlite3.mjs/.wasm build, so this
// is the one file allowed to reach into its dist (sqlBoundary.test.ts).
// resolveMemoryProfile comes from the published ./sqlite entry. Never bundled.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveMemoryProfile } from "@gainratio/browser/sqlite";
import { SqlEngine } from "../../../node_modules/@gainratio/browser/dist/sql/engine.js";
import { createSqlWorkerHandler } from "../../../node_modules/@gainratio/browser/dist/sql/handler.js";
import {
	type InProcessSqlite,
	initInProcessSqlite,
} from "../../../node_modules/@gainratio/browser/dist/sql/nodeRuntime.js";
import type { OpenCatalogueSqlDeps } from "../catalogueSql";

type Handler = ReturnType<typeof createSqlWorkerHandler>;
type Request = Parameters<Handler>[0];

const WASM_PATH = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../../node_modules/@gainratio/browser/dist/vector/sqlite/assets/sqlite3.wasm",
);

let loaded: Promise<InProcessSqlite> | undefined;

async function load(): Promise<InProcessSqlite> {
	const wasmBinary = new Uint8Array(await readFile(WASM_PATH));
	return initInProcessSqlite(wasmBinary);
}

const openEngine: Parameters<typeof createSqlWorkerHandler>[0] = async (
	options,
) => {
	loaded ??= load();
	const sqlite = await loaded;
	const engine = new SqlEngine(sqlite.openMemory(), {
		storage: { persistence: "memory", reason: "opfs-unavailable" },
		memoryProfile: resolveMemoryProfile(options.memoryProfile ?? "auto"),
		serializer: sqlite.serializer,
		control: sqlite.control,
	});
	return { engine, release: () => Promise.resolve() };
};

type WorkerFactory = NonNullable<OpenCatalogueSqlDeps["workerFactory"]>;
type Listener = (event: never) => void;

/** One in-process "Worker" per open, like the library's default factory. */
export const nodeSqlWorkerFactory: WorkerFactory = () => {
	const listeners: Listener[] = [];
	// Each fake Worker gets its own handler, i.e. its own connection.
	const handle: Handler = createSqlWorkerHandler(openEngine);
	return {
		postMessage(request: Request): void {
			const cloned = structuredClone(request);
			const normalized: Request =
				cloned.operation === "import"
					? { ...cloned, bytes: new Uint8Array(cloned.bytes) }
					: cloned;
			void handle(normalized).then((response) => {
				for (const listener of listeners) {
					listener({ data: structuredClone(response) } as never);
				}
			});
		},
		terminate(): void {
			listeners.length = 0;
		},
		addEventListener(type: string, listener: Listener): void {
			if (type === "message") {
				listeners.push(listener);
			}
		},
	};
};
