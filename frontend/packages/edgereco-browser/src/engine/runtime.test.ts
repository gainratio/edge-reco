import {
	type IndexManifest,
	MemoryCacheStore,
	materializeFile,
	type SyncResult,
	syncIndex,
} from "@edgeproc/browser";
import { describe, expect, it, vi } from "vitest";
import { openNodeCatalogueStore } from "./__fixtures__/nodeCatalogue";
import type { CatalogueStore, CatalogueStoreOptions } from "./catalogueClient";
import type { Embedder } from "./embedder";
import { catalogFetch } from "./fixtures";
import { type EnginePort, EngineRuntime, type RuntimeConfig } from "./runtime";

const config: RuntimeConfig = {
	bundleBaseUrl: "https://edge.example/bundle",
	pubkeyUrl: "https://edge.example/public.key",
};

type DisposableEngine = EnginePort & { terminated: boolean; terminate(): void };
type DisposableEmbedder = Embedder & { disposed: boolean; dispose(): void };

function enginePort(
	options: {
		sync?: EnginePort["sync"];
		readFile?: EnginePort["readFile"];
	} = {},
): DisposableEngine {
	return {
		terminated: false,
		terminate() {
			this.terminated = true;
		},
		sync:
			options.sync ??
			(async () =>
				({
					version: "1",
					manifestHash: "a".repeat(64),
					chunksFetched: 0,
					chunksReused: 0,
					bytesFetched: 0,
				}) satisfies SyncResult),
		readFile:
			options.readFile ??
			(async (path: string) => {
				if (path === "ranking_config.json" || path === "cooccurrence.json") {
					throw new Error(`file ${path} not in manifest`);
				}
				return new Uint8Array();
			}),
	};
}

function rejectingEmbedder(error: Error): DisposableEmbedder {
	return {
		disposed: false,
		dispose() {
			this.disposed = true;
		},
		embed: vi.fn(() => Promise.reject(error)),
	};
}

async function syncedEnginePort(): Promise<DisposableEngine> {
	const store = new MemoryCacheStore();
	const { fetchBytes } = catalogFetch();
	const result = await syncIndex({
		baseUrl: "/cat",
		store,
		fetchBytes,
		verify: () => Promise.resolve(),
	});
	const manifest = JSON.parse(
		new TextDecoder().decode(await store.getManifest(result.manifestHash)),
	) as IndexManifest;
	return enginePort({
		readFile: (path) => materializeFile(store, manifest, path),
	});
}

describe("EngineRuntime resource lifecycle", () => {
	it("terminates the sync worker when bundle sync fails", async () => {
		const engine = enginePort({
			sync: () => Promise.reject(new Error("origin unavailable")),
		});
		const runtime = new EngineRuntime({
			spawnEngine: () => engine,
			makeEmbedder: () => {
				throw new Error("embedder should not be created");
			},
		});

		await expect(runtime.bootstrap(config)).rejects.toThrow(
			"origin unavailable",
		);
		expect(engine.terminated).toBe(true);
	});

	it("disposes both workers when model warmup times out", async () => {
		const engine = enginePort();
		const embedder = rejectingEmbedder(new Error("embed timeout"));
		const runtime = new EngineRuntime({
			spawnEngine: () => engine,
			makeEmbedder: () => {
				expect(engine.terminated).toBe(true);
				return embedder;
			},
		});

		await expect(runtime.bootstrap(config)).rejects.toThrow("embed timeout");
		expect(engine.terminated).toBe(true);
		expect(embedder.disposed).toBe(true);
	});

	it("starts a fresh worker pair after a failed bootstrap retry", async () => {
		const firstEngine = enginePort();
		const secondEngine = enginePort();
		const firstEmbedder = rejectingEmbedder(new Error("first boot failed"));
		const secondEmbedder = rejectingEmbedder(new Error("second boot failed"));
		const engines = [firstEngine, secondEngine];
		const embedders = [firstEmbedder, secondEmbedder];
		const runtime = new EngineRuntime({
			spawnEngine: () => engines.shift() ?? secondEngine,
			makeEmbedder: () => embedders.shift() ?? secondEmbedder,
		});

		await expect(runtime.bootstrap(config)).rejects.toThrow(
			"first boot failed",
		);
		await expect(runtime.bootstrap(config)).rejects.toThrow(
			"second boot failed",
		);
		expect(firstEngine.terminated).toBe(true);
		expect(firstEmbedder.disposed).toBe(true);
		expect(secondEngine.terminated).toBe(true);
		expect(secondEmbedder.disposed).toBe(true);
	});

	it("disposes active workers and invalidates an in-flight bootstrap", async () => {
		const engine = enginePort();
		let resolveWarmup: ((vector: Float32Array) => void) | undefined;
		const embedder: DisposableEmbedder = {
			disposed: false,
			dispose() {
				this.disposed = true;
			},
			embed: () =>
				new Promise<Float32Array>((resolve) => {
					resolveWarmup = resolve;
				}),
		};
		const runtime = new EngineRuntime({
			spawnEngine: () => engine,
			makeEmbedder: () => embedder,
		});

		const pending = runtime.bootstrap(config);
		await vi.waitFor(() => expect(resolveWarmup).toBeTypeOf("function"));
		await runtime.dispose();
		expect(engine.terminated).toBe(true);
		expect(embedder.disposed).toBe(true);
		resolveWarmup?.(new Float32Array(384));
		await expect(pending).rejects.toThrow("disposed during bootstrap");
	});

	it("disposes a vector index that finishes opening after runtime disposal", async () => {
		const engine = await syncedEnginePort();
		const embedder: DisposableEmbedder = {
			disposed: false,
			dispose() {
				this.disposed = true;
			},
			embed: () => Promise.resolve(new Float32Array(384)),
		};
		let resolveIndex:
			| ((store: CatalogueStore | PromiseLike<CatalogueStore>) => void)
			| undefined;
		let store: CatalogueStore | undefined;
		const runtime = new EngineRuntime({
			spawnEngine: () => engine,
			makeEmbedder: () => embedder,
			makeCatalogue: (options: CatalogueStoreOptions) =>
				new Promise<CatalogueStore>((resolve) => {
					void openNodeCatalogueStore(options).then((opened) => {
						store = opened;
						resolveIndex = resolve;
					});
				}),
		});

		const pending = runtime.bootstrap(config);
		await vi.waitFor(() => expect(resolveIndex).toBeTypeOf("function"));
		await runtime.dispose();
		const dispose = vi.spyOn(store as CatalogueStore, "dispose");
		resolveIndex?.(store as CatalogueStore);

		await expect(pending).rejects.toThrow("disposed during bootstrap");
		expect(dispose).toHaveBeenCalledOnce();
	});
});

describe("EngineRuntime.clearBundleCache — explicit user recovery only", () => {
	function clearablePort(clear: () => Promise<void>): DisposableEngine & {
		clear: () => Promise<void>;
	} {
		return { ...enginePort(), clear };
	}

	it("clears the durable bundle cache through a dedicated, released sync worker", async () => {
		const clear = vi.fn(() => Promise.resolve());
		const port = clearablePort(clear);
		const deleteFloorDatabase = vi.fn(() => {
			// The floor database is deleted only AFTER the library clear ran under
			// the Web Lock and its worker let go of the connection.
			expect(clear).toHaveBeenCalledOnce();
			expect(port.terminated).toBe(true);
			return Promise.resolve();
		});
		const runtime = new EngineRuntime({
			spawnEngine: () => port,
			makeEmbedder: () => {
				throw new Error("clearing must never load the model");
			},
			deleteFloorDatabase,
		});

		await runtime.clearBundleCache();

		expect(clear).toHaveBeenCalledOnce();
		expect(port.terminated).toBe(true);
		expect(deleteFloorDatabase).toHaveBeenCalledOnce();
	});

	it("fails the clear when the floor database cannot be deleted", async () => {
		const runtime = new EngineRuntime({
			spawnEngine: () => clearablePort(() => Promise.resolve()),
			makeEmbedder: () => rejectingEmbedder(new Error("unused")),
			deleteFloorDatabase: () =>
				Promise.reject(new Error("still open in another tab")),
		});

		await expect(runtime.clearBundleCache()).rejects.toThrow(
			"still open in another tab",
		);
	});

	it("does not delete the floor database when the library clear itself failed", async () => {
		const deleteFloorDatabase = vi.fn(() => Promise.resolve());
		const runtime = new EngineRuntime({
			spawnEngine: () =>
				clearablePort(() => Promise.reject(new Error("lock timeout"))),
			makeEmbedder: () => rejectingEmbedder(new Error("unused")),
			deleteFloorDatabase,
		});

		await expect(runtime.clearBundleCache()).rejects.toThrow("lock timeout");
		expect(deleteFloorDatabase).not.toHaveBeenCalled();
	});

	it("tears down the failed boot's workers before the clearing worker starts", async () => {
		const failing = clearablePort(() => Promise.resolve());
		const embedder = rejectingEmbedder(new Error("model failed"));
		const clearing = clearablePort(() => Promise.resolve());
		const ports = [failing, clearing];
		const runtime = new EngineRuntime({
			spawnEngine: () => {
				const next = ports.shift() ?? clearing;
				if (next === clearing) {
					// The old sync worker has released its Web Lock + OPFS handles
					// and the embedder is gone before a new worker touches the cache.
					expect(failing.terminated).toBe(true);
					expect(embedder.disposed).toBe(true);
				}
				return next;
			},
			makeEmbedder: () => embedder,
			deleteFloorDatabase: () => Promise.resolve(),
		});

		await expect(runtime.bootstrap(config)).rejects.toThrow("model failed");
		await runtime.clearBundleCache();
		expect(clearing.terminated).toBe(true);
	});

	it("still releases the worker and surfaces the failure when the clear fails", async () => {
		const port = clearablePort(() =>
			Promise.reject(new Error("timed out acquiring OPFS mutation lock")),
		);
		const runtime = new EngineRuntime({
			spawnEngine: () => port,
			makeEmbedder: () => rejectingEmbedder(new Error("unused")),
		});

		await expect(runtime.clearBundleCache()).rejects.toThrow(
			"timed out acquiring OPFS mutation lock",
		);
		expect(port.terminated).toBe(true);
	});

	it("refuses a port that cannot clear rather than silently doing nothing", async () => {
		const port = enginePort();
		const runtime = new EngineRuntime({
			spawnEngine: () => port,
			makeEmbedder: () => rejectingEmbedder(new Error("unused")),
		});

		await expect(runtime.clearBundleCache()).rejects.toThrow(/cannot clear/u);
		expect(port.terminated).toBe(true);
	});

	it("refuses to clear while a bootstrap is in flight (it would race the live sync)", async () => {
		let releaseSync: (() => void) | undefined;
		const clear = vi.fn(() => Promise.resolve());
		const booting = clearablePort(clear);
		booting.sync = () =>
			new Promise<SyncResult>((_resolve, reject) => {
				releaseSync = () => reject(new Error("aborted"));
			});
		const runtime = new EngineRuntime({
			spawnEngine: () => booting,
			makeEmbedder: () => rejectingEmbedder(new Error("unused")),
		});

		const pending = runtime.bootstrap(config);
		await vi.waitFor(() => expect(releaseSync).toBeTypeOf("function"));
		await expect(runtime.clearBundleCache()).rejects.toThrow(
			/booting or running/u,
		);
		expect(clear).not.toHaveBeenCalled();
		releaseSync?.();
		await expect(pending).rejects.toThrow("aborted");
	});

	it("lets a bootstrap run again after a failed boot and an explicit clear", async () => {
		const clear = vi.fn(() => Promise.resolve());
		const failing = clearablePort(clear);
		failing.sync = () => Promise.reject(new Error("RollbackError"));
		const clearing = clearablePort(clear);
		const retry = clearablePort(clear);
		retry.sync = () => Promise.reject(new Error("second attempt reached"));
		const ports = [failing, clearing, retry];
		const runtime = new EngineRuntime({
			spawnEngine: () => ports.shift() ?? retry,
			makeEmbedder: () => rejectingEmbedder(new Error("unused")),
			deleteFloorDatabase: () => Promise.resolve(),
		});

		await expect(runtime.bootstrap(config)).rejects.toThrow("RollbackError");
		await runtime.clearBundleCache();
		await expect(runtime.bootstrap(config)).rejects.toThrow(
			"second attempt reached",
		);
		expect(clear).toHaveBeenCalledOnce();
		expect(clearing.terminated).toBe(true);
	});
});
