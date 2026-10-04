// @vitest-environment node
import { describe, expect, it } from "vitest";
import { openNodeDatabase } from "./__fixtures__/nodeCatalogue";
import {
	CatalogueClient,
	type CatalogueRequest,
	type CatalogueResponse,
	type CatalogueWorkerLike,
} from "./catalogueClient";
import { CatalogueDb } from "./catalogueDb";

type Listener = (event: { data?: unknown; message?: string }) => void;

/** A Worker stand-in that answers like catalogueWorker.ts, asynchronously. */
class FakeWorker {
	readonly listeners = new Map<string, Listener[]>();
	readonly posted: Array<CatalogueRequest & { id: number }> = [];
	terminated = false;
	silent = false;
	#db: CatalogueDb | undefined;

	public addEventListener(type: string, listener: Listener): void {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
	}

	public postMessage(message: CatalogueRequest & { id: number }): void {
		this.posted.push(message);
		if (!this.silent) {
			void this.#answer(message);
		}
	}

	public terminate(): void {
		this.terminated = true;
	}

	public emit(type: string, event: { data?: unknown; message?: string }) {
		for (const listener of this.listeners.get(type) ?? []) {
			listener(event);
		}
	}

	async #answer(request: CatalogueRequest & { id: number }): Promise<void> {
		let response: CatalogueResponse;
		try {
			response = { id: request.id, ok: true, value: await this.#run(request) };
		} catch (error) {
			const e = error as Error;
			response = {
				id: request.id,
				ok: false,
				error: { name: e.name, message: e.message },
			};
		}
		this.emit("message", { data: response });
	}

	async #run(request: CatalogueRequest): Promise<unknown> {
		switch (request.operation) {
			case "open":
				if (request.dimension < 1) {
					throw new RangeError("bad dimension");
				}
				this.#db = new CatalogueDb(await openNodeDatabase(), request.dimension);
				return undefined;
			case "replace":
				return this.#db?.replace(request.revision);
			case "hybrid":
				return this.#db?.hybrid(request.query, request.vector, request.k);
			case "vectorSearch":
				return this.#db?.vectorSearch(request.vector, request.k);
			case "nearest":
				return this.#db?.nearest(request.productId, request.k);
			case "dispose":
				this.#db?.close();
				return undefined;
		}
	}
}

function asWorker(worker: FakeWorker): CatalogueWorkerLike {
	return worker as unknown as CatalogueWorkerLike;
}

const REVISION = {
	products: [
		{ id: "a", title: "red polo", category: "", tags: [], brand: "" },
		{ id: "b", title: "blue shirt", category: "", tags: [], brand: "" },
	],
	vectors: new Float32Array([1, 0, 0, 1]),
};

async function opened(): Promise<{
	worker: FakeWorker;
	client: CatalogueClient;
}> {
	const worker = new FakeWorker();
	const client = await CatalogueClient.open(asWorker(worker), 2, "memory");
	await client.replace(REVISION);
	return { worker, client };
}

describe("CatalogueClient", () => {
	it("opens the Worker with the dimension and persistence the lease chose", async () => {
		const { worker } = await opened();
		expect(worker.posted[0]).toEqual({
			operation: "open",
			dimension: 2,
			persistence: "memory",
			id: 1,
		});
	});

	it("answers every catalogue operation through the Worker", async () => {
		const { client } = await opened();
		const fused = await client.hybrid("polo", new Float32Array([1, 0]), 2);
		expect(fused[0]).toMatchObject({
			id: "a",
			lexicalRank: 1,
			semanticRank: 1,
		});
		const near = await client.vectorSearch(new Float32Array([0, 1]), 1);
		expect(near.map((hit) => hit.id)).toEqual(["b"]);
		const neighbours = await client.nearest("a", 1);
		expect(neighbours.map((hit) => hit.id)).toEqual(["b"]);
	});

	it("rethrows a Worker-side failure with its name and message", async () => {
		const { client } = await opened();
		await expect(client.nearest("zzz", 1)).rejects.toMatchObject({
			name: "Error",
			message: "unknown product id: zzz",
		});
	});

	it("terminates the Worker when the database cannot open", async () => {
		const worker = new FakeWorker();
		await expect(
			CatalogueClient.open(asWorker(worker), 0, "opfs"),
		).rejects.toMatchObject({
			name: "RangeError",
			message: "bad dimension",
		});
		expect(worker.terminated).toBe(true);
	});

	it("fails pending and later calls closed when the Worker crashes", async () => {
		const { worker, client } = await opened();
		worker.silent = true;
		const pending = client.vectorSearch(new Float32Array([1, 0]), 1);
		worker.emit("error", { message: "out of memory" });
		await expect(pending).rejects.toThrow(
			"catalogue worker failed: out of memory",
		);
		await expect(client.nearest("a", 1)).rejects.toThrow(/out of memory/);
	});

	it("ignores a response for a request it never sent", async () => {
		const { worker, client } = await opened();
		worker.emit("message", { data: { id: 999, ok: true, value: "stray" } });
		const hits = await client.vectorSearch(new Float32Array([1, 0]), 1);
		expect(hits.map((hit) => hit.id)).toEqual(["a"]);
	});

	it("disposes once: closes the database, terminates, then refuses work", async () => {
		const { worker, client } = await opened();
		await client.dispose();
		await client.dispose();
		expect(worker.terminated).toBe(true);
		expect(worker.posted.filter((m) => m.operation === "dispose")).toHaveLength(
			1,
		);
		await expect(
			client.vectorSearch(new Float32Array([1, 0]), 1),
		).rejects.toThrow("catalogue is disposed");
	});
});
