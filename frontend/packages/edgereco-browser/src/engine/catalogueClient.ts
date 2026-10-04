// Main-thread handle on the catalogue database (catalogueDb.ts), which lives in
// its own Worker (catalogueWorker.ts) so synchronous SQLite and OPFS never block
// the UI thread. Requests are answered in order; a Worker crash fails every
// pending and later call closed.

import type { CatalogueImport, HybridRow, ScoredId } from "./catalogueDb";
import type { StorePersistence } from "./vectorStoreOwnership";

/** The async catalogue surface the search engine uses. */
export interface CatalogueStore {
	replace(revision: CatalogueImport): Promise<void>;
	hybrid(
		query: string,
		vector: Float32Array,
		k: number,
	): Promise<ReadonlyArray<HybridRow>>;
	vectorSearch(
		vector: Float32Array,
		k: number,
	): Promise<ReadonlyArray<ScoredId>>;
	nearest(id: string, k: number): Promise<ReadonlyArray<ScoredId>>;
	dispose(): Promise<void>;
}

export interface CatalogueStoreOptions {
	readonly dimension: number;
}

/** Opens a CatalogueStore (production: a Worker; tests: Node in-process). */
export type CatalogueStoreFactory = (
	options: CatalogueStoreOptions,
) => Promise<CatalogueStore>;

export type CatalogueRequest =
	| {
			readonly operation: "open";
			readonly dimension: number;
			readonly persistence: StorePersistence;
	  }
	| { readonly operation: "replace"; readonly revision: CatalogueImport }
	| {
			readonly operation: "hybrid";
			readonly query: string;
			readonly vector: Float32Array;
			readonly k: number;
	  }
	| {
			readonly operation: "vectorSearch";
			readonly vector: Float32Array;
			readonly k: number;
	  }
	| {
			readonly operation: "nearest";
			readonly productId: string;
			readonly k: number;
	  }
	| { readonly operation: "dispose" };

export type CatalogueResponse =
	| { readonly id: number; readonly ok: true; readonly value: unknown }
	| {
			readonly id: number;
			readonly ok: false;
			readonly error: { readonly name: string; readonly message: string };
	  };

/** The Worker surface the client needs (a test seam). */
export interface CatalogueWorkerLike {
	postMessage(message: CatalogueRequest & { readonly id: number }): void;
	terminate(): void;
	addEventListener(
		type: "message",
		listener: (event: MessageEvent<CatalogueResponse>) => void,
	): void;
	addEventListener(type: "error", listener: (event: ErrorEvent) => void): void;
}

interface Pending {
	readonly resolve: (value: unknown) => void;
	readonly reject: (reason: Error) => void;
}

function remoteError(error: {
	readonly name: string;
	readonly message: string;
}) {
	const wrapped = new Error(error.message);
	wrapped.name = error.name;
	return wrapped;
}

/** RPC client for one catalogue Worker. */
export class CatalogueClient implements CatalogueStore {
	readonly #worker: CatalogueWorkerLike;
	readonly #pending = new Map<number, Pending>();
	#nextId = 1;
	#failure: Error | undefined;

	public constructor(worker: CatalogueWorkerLike) {
		this.#worker = worker;
		worker.addEventListener("message", (event) => this.#settle(event.data));
		worker.addEventListener("error", (event) => {
			this.#fail(new Error(`catalogue worker failed: ${event.message}`));
		});
	}

	/** Spawn-and-open: resolves once the Worker has the database open. */
	public static async open(
		worker: CatalogueWorkerLike,
		dimension: number,
		persistence: StorePersistence,
	): Promise<CatalogueClient> {
		const client = new CatalogueClient(worker);
		try {
			await client.#call({ operation: "open", dimension, persistence });
		} catch (error) {
			worker.terminate();
			throw error;
		}
		return client;
	}

	public async replace(revision: CatalogueImport): Promise<void> {
		await this.#call({ operation: "replace", revision });
	}

	public async hybrid(
		query: string,
		vector: Float32Array,
		k: number,
	): Promise<ReadonlyArray<HybridRow>> {
		return (await this.#call({
			operation: "hybrid",
			query,
			vector,
			k,
		})) as ReadonlyArray<HybridRow>;
	}

	public async vectorSearch(
		vector: Float32Array,
		k: number,
	): Promise<ReadonlyArray<ScoredId>> {
		return (await this.#call({
			operation: "vectorSearch",
			vector,
			k,
		})) as ReadonlyArray<ScoredId>;
	}

	public async nearest(
		id: string,
		k: number,
	): Promise<ReadonlyArray<ScoredId>> {
		return (await this.#call({
			operation: "nearest",
			productId: id,
			k,
		})) as ReadonlyArray<ScoredId>;
	}

	public async dispose(): Promise<void> {
		if (this.#failure !== undefined) {
			return;
		}
		try {
			await this.#call({ operation: "dispose" });
		} finally {
			this.#fail(new Error("catalogue is disposed"));
			this.#worker.terminate();
		}
	}

	#call(request: CatalogueRequest): Promise<unknown> {
		if (this.#failure !== undefined) {
			return Promise.reject(this.#failure);
		}
		const id = this.#nextId++;
		return new Promise((resolve, reject) => {
			this.#pending.set(id, { resolve, reject });
			this.#worker.postMessage({ ...request, id });
		});
	}

	#settle(response: CatalogueResponse): void {
		const pending = this.#pending.get(response.id);
		if (pending === undefined) {
			return;
		}
		this.#pending.delete(response.id);
		if (response.ok) {
			pending.resolve(response.value);
		} else {
			pending.reject(remoteError(response.error));
		}
	}

	#fail(error: Error): void {
		this.#failure ??= error;
		for (const pending of this.#pending.values()) {
			pending.reject(error);
		}
		this.#pending.clear();
	}
}
