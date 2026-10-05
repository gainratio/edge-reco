// "Reset taste" across tabs.
//
// OPFS lets ONE tab own the shopper's user database at a time; other tabs run
// on in-memory copies (TasteStore.ownership === "secondary"). Clearing only the
// in-memory copy would report success while the durable rows survive. So a
// secondary tab routes the reset to the owner over a BroadcastChannel and waits
// for the owner to wipe AND verify. No answer, or a failed wipe, is an error the
// shopper sees — never a silent success.
//
//   secondary --reset-request(id)--> owner     owner wipes + verifies
//   secondary <--reset-result(id,ok)-- owner
//   owner --reset-done--> every tab            secondaries drop their copies

import type { TasteStore } from "@edgereco/browser";

export type ResetMessage =
	| { readonly kind: "reset-request"; readonly id: string }
	| {
			readonly kind: "reset-result";
			readonly id: string;
			readonly ok: boolean;
			readonly error?: string;
	  }
	| { readonly kind: "reset-done" };

/** The slice of BroadcastChannel this uses; tests pass an in-memory bus. */
export interface ResetBus {
	post(message: ResetMessage): void;
	subscribe(callback: (message: ResetMessage) => void): () => void;
}

/** The secondary tab could not get the owner tab to clear the saved data. */
export class OwnerUnreachableError extends Error {
	public constructor() {
		super(
			"Couldn’t clear your saved activity: another tab of this store holds it and didn’t respond. Close the other tabs and try again.",
		);
		this.name = "OwnerUnreachableError";
	}
}

const CHANNEL = "edgereco-user-data";
export const OWNER_REPLY_TIMEOUT_MS = 5_000;

/** The production bus, or null where BroadcastChannel is missing. */
export function broadcastBus(): ResetBus | null {
	if (typeof BroadcastChannel === "undefined") {
		return null;
	}
	const channel = new BroadcastChannel(CHANNEL);
	return {
		post: (message) => channel.postMessage(message),
		subscribe: (callback) => {
			const listener = (event: MessageEvent<ResetMessage>): void =>
				callback(event.data);
			channel.addEventListener("message", listener);
			return () => channel.removeEventListener("message", listener);
		},
	};
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class ResetCoordinator {
	readonly #bus: ResetBus | null;
	readonly #store: TasteStore;
	readonly #wipe: () => Promise<void>;
	readonly #timeoutMs: number;
	readonly #waiting = new Map<string, (m: ResetMessage) => void>();
	readonly #unsubscribe: () => void;

	/** `wipe` is the full local wipe (table + legacy leftovers), verified. */
	public constructor(
		bus: ResetBus | null,
		store: TasteStore,
		wipe: () => Promise<void>,
		timeoutMs: number = OWNER_REPLY_TIMEOUT_MS,
	) {
		this.#bus = bus;
		this.#store = store;
		this.#wipe = wipe;
		this.#timeoutMs = timeoutMs;
		this.#unsubscribe = bus?.subscribe((m) => this.#onMessage(m)) ?? (() => {});
	}

	/** The user-visible reset for this tab. Resolves only when verified. */
	public async reset(): Promise<void> {
		if (this.#store.ownership !== "secondary") {
			await this.#wipe();
			this.#bus?.post({ kind: "reset-done" });
			return;
		}
		await this.#store.clear();
		await this.#askOwner();
	}

	public dispose(): void {
		this.#unsubscribe();
	}

	#askOwner(): Promise<void> {
		const bus = this.#bus;
		if (bus === null) {
			return Promise.reject(new OwnerUnreachableError());
		}
		const id = crypto.randomUUID();
		return new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#waiting.delete(id);
				reject(new OwnerUnreachableError());
			}, this.#timeoutMs);
			this.#waiting.set(id, (reply) => {
				clearTimeout(timer);
				this.#waiting.delete(id);
				if (reply.kind === "reset-result" && reply.ok) {
					resolve();
				} else {
					const why = reply.kind === "reset-result" ? reply.error : "";
					reject(new Error(`Couldn’t clear your saved activity: ${why}`));
				}
			});
			bus.post({ kind: "reset-request", id });
		});
	}

	#onMessage(message: ResetMessage): void {
		if (message.kind === "reset-result") {
			this.#waiting.get(message.id)?.(message);
		} else if (message.kind === "reset-request") {
			if (this.#store.ownership === "owner") {
				void this.#answer(message.id);
			}
		} else if (this.#store.ownership === "secondary") {
			// The owner wiped; drop this tab's in-memory copy too (best effort).
			this.#store.clear().catch((error: unknown) => {
				console.warn("[edge-reco] could not drop this tab's copy", error);
			});
		}
	}

	async #answer(id: string): Promise<void> {
		try {
			await this.#wipe();
			this.#bus?.post({ kind: "reset-result", id, ok: true });
			this.#bus?.post({ kind: "reset-done" });
		} catch (error) {
			this.#bus?.post({
				kind: "reset-result",
				id,
				ok: false,
				error: errorText(error),
			});
		}
	}
}
