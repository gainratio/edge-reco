// WorkerEmbedder failure semantics: an embedder Worker that crashes during
// model load (the classic init failure) must REJECT pending embeds with a
// typed error — never hang — bounded by a per-request deadline backstop.

import { WorkerCrashError, WorkerTimeoutError } from "@gainratio/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkerEmbedder, type WorkerLike } from "./embedderClient";
import type { EmbedRequest, EmbedResponse } from "./embedderWorker";

type AnyListener = (event: unknown) => void;

/** In-memory embedder-Worker double: records posts, lets tests emit events. */
class FakeEmbedderWorker implements WorkerLike {
	public readonly posted: EmbedRequest[] = [];
	public terminated = false;
	readonly #listeners = new Map<string, AnyListener[]>();

	public postMessage(message: EmbedRequest): void {
		this.posted.push(message);
	}

	public addEventListener(
		type: "message",
		listener: (event: MessageEvent<EmbedResponse>) => void,
	): void;
	public addEventListener(
		type: "error",
		listener: (event: ErrorEvent) => void,
	): void;
	public addEventListener(
		type: "messageerror",
		listener: (event: MessageEvent) => void,
	): void;
	public addEventListener(type: string, listener: unknown): void {
		const existing = this.#listeners.get(type) ?? [];
		existing.push(listener as AnyListener);
		this.#listeners.set(type, existing);
	}

	public emitMessage(response: EmbedResponse): void {
		for (const listener of this.#listeners.get("message") ?? []) {
			listener({ data: response });
		}
	}

	public emitError(message: string): void {
		for (const listener of this.#listeners.get("error") ?? []) {
			listener({ message });
		}
	}

	public emitMessageError(): void {
		for (const listener of this.#listeners.get("messageerror") ?? []) {
			listener({ data: null });
		}
	}

	public terminate(): void {
		this.terminated = true;
	}
}

afterEach(() => {
	vi.useRealTimers();
});

describe("WorkerEmbedder worker-crash rejection (no hang)", () => {
	it("rejects a pending embed with WorkerCrashError when the worker errors during model load", async () => {
		const worker = new FakeEmbedderWorker();
		const embedder = createWorkerEmbedder(worker);

		const pending = embedder.embed("desk lamp");
		const assertion = expect(pending).rejects.toBeInstanceOf(WorkerCrashError);
		worker.emitError("model download failed");
		await assertion;
	});

	it("rejects a pending embed with WorkerCrashError on 'messageerror'", async () => {
		// A worker reply that fails structured-clone deserialization fires
		// 'messageerror' and never delivers a usable message. Without a listener the
		// embed would hang to the 300s deadline; parity with EngineClient rejects fast.
		const worker = new FakeEmbedderWorker();
		const embedder = createWorkerEmbedder(worker);

		const pending = embedder.embed("desk lamp");
		const assertion = expect(pending).rejects.toBeInstanceOf(WorkerCrashError);
		worker.emitMessageError();
		await assertion;
	});

	it("rejects embeds issued AFTER a crash immediately (fail-fast latch)", async () => {
		const worker = new FakeEmbedderWorker();
		const embedder = createWorkerEmbedder(worker);
		worker.emitError("model download failed");

		await expect(embedder.embed("desk lamp")).rejects.toBeInstanceOf(
			WorkerCrashError,
		);
		expect(worker.posted).toHaveLength(0);
	});
});

describe("WorkerEmbedder bounded response deadline (backstop)", () => {
	it("rejects with WorkerTimeoutError when an embed outlives its deadline", async () => {
		vi.useFakeTimers();
		const worker = new FakeEmbedderWorker();
		const embedder = createWorkerEmbedder(worker, { requestTimeoutMs: 10_000 });

		const pending = embedder.embed("desk lamp");
		const assertion =
			expect(pending).rejects.toBeInstanceOf(WorkerTimeoutError);
		vi.advanceTimersByTime(10_000);
		await assertion;
	});

	it("a vector reply before the deadline resolves normally", async () => {
		vi.useFakeTimers();
		const worker = new FakeEmbedderWorker();
		const embedder = createWorkerEmbedder(worker, { requestTimeoutMs: 10_000 });

		const pending = embedder.embed("desk lamp");
		const id = worker.posted[0]?.id ?? -1;
		const vector = new Float32Array([0.1, 0.2]);
		worker.emitMessage({ ok: true, id, vector });
		await expect(pending).resolves.toEqual(vector);

		// the cleared deadline must not fire anything afterwards
		vi.advanceTimersByTime(60_000);
	});
});

describe("WorkerEmbedder disposal", () => {
	it("rejects pending embeds and terminates its worker", async () => {
		const worker = new FakeEmbedderWorker();
		const embedder = createWorkerEmbedder(worker);
		const pending = embedder.embed("desk lamp");
		const assertion = expect(pending).rejects.toBeInstanceOf(WorkerCrashError);

		embedder.dispose?.();

		await assertion;
		expect(worker.terminated).toBe(true);
	});
});
