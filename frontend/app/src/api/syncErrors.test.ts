import { type EngineErrorCode, EngineOperationError } from "@gainratio/browser";
import { starterPack } from "@gainratio/errors";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	bootErrorMessage,
	bootFailure,
	bundleErrorRegistry,
} from "./syncErrors";

/**
 * A faithful stand-in for a bundle-sync failure: the in-browser engine sets a
 * stable `.name` on each thrown class — `NetworkError` (fetchBytes.ts),
 * `IntegrityError` (integrity.ts), `SignatureError` (crypto.ts),
 * `WorkerTimeoutError` / `WorkerCrashError` (workerFault.ts). Classification
 * reads `.name` (duck-typed via the library's `errorNameOf`), so a name-tagged
 * Error exercises the exact runtime contract without importing the engine graph.
 */
function engineError(name: string, message: string): Error {
	const err = new Error(message);
	err.name = name;
	return err;
}

describe("@gainratio/errors adoption — bundleErrorRegistry", () => {
	// Proves (1) the published library is really what does the work —
	// `bundleErrorRegistry` is a genuine @gainratio/errors Registry built from its
	// `starterPack` codes; and (2) each engine error still maps to a canonical
	// code, so the classification vocabulary is the shared portfolio one.

	it("is a genuine @gainratio/errors Registry built from the published starterPack", () => {
		for (const method of [
			"classify",
			"describe",
			"toProblemDetails",
			"create",
		] as const) {
			expect(
				typeof (bundleErrorRegistry as unknown as Record<string, unknown>)[
					method
				],
			).toBe("function");
		}
		// The reused codes ARE the published starter-pack codes, carrying the
		// library's own default English (impossible to satisfy from local-only
		// logic).
		const reused = [
			"bundle.download_failed",
			"bundle.integrity_failed",
			"bundle.device_unsupported",
			"bundle.timeout",
			"bundle.quota_exceeded",
			"net.unreachable",
			"internal.unknown",
		] as const;
		const pack = starterPack as Record<string, { en?: string }>;
		for (const code of reused) {
			expect(bundleErrorRegistry.has(code)).toBe(true);
			expect(Object.keys(starterPack)).toContain(code);
			expect(bundleErrorRegistry.get(code)?.en).toBe(pack[code]?.en);
		}
	});

	it("classifies each engine error name into the reused canonical code", () => {
		const code = (raw: unknown) => bundleErrorRegistry.classify(raw);
		expect(code(engineError("NetworkError", "origin unreachable"))).toBe(
			"bundle.download_failed",
		);
		expect(
			code(
				engineError(
					"IntegrityError",
					"manifest 9f3a failed content-address check",
				),
			),
		).toBe("bundle.integrity_failed");
		expect(code(engineError("SignatureError", "bad ed25519 signature"))).toBe(
			"bundle.integrity_failed",
		);
		expect(
			code(engineError("WorkerTimeoutError", "embedder worker timed out")),
		).toBe("bundle.timeout");
		expect(code(engineError("WorkerCrashError", "worker crashed"))).toBe(
			"bundle.device_unsupported",
		);
		// A raw fetch TypeError with no status + a network message → net.unreachable
		// (the starterPack's own message-based match, unchanged).
		expect(code(engineError("TypeError", "Failed to fetch"))).toBe(
			"net.unreachable",
		);
		// Anything unrecognized falls back to internal.unknown.
		expect(code(engineError("Error", "boom"))).toBe("internal.unknown");
		expect(code("weird string")).toBe("internal.unknown");
	});
});

/**
 * A faithful stand-in for a failure that crossed the sync Worker boundary. The
 * Worker classifies its own throw (`classifyEngineError`) and the main-thread
 * `EngineClient` rethrows it as `EngineOperationError` — `.name` is ALWAYS
 * "EngineOperationError"; the failure category lives only in the stable `.code`.
 * The real class is used so the test tracks the published contract.
 */
function workerError(code: EngineErrorCode, message: string): Error {
	return new EngineOperationError({ code, message });
}

describe("Worker-boundary errors — classified by EngineOperationError.code", () => {
	const code = (raw: unknown) => bundleErrorRegistry.classify(raw);

	it("maps every engine code to its canonical app code", () => {
		const cases: Record<EngineErrorCode, string> = {
			integrity: "bundle.integrity_failed",
			rollback: "bundle.integrity_failed",
			network: "bundle.download_failed",
			lock: "bundle.timeout",
			storage: "bundle.device_unsupported",
			internal: "internal.unknown",
		};
		for (const [engineCode, expected] of Object.entries(cases)) {
			expect(
				code(workerError(engineCode as EngineErrorCode, "worker failure")),
				engineCode,
			).toBe(expected);
		}
	});

	it("classifies a real Worker signature/revoked/expired/rollback failure as an integrity failure", () => {
		// These are the security-relevant fail-closed throws inside the Worker;
		// all of them arrive as code integrity|rollback, never by their own name.
		for (const [c, message] of [
			["integrity", "pointer signature verification failed"],
			["integrity", "signing key k1 is revoked"],
			["integrity", "version pointer expired"],
			["integrity", "manifest 9f3a failed content-address check"],
			["rollback", "pointer version 3 is older than the pinned floor 4"],
		] as const) {
			expect(code(workerError(c, message))).toBe("bundle.integrity_failed");
		}
	});

	it("never downgrades an integrity failure to a retryable network error", () => {
		// A message that the starter pack's message-based matcher would read as
		// "offline" must not outrank the Worker's integrity/rollback code.
		for (const c of ["integrity", "rollback"] as const) {
			expect(code(workerError(c, "Failed to fetch: network error"))).toBe(
				"bundle.integrity_failed",
			);
		}
	});

	it("reads a quota-exhausted storage failure as bundle.quota_exceeded", () => {
		expect(
			code(workerError("storage", "browser storage quota exhausted")),
		).toBe("bundle.quota_exceeded");
	});

	it("fails safe: an internal or unknown Worker code is internal.unknown, never network", () => {
		expect(code(workerError("internal", "Failed to fetch"))).toBe(
			"internal.unknown",
		);
		const future = new EngineOperationError({
			code: "integrity",
			message: "Failed to fetch",
		});
		(future as unknown as { code: string }).code = "some_future_code";
		expect(code(future)).toBe("internal.unknown");
		// A code-less object merely named EngineOperationError is not trusted.
		expect(
			code({ name: "EngineOperationError", message: "network down" }),
		).toBe("internal.unknown");
	});
});

describe("in-thread engine errors — the subclass names also classify", () => {
	const code = (raw: unknown) => bundleErrorRegistry.classify(raw);

	it("maps every IntegrityError/SignatureError subclass name to integrity", () => {
		for (const name of [
			"RollbackError",
			"PointerExpiredError",
			"SyncCapError",
			"ResponseTooLargeError",
			"KeyringError",
			"KeyRevokedError",
			"UnknownKeyError",
		]) {
			expect(code(engineError(name, "Failed to fetch")), name).toBe(
				"bundle.integrity_failed",
			);
		}
	});

	it("maps StorageQuotaError to bundle.quota_exceeded", () => {
		expect(
			code(engineError("StorageQuotaError", "browser storage quota exhausted")),
		).toBe("bundle.quota_exceeded");
	});
});

describe("bootErrorMessage — behaviour-identical display", () => {
	// The BootScreen has always shown the engine's own message verbatim (App's
	// old `errorMessage` helper). Adoption must not change one on-screen byte: the
	// surfaced string stays the raw message; the non-Error fallback stays
	// "Unexpected error". Only a dev-facing coded console breadcrumb is new.
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns the raw Error message verbatim (unchanged from pre-adoption)", () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		expect(
			bootErrorMessage(engineError("NetworkError", "origin unreachable")),
		).toBe("origin unreachable");
		expect(
			bootErrorMessage(
				engineError(
					"IntegrityError",
					"manifest 9f3a failed content-address check",
				),
			),
		).toBe("manifest 9f3a failed content-address check");
		expect(bootErrorMessage(new Error("origin unreachable"))).toBe(
			"origin unreachable",
		);
	});

	it("falls back to 'Unexpected error' for a non-Error (unchanged)", () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		expect(bootErrorMessage("weird")).toBe("Unexpected error");
		expect(bootErrorMessage(undefined)).toBe("Unexpected error");
	});

	it("routes through the registry, logging the canonical code for support", () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		bootErrorMessage(
			engineError("IntegrityError", "manifest 9f3a failed check"),
		);
		expect(spy).toHaveBeenCalledWith(
			"[edge-reco:bundle.integrity_failed]",
			expect.any(Error),
		);
	});

	it("logs integrity for a Worker-boundary failure and still shows its message verbatim", () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		const err = new EngineOperationError({
			code: "integrity",
			message: "pointer signature verification failed",
		});
		expect(bootErrorMessage(err)).toBe("pointer signature verification failed");
		expect(spy).toHaveBeenCalledWith(
			"[edge-reco:bundle.integrity_failed]",
			err,
		);
	});
});

describe("bootFailure — which failures offer the manual catalog-cache clear", () => {
	// A returning shopper whose durable rollback floor / cached pointer can no
	// longer be satisfied (a republish with a lower sequence, a new signing key,
	// a changed bundle_id/channel) hits the SAME integrity refusal on every
	// Retry. Only that class gets the explicit "clear cached catalog" action:
	// every other failure keeps Retry alone, because wiping the verified offline
	// copy would not fix a network/lock/device problem and would cost the shopper
	// their offline catalog.
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("offers the clear for every integrity-class refusal, Worker or in-thread", () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const refusals: unknown[] = [
			new EngineOperationError({ code: "rollback", message: "sequence 3 < 5" }),
			new EngineOperationError({ code: "integrity", message: "bad sig" }),
			engineError("RollbackError", "sequence 3 < 5"),
			engineError("SignatureError", "bad sig"),
			engineError("IntegrityError", "bundle identity mismatch"),
			engineError("UnknownKeyError", "unknown key"),
		];
		for (const raw of refusals) {
			expect(bootFailure(raw)).toMatchObject({
				code: "bundle.integrity_failed",
				offerCacheClear: true,
			});
		}
	});

	it("keeps Retry alone for network, lock, storage, device and unknown failures", () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const others: unknown[] = [
			new EngineOperationError({ code: "network", message: "HTTP 503" }),
			new EngineOperationError({ code: "lock", message: "lock" }),
			new EngineOperationError({ code: "storage", message: "QuotaExceeded" }),
			new EngineOperationError({ code: "storage", message: "no OPFS" }),
			new EngineOperationError({ code: "internal", message: "boom" }),
			engineError("NetworkError", "origin unreachable"),
			engineError("WorkerTimeoutError", "idle"),
			new TypeError("Failed to fetch"),
			"weird",
		];
		for (const raw of others) {
			expect(bootFailure(raw).offerCacheClear).toBe(false);
		}
	});

	it("files an on-device search-index open failure as a local storage problem, not integrity", () => {
		// Regression: another tab holding the OPFS vector database was shown as a
		// "malformed catalog bundle" — security-meaning copy for a local fault.
		vi.spyOn(console, "error").mockImplementation(() => {});
		const raw = engineError(
			"VectorStoreUnavailableError",
			"could not open the on-device search index: OPFS unavailable",
		);
		expect(bootFailure(raw)).toMatchObject({
			code: "bundle.device_unsupported",
			offerCacheClear: false,
			confirmCacheClear: false,
		});
	});

	it("carries the verbatim message and logs the same coded breadcrumb as bootErrorMessage", () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		const err = new EngineOperationError({
			code: "rollback",
			message: "pointer sequence 3 is below the stored floor 5",
		});
		expect(bootFailure(err).message).toBe(
			"pointer sequence 3 is below the stored floor 5",
		);
		expect(bootFailure("weird").message).toBe("Unexpected error");
		expect(spy).toHaveBeenCalledWith(
			"[edge-reco:bundle.integrity_failed]",
			err,
		);
	});
});

describe("bootFailure — a rollback refusal needs a warning and a two-step confirm", () => {
	// Threat: an attacker who can serve an older-but-validly-signed `latest`
	// (but not the app's JavaScript) triggers a RollbackError. A one-click clear
	// would walk the shopper into wiping the rollback floor, after which that old
	// bundle is accepted at first-install trust. So a rollback carries its engine
	// code to the screen and the clear demands explicit confirmation.
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("carries the Worker's EngineOperationError.code through to the screen", () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		for (const code of [
			"integrity",
			"rollback",
			"network",
			"lock",
			"storage",
			"internal",
		] as const) {
			expect(
				bootFailure(new EngineOperationError({ code, message: "x" }))
					.engineCode,
			).toBe(code);
		}
		// An in-thread RollbackError carries the same category by name.
		expect(bootFailure(engineError("RollbackError", "x")).engineCode).toBe(
			"rollback",
		);
		// Unknown/foreign shapes carry none.
		expect(bootFailure(new TypeError("Failed to fetch")).engineCode).toBe(null);
		expect(
			bootFailure({ name: "EngineOperationError", code: "bogus" }).engineCode,
		).toBe(null);
	});

	it("requires confirmation for a rollback, Worker or in-thread", () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		for (const raw of [
			new EngineOperationError({ code: "rollback", message: "3 < 5" }),
			engineError("RollbackError", "3 < 5"),
		]) {
			expect(bootFailure(raw)).toMatchObject({
				offerCacheClear: true,
				confirmCacheClear: true,
			});
		}
	});

	it("keeps the single-click clear for other integrity refusals", () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		for (const raw of [
			new EngineOperationError({ code: "integrity", message: "bad sig" }),
			engineError("SignatureError", "bad sig"),
			engineError("IntegrityError", "bundle identity mismatch"),
		]) {
			expect(bootFailure(raw)).toMatchObject({
				offerCacheClear: true,
				confirmCacheClear: false,
			});
		}
	});

	it("never asks to confirm a clear it does not offer", () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		expect(
			bootFailure(new EngineOperationError({ code: "network", message: "x" })),
		).toMatchObject({ offerCacheClear: false, confirmCacheClear: false });
	});
});
