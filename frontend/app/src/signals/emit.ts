// Interaction-signal emit rules — the ONE place that decides whether a user
// action becomes an engine event, and what the UI says about it.
//
// The engine already grades the full vocabulary
// (click | view | favorite | cart); this module owns the per-type EMIT RULES
// (one rule per signal type):
//
//   click     every press
//   favorite  once per product per session, on the first transition to
//             favorited (unfavoriting emits nothing — negative signals are
//             deferred)
//   cart      every press (repeated intent = repeated signal)
//   view      once per product per session (ambient dwell impressions)
//
// Caps are in-memory module state and share the taste profile's lifetime:
// "Reset taste" clears profile + durable log + caps together (resetSignalCaps).
// A reload re-arms the caps while the profile replays from the durable taste
// log (signals/tasteLog.ts) — re-signaling a replayed product is harmless
// because affinity bumps saturate at 1.0 per key, so the effect is bounded.

import { sendEvent } from "../api/client";
import type { EventType, Product } from "../api/types";

export interface SignalOutcome {
	/** Whether an event was actually sent (in-tab engine fold + on-device taste log). */
	readonly emitted: boolean;
	/** Toast copy; null for silent signals (views) and capped no-ops. */
	readonly message: string | null;
}

const favoriteEmitted = new Set<string>();
const viewEmitted = new Set<string>();
let cartHonestyShown = false;

/**
 * Re-arm the once-per-session budgets. Production caller: the storefront's
 * "Reset taste" affordance — after the profile and durable log are wiped, the
 * same product may legitimately signal again.
 */
export function resetSignalCaps(): void {
	favoriteEmitted.clear();
	viewEmitted.clear();
	cartHonestyShown = false;
}

/** Test seam alias: unit tests reset the module state between cases. */
export function __resetSignalsForTests(): void {
	resetSignalCaps();
}

function isCapped(eventType: EventType, product: Product): boolean {
	if (eventType === "favorite") return favoriteEmitted.has(product.id);
	if (eventType === "view") return viewEmitted.has(product.id);
	return false;
}

// Split from isCapped so a FAILED sendEvent does not consume the
// once-per-session budget.
function commitCap(eventType: EventType, product: Product): void {
	if (eventType === "favorite") favoriteEmitted.add(product.id);
	if (eventType === "view") viewEmitted.add(product.id);
}

function toastFor(eventType: EventType, product: Product): string | null {
	switch (eventType) {
		case "click":
			return `Added “${product.title}” to your taste`;
		case "favorite":
			return `Favorited “${product.title}” — strong signal, rail reweighted`;
		case "cart": {
			const honesty = cartHonestyShown
				? ""
				: " (demo: a ranking signal — nothing is purchased)";
			cartHonestyShown = true;
			return `“${product.title}” in the cart — strong signal, rail reweighted${honesty}`;
		}
		case "view":
			return null;
	}
}

/**
 * Apply the per-type emit rule and, if allowed, send the event down the
 * existing path (in-tab engine fold + on-device taste log). Errors
 * propagate: explicit-action handlers surface them in the UI; the ambient
 * dwell path deliberately swallows them.
 */
export async function emitInteraction(
	eventType: EventType,
	product: Product,
): Promise<SignalOutcome> {
	if (isCapped(eventType, product)) {
		return { emitted: false, message: null };
	}
	await sendEvent({
		event_type: eventType,
		product_id: product.id,
		timestamp: new Date().toISOString(),
	});
	commitCap(eventType, product);
	return { emitted: true, message: toastFor(eventType, product) };
}
