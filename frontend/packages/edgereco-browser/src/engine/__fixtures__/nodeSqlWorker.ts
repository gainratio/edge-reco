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
const lastClosedByName = new Map<string, Uint8Array>();
const pendingStreamImports = new Map<string, Uint8Array>();

async function load(): Promise<InProcessSqlite> {
	const wasmBinary = new Uint8Array(await readFile(WASM_PATH));
	return initInProcessSqlite(wasmBinary);
}

const openEngine: Parameters<typeof createSqlWorkerHandler>[0] = async (
	options,
) => {
	loaded ??= load();
	const sqlite = await loaded;
	const raw = sqlite.openMemory();
	const origClose = raw.close.bind(raw);
	raw.close = () => {
		try {
			lastClosedByName.set(options.name, sqlite.serializer.serialize(raw));
		} catch {
			// Ignore serialization errors if already closed.
		}
		origClose();
	};
	const engine = new SqlEngine(raw, {
		storage: { persistence: "memory", reason: "opfs-unavailable" },
		memoryProfile: resolveMemoryProfile(options.memoryProfile ?? "auto"),
		serializer: sqlite.serializer,
		control: sqlite.control,
	});
	const pending = pendingStreamImports.get(options.name);
	if (pending !== undefined) {
		pendingStreamImports.delete(options.name);
		engine.importDatabase(pending);
	}
	return { engine, release: () => Promise.resolve() };
};

function portChunks(port: MessagePort): AsyncIterable<Uint8Array> {
	return {
		async *[Symbol.asyncIterator]() {
			for (;;) {
				port.postMessage({ type: "pull" });
				const message = await new Promise<{
					readonly done?: boolean;
					readonly chunk?: Uint8Array;
					readonly error?: string;
				}>((resolve) => {
					port.onmessage = (event) => resolve(event.data);
				});
				if (message.error !== undefined) {
					throw new Error(message.error);
				}
				if (message.done === true) {
					return;
				}
				if (!ArrayBuffer.isView(message.chunk)) {
					throw new TypeError("expected Uint8Array chunk");
				}
				yield new Uint8Array(
					message.chunk.buffer,
					message.chunk.byteOffset,
					message.chunk.byteLength,
				);
			}
		},
	};
}

const importStream: NonNullable<
	Parameters<typeof createSqlWorkerHandler>[1]
> = async (options, port) => {
	loaded ??= load();
	const sqlite = await loaded;
	const parts: Uint8Array[] = [];
	let total = 0;
	try {
		for await (const value of portChunks(port)) {
			const copy = new Uint8Array(value);
			parts.push(copy);
			total += copy.byteLength;
		}
		const combined = new Uint8Array(total);
		let offset = 0;
		for (const part of parts) {
			combined.set(part, offset);
			offset += part.byteLength;
		}
		const check = new SqlEngine(sqlite.openMemory(), {
			storage: { persistence: "memory", reason: "opfs-unavailable" },
			memoryProfile: resolveMemoryProfile(options.memoryProfile ?? "auto"),
			serializer: sqlite.serializer,
			control: sqlite.control,
		});
		try {
			check.importDatabase(combined);
		} finally {
			check.close();
		}
		pendingStreamImports.set(options.name, combined);
		return { persistence: "memory", reason: "opfs-unavailable" } as const;
	} catch (error) {
		const previous = lastClosedByName.get(options.name);
		if (previous !== undefined) {
			pendingStreamImports.set(options.name, previous);
		}
		throw error;
	} finally {
		port.close();
	}
};

type WorkerFactory = NonNullable<OpenCatalogueSqlDeps["workerFactory"]>;
type Listener = (event: never) => void;

/** One in-process "Worker" per open, like the library's default factory. */
export const nodeSqlWorkerFactory: WorkerFactory = () => {
	const listeners: Listener[] = [];
	// Each fake Worker gets its own handler, i.e. its own connection.
	const handle: Handler = createSqlWorkerHandler(openEngine, importStream);
	return {
		postMessage(request: Request): void {
			const normalized: Request =
				request.operation === "import-stream"
					? request
					: (() => {
							const cloned = structuredClone(request);
							return cloned.operation === "import"
								? { ...cloned, bytes: new Uint8Array(cloned.bytes) }
								: cloned;
						})();
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
