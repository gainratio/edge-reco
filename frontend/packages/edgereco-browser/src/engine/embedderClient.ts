// Main-thread client that drives the embedder Worker. Presents the same Embedder
// interface as the in-process embedder so the search engine is agnostic to where
// the model runs; the Worker keeps model load + inference off the UI thread.
//
// Failure semantics: an embedder Worker that crashes during model load (the
// classic init failure) fires 'error'/'messageerror' but never replies — so
// every in-flight embed is rejected with a typed WorkerCrashError (and the
// client latches). A silent Worker is bounded by a per-request deadline
// (WorkerTimeoutError), generous by default because the first embed also
// downloads the ~25 MB model.

import {
	DEFAULT_EMBED_TIMEOUT_MS,
	WorkerCrashError,
	WorkerTimeoutError,
} from "@gainratio/browser";
import type { Embedder } from "./embedder";
import type { EmbedRequest, EmbedResponse } from "./embedderWorker";

/** A minimal Worker surface — what this client needs, so it is easy to fake. */
export interface WorkerLike {
	postMessage(
		message: EmbedRequest,
		transfer?: ReadonlyArray<Transferable>,
	): void;
	addEventListener(
		type: "message",
		listener: (event: MessageEvent<EmbedResponse>) => void,
	): void;
	addEventListener(
		type: "error",
		listener: (event: { message: string }) => void,
	): void;
	addEventListener(type: "messageerror", listener: () => void): void;
	terminate(): void;
}

/** Tuning knobs for the embedder client. */
export interface WorkerEmbedderOptions {
	readonly requestTimeoutMs?: number;
}

/** Spawns the embedder Worker as an ES module. */
export function spawnEmbedderWorker(): Worker {
	return new Worker(new URL("./embedderWorker.ts", import.meta.url), {
		type: "module",
	});
}

interface Pending {
	readonly resolve: (vector: Float32Array) => void;
	readonly reject: (error: Error) => void;
	readonly timer: ReturnType<typeof setTimeout>;
}

class WorkerEmbedder implements Embedder {
	readonly #worker: WorkerLike;
	readonly #pending = new Map<number, Pending>();
	readonly #timeoutMs: number;
	#nextId = 0;
	#crash: WorkerCrashError | undefined;
	#disposed = false;

	public constructor(worker: WorkerLike, options: WorkerEmbedderOptions = {}) {
		this.#worker = worker;
		this.#timeoutMs = options.requestTimeoutMs ?? DEFAULT_EMBED_TIMEOUT_MS;
		this.#worker.addEventListener("message", (event) => {
			this.#settle(event.data);
		});
		this.#worker.addEventListener("error", (event) => {
			this.#onCrash(event.message);
		});
		this.#worker.addEventListener("messageerror", () => {
			this.#onCrash("an embedder reply was not deserializable (messageerror)");
		});
	}

	#settle(response: EmbedResponse): void {
		const entry = this.#pending.get(response.id);
		if (entry === undefined) {
			return;
		}
		this.#pending.delete(response.id);
		clearTimeout(entry.timer);
		if (response.ok) {
			entry.resolve(response.vector);
		} else {
			entry.reject(new Error(response.error));
		}
	}

	#onCrash(reason: string): void {
		this.#crash ??= new WorkerCrashError(`embedder worker crashed: ${reason}`);
		for (const entry of this.#pending.values()) {
			clearTimeout(entry.timer);
			entry.reject(this.#crash);
		}
		this.#pending.clear();
	}

	/** Reject in-flight work and release the model worker. Safe to call twice. */
	public dispose(): void {
		if (this.#disposed) {
			return;
		}
		this.#disposed = true;
		this.#onCrash("embedder worker disposed");
		this.#worker.terminate();
	}

	public embed(text: string): Promise<Float32Array> {
		if (this.#crash !== undefined) {
			return Promise.reject(this.#crash);
		}
		const id = this.#nextId;
		this.#nextId += 1;
		return new Promise<Float32Array>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				reject(
					new WorkerTimeoutError(
						`embed request ${id} exceeded ${this.#timeoutMs}ms`,
					),
				);
			}, this.#timeoutMs);
			this.#pending.set(id, { resolve, reject, timer });
			this.#worker.postMessage({ id, text }, []);
		});
	}
}

/** Wrap a Worker (or Worker-like) as an Embedder. */
export function createWorkerEmbedder(
	worker: WorkerLike,
	options?: WorkerEmbedderOptions,
): Embedder {
	return new WorkerEmbedder(worker, options);
}
