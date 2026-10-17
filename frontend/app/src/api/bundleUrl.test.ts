// resolveBundleBaseUrl turns the build-time VITE_BUNDLE_BASE_URL — absolute
// for the Docker demo's Caddy edge, app-relative for the static hosted build —
// into the ABSOLUTE URL the engine requires. The sync fetch runs inside a
// Worker, where a relative URL would resolve against the worker script's URL
// rather than the page, so the page must absolutize before handing it across.

import { afterEach, describe, expect, it } from "vitest";
import {
	isDeltaBundleChannel,
	resolveBaseBundleUrl,
	resolveBundleBaseUrl,
	resolveDeltaBundleUrl,
	setDeltaBundleChannel,
} from "./bundleUrl";

afterEach(() => {
	setDeltaBundleChannel(false);
});

describe("resolveBundleBaseUrl", () => {
	it("passes the Docker demo's absolute edge URL through unchanged", () => {
		expect(
			resolveBundleBaseUrl(
				"http://localhost:8081",
				"/",
				"http://localhost:5174",
			),
		).toBe("http://localhost:8081");
	});

	it("keeps the path of an absolute URL", () => {
		expect(
			resolveBundleBaseUrl(
				"https://cdn.example.com/cat",
				"/",
				"http://localhost:5174",
			),
		).toBe("https://cdn.example.com/cat");
	});

	it("resolves an app-relative value under the Vite base (GitHub Pages)", () => {
		expect(
			resolveBundleBaseUrl(
				"bundle",
				"/edge-reco/",
				"https://hseshadr.github.io",
			),
		).toBe("https://hseshadr.github.io/edge-reco/bundle");
	});

	it("resolves an app-relative value at the root base", () => {
		expect(resolveBundleBaseUrl("bundle", "/", "http://localhost:4173")).toBe(
			"http://localhost:4173/bundle",
		);
	});

	it("resolves same-origin under the apex domain (Cloudflare Pages)", () => {
		expect(resolveBundleBaseUrl("bundle", "/", "https://edge-reco.com")).toBe(
			"https://edge-reco.com/bundle",
		);
	});

	it("strips trailing slashes so the engine's /latest join has one slash", () => {
		expect(
			resolveBundleBaseUrl(
				"bundle/",
				"/edge-reco/",
				"https://hseshadr.github.io",
			),
		).toBe("https://hseshadr.github.io/edge-reco/bundle");
	});

	it("switches default bundle resolution to the -delta overlay when enabled", () => {
		expect(isDeltaBundleChannel()).toBe(false);
		expect(resolveDeltaBundleUrl("bundle", "/", "https://edge-reco.com")).toBe(
			"https://edge-reco.com/bundle-delta",
		);
		setDeltaBundleChannel(true);
		expect(isDeltaBundleChannel()).toBe(true);
		const defaultBase = resolveBaseBundleUrl(
			undefined,
			"/",
			"https://edge-reco.com",
		);
		expect(resolveBundleBaseUrl(undefined, "/", "https://edge-reco.com")).toBe(
			`${defaultBase}-delta`,
		);
		expect(resolveBaseBundleUrl("bundle", "/", "https://edge-reco.com")).toBe(
			"https://edge-reco.com/bundle",
		);
	});
});
