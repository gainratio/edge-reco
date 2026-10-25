// Resolve the signed-bundle base URL to the ABSOLUTE form the engine needs.
//
// VITE_BUNDLE_BASE_URL is absolute in the Docker demo (the Caddy edge,
// e.g. "http://localhost:8081") but app-relative in the GitHub Pages build
// ("bundle" — scripts/build-pages.mjs copies the committed catalog same-origin
// into dist/bundle). The engine's sync fetch runs inside a Worker, where a
// relative URL would resolve against the WORKER SCRIPT's URL, not the page —
// so the main thread must absolutize before handing the URL across.
//
// Resolution base: the Vite base (import.meta.env.BASE_URL) on the page
// origin, so one build works at "/" locally and "/edge-reco/" on Pages.

let deltaBundleChannel = false;

export function isDeltaBundleChannel(): boolean {
	return deltaBundleChannel;
}

export function setDeltaBundleChannel(enabled: boolean): void {
	deltaBundleChannel = enabled;
}

export function resolveBaseBundleUrl(
	raw: string = import.meta.env.VITE_BUNDLE_BASE_URL,
	appBase: string = import.meta.env.BASE_URL,
	origin: string = window.location.origin,
): string {
	const pageBase = new URL(appBase, origin);
	const resolved = new URL(raw, pageBase).toString();
	// The engine joins `${baseUrl}/latest` — keep exactly one slash at the seam.
	return resolved.replace(/\/+$/, "");
}

export function resolveDeltaBundleUrl(
	raw: string = import.meta.env.VITE_BUNDLE_BASE_URL,
	appBase: string = import.meta.env.BASE_URL,
	origin: string = window.location.origin,
): string {
	return `${resolveBaseBundleUrl(raw, appBase, origin)}-delta`;
}

export function resolveStarterBundleUrl(
	raw?: string,
	appBase: string = import.meta.env.BASE_URL,
	origin: string = window.location.origin,
): string {
	return `${resolveBaseBundleUrl(raw, appBase, origin)}-starter`;
}

export function resolveBundleBaseUrl(
	raw?: string,
	appBase: string = import.meta.env.BASE_URL,
	origin: string = window.location.origin,
): string {
	const base = resolveBaseBundleUrl(
		raw ?? import.meta.env.VITE_BUNDLE_BASE_URL,
		appBase,
		origin,
	);
	if (raw === undefined && isDeltaBundleChannel()) {
		return `${base}-delta`;
	}
	return base;
}
