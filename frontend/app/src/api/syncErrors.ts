/**
 * Bundle-sync error classification — edge-reco's adoption of the portfolio
 * canonical-errors standard ([`@gainratio/errors`](https://www.npmjs.com/package/@gainratio/errors),
 * installed from npm).
 *
 * This module is the ONLY place in the app that names that library. Everything
 * else imports `bootErrorMessage` / `bundleErrorRegistry` from here, so
 * upgrading, swapping, or removing the library is a one-file change.
 *
 * The one user-facing failure the demo can actually hit is the one-time signed
 * catalog-bundle sync. The in-browser engine throws typed errors deep in that
 * pipeline — `NetworkError` (fetchBytes.ts), `IntegrityError` (integrity.ts),
 * `SignatureError` (crypto.ts), `WorkerTimeoutError` / `WorkerCrashError`
 * (workerFault.ts) — which propagate to App's boot `.catch`. A failure inside
 * the sync Worker arrives instead as `EngineOperationError`, whose category
 * survives only in its stable `.code` (integrity · rollback · network · lock ·
 * storage · internal); both shapes are classified here. This module is the
 * single place those raw failures are classified into stable canonical codes,
 * so a failure is loggable/greppable now and serializable to RFC 9457 Problem
 * Details later, in the shared portfolio vocabulary.
 *
 * Behaviour-identical: the BootScreen has always shown the engine's own message
 * verbatim, so `bootErrorMessage` preserves that exact string — no user-visible
 * copy and no i18n keys change. Only the classification vocabulary (and a
 * dev-facing coded console breadcrumb) is new.
 */

import type { EngineErrorCode } from "@gainratio/browser";
import {
	type Catalog,
	defineErrors,
	errorNameOf,
	errorTextOf,
	starterPack,
} from "@gainratio/errors";

/** The canonical codes a sync failure can classify into. */
type BundleCode =
	| "bundle.integrity_failed"
	| "bundle.download_failed"
	| "bundle.timeout"
	| "bundle.device_unsupported"
	| "bundle.quota_exceeded"
	| "internal.unknown";

/**
 * In-thread engine error NAMES → canonical code. Every `IntegrityError` /
 * `SignatureError` subclass carries its own `.name`, so each is listed: a
 * rollback, expired pointer, revoked/unknown key, sync cap, or oversized
 * response is a fail-closed integrity refusal, never a retryable network blip.
 */
const NAME_CODES: Readonly<Record<string, BundleCode>> = {
	IntegrityError: "bundle.integrity_failed",
	SignatureError: "bundle.integrity_failed",
	RollbackError: "bundle.integrity_failed",
	PointerExpiredError: "bundle.integrity_failed",
	SyncCapError: "bundle.integrity_failed",
	ResponseTooLargeError: "bundle.integrity_failed",
	KeyringError: "bundle.integrity_failed",
	KeyRevokedError: "bundle.integrity_failed",
	UnknownKeyError: "bundle.integrity_failed",
	NetworkError: "bundle.download_failed",
	WorkerTimeoutError: "bundle.timeout",
	WorkerCrashError: "bundle.device_unsupported",
	StorageQuotaError: "bundle.quota_exceeded",
	// The on-device vector store could not be opened (vectorIndex.ts). A local
	// storage fault on an already-verified bundle — never an integrity refusal.
	VectorStoreUnavailableError: "bundle.device_unsupported",
};

/**
 * Worker-boundary codes → canonical code. A failure inside the sync Worker is
 * classified there (`classifyEngineError`) and rethrown on the main thread as
 * `EngineOperationError` — whose `.name` is always "EngineOperationError", so
 * the category survives ONLY in `.code`. Typed as a total `Record` over the
 * published `EngineErrorCode` union: a new engine code fails typecheck here
 * until it is deliberately mapped. `storage` is refined by `storageCode`.
 */
const WORKER_CODES: Readonly<Record<EngineErrorCode, BundleCode>> = {
	integrity: "bundle.integrity_failed",
	// A pointer older than the pinned floor — a downgrade attack, fail-closed.
	rollback: "bundle.integrity_failed",
	network: "bundle.download_failed",
	// Timed out acquiring the OPFS mutation lock (another tab holds it).
	lock: "bundle.timeout",
	storage: "bundle.device_unsupported",
	internal: "internal.unknown",
};

/** Mirrors the engine's own quota detection (`isQuotaError`). */
const QUOTA_TEXT = /quota(?:[ _-]?exceeded|[ _-]?reached|[ _-]?exhausted)?/iu;

/** Storage failures split: a quota exhaustion vs. storage the device can't provide. */
function storageCode(raw: unknown): BundleCode {
	return QUOTA_TEXT.test(errorTextOf(raw))
		? "bundle.quota_exceeded"
		: "bundle.device_unsupported";
}

/** True for any failure that crossed the Worker boundary (duck-typed by name). */
function isWorkerError(raw: unknown): boolean {
	return errorNameOf(raw) === "EngineOperationError";
}

/**
 * The canonical code for one raw sync failure, or `undefined` for a failure
 * this module has no engine-specific opinion on (a raw fetch `TypeError`, a
 * string) — which then falls through to the starter pack's generic rules.
 *
 * Fail-safe: a Worker error whose `.code` is missing or unrecognized maps to
 * `internal.unknown` — it is NEVER left to the message-based network matcher,
 * so an integrity refusal can't be downgraded to a retryable network error.
 */
function engineCodeOf(raw: unknown): BundleCode | undefined {
	if (isWorkerError(raw)) {
		const code = (raw as { code?: unknown }).code;
		if (typeof code !== "string" || !Object.hasOwn(WORKER_CODES, code)) {
			return "internal.unknown";
		}
		return code === "storage"
			? storageCode(raw)
			: WORKER_CODES[code as EngineErrorCode];
	}
	const name = errorNameOf(raw);
	return Object.hasOwn(NAME_CODES, name) ? NAME_CODES[name] : undefined;
}

/** A `match` predicate firing when `raw` classifies to exactly `code`. */
function engineMatch(code: BundleCode): (raw: unknown) => boolean {
	return (raw: unknown) => engineCodeOf(raw) === code;
}

const starterUnreachable = starterPack["net.unreachable"].match;

/**
 * edge-reco's bundle-sync catalog, expressed in the shared `@gainratio/errors`
 * vocabulary. Each code is REUSED from the published `starterPack`; on top of
 * the starter data we attach a `match` predicate driven by `engineCodeOf`, so
 * `classify()` reproduces the engine's fail-closed taxonomy for BOTH in-thread
 * errors (by `.name`) and Worker-boundary errors (by `EngineOperationError.code`).
 *
 * Registration ORDER is the precedence (`classify` returns the first code whose
 * `match` fires): every engine-classified failure is matched before the starter
 * pack's generic message-based `net.unreachable` fallback, and that fallback
 * never sees a Worker error at all.
 */
const BUNDLE_ERROR_CATALOG = {
	// Content-address / signature / rollback / expiry / key-revocation failures —
	// the engine's fail-closed integrity refusals.
	"bundle.integrity_failed": {
		...starterPack["bundle.integrity_failed"],
		match: engineMatch("bundle.integrity_failed"),
	},
	// A dead origin or non-ok HTTP status while pulling the pointer, manifest, or
	// a chunk — the engine's `NetworkError` / Worker code `network`.
	"bundle.download_failed": {
		...starterPack["bundle.download_failed"],
		match: engineMatch("bundle.download_failed"),
	},
	// A worker timed out while bootstrapping, or the OPFS mutation lock was held.
	"bundle.timeout": {
		...starterPack["bundle.timeout"],
		match: engineMatch("bundle.timeout"),
	},
	// Browser storage quota exhausted.
	"bundle.quota_exceeded": {
		...starterPack["bundle.quota_exceeded"],
		match: engineMatch("bundle.quota_exceeded"),
	},
	// The worker crashed, or the browser can't provide the storage the engine
	// needs — commonly a device/browser that cannot run the engine at all.
	"bundle.device_unsupported": {
		...starterPack["bundle.device_unsupported"],
		match: engineMatch("bundle.device_unsupported"),
	},
	// A no-status fetch failure (offline) — the starter pack's own message-based
	// match, kept as the generic network fallback for NON-Worker failures only.
	"net.unreachable": {
		...starterPack["net.unreachable"],
		match: (raw: unknown) => !isWorkerError(raw) && starterUnreachable(raw),
	},
	"internal.unknown": starterPack["internal.unknown"],
} satisfies Catalog;

/**
 * edge-reco's bundle-sync error registry — the single place raw engine/transport
 * failures are classified into canonical codes, built with the shared
 * `@gainratio/errors` library. Exported so the classification is inspectable and
 * testable as the library's own `Registry` (and so a server surface can later
 * reuse the same codes for RFC 9457 Problem Details without re-deriving them).
 */
export const bundleErrorRegistry = defineErrors(BUNDLE_ERROR_CATALOG);

/**
 * A classified boot/sync failure: what `BootScreen` renders and which recovery
 * it offers.
 */
export interface BootFailure {
	/** The engine's own message, verbatim (or "Unexpected error"). */
	readonly message: string;
	/** The canonical code (`bundle.integrity_failed`, `net.unreachable`, …). */
	readonly code: string;
	/**
	 * Offer the explicit, user-initiated "Clear cached catalog and retry".
	 *
	 * True ONLY for `bundle.integrity_failed`: the durable rollback floor keeps
	 * the stored pointer even when the current key can't verify it, so after a
	 * republish with a lower `sequence`, a new signing key, or a changed
	 * bundle_id/channel, every Retry hits the same fail-closed refusal. Clearing
	 * the cached catalog is the remedy — and it must stay a manual choice so the
	 * anti-rollback protection is never switched off automatically. Network,
	 * lock, storage and device failures keep Retry alone: wiping the verified
	 * offline copy fixes none of them.
	 */
	readonly offerCacheClear: boolean;
	/**
	 * The engine's own failure category, carried through to the screen: the
	 * Worker's `EngineOperationError.code`, or `"rollback"` for an in-thread
	 * `RollbackError`. `null` when the failure carries no recognised code.
	 */
	readonly engineCode: EngineErrorCode | null;
	/**
	 * The clear must show a tampering warning and an inline two-step confirm.
	 *
	 * True for a rollback refusal: someone able to serve an older but validly
	 * signed `latest` (without serving the app's JavaScript) triggers exactly
	 * this, and a one-click clear would walk the shopper into wiping the floor —
	 * after which that old bundle is accepted at first-install trust. Other
	 * integrity refusals keep the single-click clear.
	 */
	readonly confirmCacheClear: boolean;
}

/** The engine category a raw failure carries, if any (see `BootFailure`). */
function engineCategoryOf(raw: unknown): EngineErrorCode | null {
	if (isWorkerError(raw)) {
		const code = (raw as { code?: unknown }).code;
		return typeof code === "string" && Object.hasOwn(WORKER_CODES, code)
			? (code as EngineErrorCode)
			: null;
	}
	return errorNameOf(raw) === "RollbackError" ? "rollback" : null;
}

/**
 * Classify a boot/sync failure for the BootScreen. Logs the same coded,
 * greppable console breadcrumb `bootErrorMessage` always has — dev-facing,
 * never rendered.
 */
export function bootFailure(err: unknown): BootFailure {
	const code = bundleErrorRegistry.classify(err);
	console.error(`[edge-reco:${code}]`, err);
	const engineCode = engineCategoryOf(err);
	const offerCacheClear = code === "bundle.integrity_failed";
	return {
		message: err instanceof Error ? err.message : "Unexpected error",
		code,
		offerCacheClear,
		engineCode,
		confirmCacheClear: offerCacheClear && engineCode === "rollback",
	};
}

/**
 * The user-facing message for a boot/sync failure — what `BootScreen` renders.
 *
 * Behaviour-identical to the pre-adoption `App.errorMessage` helper: it surfaces
 * the engine's own message verbatim (and the same `"Unexpected error"` fallback
 * for a non-Error), so not one on-screen byte changes. The only new work is
 * routing the failure through the canonical registry to log a stable, greppable
 * code for support correlation — a dev-facing breadcrumb, never rendered.
 */
export function bootErrorMessage(err: unknown): string {
	return bootFailure(err).message;
}
