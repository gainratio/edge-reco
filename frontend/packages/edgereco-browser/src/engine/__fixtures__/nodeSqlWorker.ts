/// <reference types="node" />
// TEST-ONLY. Node and jsdom have no Worker or OPFS, so this stands in for
// @edgeproc/browser's SQL Worker: it runs the library's OWN Worker-side handler
// and engine in-process, on the same pinned sqlite3.wasm, in memory. Every
// request and response is structured-cloned exactly as postMessage would. The
// production client (openSqlDatabase) is unchanged; only the far side of the
// message channel moves in-process.
//
// The library exports no Node entry for its SQL Worker, so this is the one file
// allowed to reach into its dist (sqlBoundary.test.ts). It is never bundled.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SqlEngine } from "../../../node_modules/@edgeproc/browser/dist/sql/engine.js";
import { createSqlWorkerHandler } from "../../../node_modules/@edgeproc/browser/dist/sql/handler.js";
import { resolveMemoryProfile } from "../../../node_modules/@edgeproc/browser/dist/sqlite/memoryProfile.js";
// @ts-expect-error -- sqlite3.mjs ships without type declarations.
import sqlite3InitModule from "../../../node_modules/@edgeproc/browser/dist/vector/sqlite/assets/sqlite3.mjs";
import type { OpenCatalogueSqlDeps } from "../catalogueSql";

type Handler = ReturnType<typeof createSqlWorkerHandler>;
type Request = Parameters<Handler>[0];
type RawDatabase = ConstructorParameters<typeof SqlEngine>[0];

interface NodeSqlite {
	readonly oo1: { readonly DB: new (filename: string) => RawDatabase };
}

const WASM_PATH = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../../node_modules/@edgeproc/browser/dist/vector/sqlite/assets/sqlite3.wasm",
);

let loaded: Promise<NodeSqlite> | undefined;

async function load(): Promise<NodeSqlite> {
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

const openEngine: Parameters<typeof createSqlWorkerHandler>[0] = async (
	options,
) => {
	loaded ??= load();
	const sqlite = await loaded;
	const engine = new SqlEngine(new sqlite.oo1.DB(":memory:"), {
		storage: { persistence: "memory", reason: "opfs-unavailable" },
		memoryProfile: resolveMemoryProfile(options.memoryProfile ?? "auto"),
	});
	return { engine, release: () => undefined };
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
			void handle(structuredClone(request)).then((response) => {
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
