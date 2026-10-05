// Reset across tabs. OPFS gives ONE tab the durable user database; other tabs
// run on in-memory copies. A reset clicked in a secondary tab must reach the
// owner and be verified there, or fail visibly. Two "tabs" here share an
// in-memory bus that behaves like BroadcastChannel (no self-delivery, async).

import type { TasteStore } from "@edgereco/browser";
import { sharedUserDb } from "@edgereco/browser/testing/sharedUserDb";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	broadcastBus,
	OwnerUnreachableError,
	type ResetBus,
	ResetCoordinator,
	type ResetMessage,
} from "./resetCoordinator";

/** A BroadcastChannel stand-in: every bus sees the others' posts, not its own. */
function busNetwork(): () => ResetBus {
	const members = new Set<(m: ResetMessage) => void>();
	return () => {
		let mine: ((m: ResetMessage) => void) | null = null;
		return {
			post: (message) => {
				for (const deliver of members) {
					if (deliver !== mine) {
						queueMicrotask(() => deliver(structuredClone(message)));
					}
				}
			},
			subscribe: (callback) => {
				mine = callback;
				members.add(callback);
				return () => members.delete(callback);
			},
		};
	};
}

const event = { ts: "t", type: "click", productId: "P1" } as const;

async function tab(storage: "owner" | "secondary" | "volatile"): Promise<{
	store: TasteStore;
	wipes: string[];
}> {
	const store = await (await sharedUserDb(storage)).open();
	return { store, wipes: [] };
}

function coordinator(
	bus: ResetBus | null,
	t: { store: TasteStore; wipes: string[] },
	timeoutMs = 200,
): ResetCoordinator {
	return new ResetCoordinator(
		bus,
		t.store,
		async () => {
			t.wipes.push("owner-wipe");
			await t.store.clear();
		},
		timeoutMs,
	);
}

describe("ResetCoordinator", () => {
	it("a reset in the secondary tab clears the OWNER's durable rows", async () => {
		const join = busNetwork();
		const owner = await tab("owner");
		const second = await tab("secondary");
		await owner.store.append(event);
		await second.store.append(event);
		coordinator(join(), owner);
		await coordinator(join(), second).reset();
		expect(await owner.store.count()).toBe(0);
		expect(await second.store.count()).toBe(0);
		expect(owner.wipes).toEqual(["owner-wipe"]);
	});

	it("fails visibly when no owner answers", async () => {
		const join = busNetwork();
		const second = await tab("secondary");
		await expect(
			coordinator(join(), second, 50).reset(),
		).rejects.toBeInstanceOf(OwnerUnreachableError);
	});

	it("fails visibly when the owner's wipe fails", async () => {
		const join = busNetwork();
		const owner = await tab("owner");
		new ResetCoordinator(
			join(),
			owner.store,
			() => Promise.reject(new Error("disk full")),
			200,
		);
		const second = await tab("secondary");
		await expect(coordinator(join(), second).reset()).rejects.toThrow(
			/disk full/,
		);
	});

	it("fails visibly when the secondary has no channel at all", async () => {
		const second = await tab("secondary");
		await expect(coordinator(null, second).reset()).rejects.toBeInstanceOf(
			OwnerUnreachableError,
		);
	});

	it("an owner reset wipes locally and tells secondaries to drop their copies", async () => {
		const join = busNetwork();
		const owner = await tab("owner");
		const second = await tab("secondary");
		await owner.store.append(event);
		await second.store.append(event);
		coordinator(join(), second);
		await coordinator(join(), owner).reset();
		expect(await owner.store.count()).toBe(0);
		await expect.poll(() => second.store.count()).toBe(0);
	});

	it("a volatile tab (no OPFS anywhere) just wipes locally", async () => {
		const solo = await tab("volatile");
		await solo.store.append(event);
		await coordinator(null, solo).reset();
		expect(solo.wipes).toEqual(["owner-wipe"]);
		expect(await solo.store.count()).toBe(0);
	});

	it("an owner propagates its own wipe failure", async () => {
		const owner = await tab("owner");
		const failing = new ResetCoordinator(
			null,
			owner.store,
			() => Promise.reject(new Error("locked")),
			50,
		);
		await expect(failing.reset()).rejects.toThrow(/locked/);
	});

	it("ignores replies meant for another request, and stops listening on dispose", async () => {
		const join = busNetwork();
		const owner = await tab("owner");
		const ownerSide = coordinator(join(), owner);
		const stray = join();
		stray.subscribe(() => {});
		stray.post({ kind: "reset-result", id: "someone-else", ok: true });
		const second = await tab("secondary");
		await coordinator(join(), second).reset();
		ownerSide.dispose();
		await expect(
			coordinator(join(), await tab("secondary"), 50).reset(),
		).rejects.toBeInstanceOf(OwnerUnreachableError);
	});
});

describe("broadcastBus", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("is null where BroadcastChannel does not exist", () => {
		vi.stubGlobal("BroadcastChannel", undefined);
		expect(broadcastBus()).toBeNull();
	});

	it("delivers between two real channels until unsubscribed", async () => {
		const a = broadcastBus();
		const b = broadcastBus();
		const seen: ResetMessage[] = [];
		const stop = b?.subscribe((m) => seen.push(m));
		a?.post({ kind: "reset-done" });
		await vi.waitFor(() => expect(seen).toEqual([{ kind: "reset-done" }]));
		stop?.();
		a?.post({ kind: "reset-done" });
		await new Promise((r) => setTimeout(r, 20));
		expect(seen).toHaveLength(1);
	});
});

describe("a secondary that cannot drop its own copy", () => {
	it("warns instead of throwing into the message handler", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const network = busNetwork();
		const owner = await tab("owner");
		const secondary = await tab("secondary");
		const failing: TasteStore = {
			...secondary.store,
			ownership: "secondary",
			clear: () => Promise.reject(new Error("locked")),
		};
		coordinator(network(), owner);
		new ResetCoordinator(network(), failing, () => Promise.resolve());
		await coordinator(network(), owner).reset();
		await vi.waitFor(() =>
			expect(warn).toHaveBeenCalledWith(
				"[edge-reco] could not drop this tab's copy",
				expect.any(Error),
			),
		);
		warn.mockRestore();
	});
});
