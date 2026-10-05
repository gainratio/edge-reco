// Tests for the static-host build helpers (build-pages.mjs).
//
// The static build is the normal production build plus two knobs: the Vite
// base (defaults to the root "/" — the canonical host edge-reco.com serves at
// the apex) and an app-relative bundle URL (the committed catalog is copied
// same-origin into dist/bundle). These tests pin the env contract — defaults
// applied, caller overrides respected — and the copy-source location, without
// spawning a real build.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CATALOG_DIR, pagesEnv } from "./build-pages.mjs";

test("pagesEnv defaults VITE_BASE to root and sets a same-origin bundle URL", () => {
	const env = pagesEnv({ PATH: "/usr/bin" });
	assert.equal(env.VITE_BASE, "/");
	assert.equal(env.VITE_BUNDLE_BASE_URL, "bundle");
	assert.equal(env.PATH, "/usr/bin", "existing env must pass through");
});

test("pagesEnv respects caller overrides (forks deploy under their repo name)", () => {
	const env = pagesEnv({
		VITE_BASE: "/my-fork/",
		VITE_BUNDLE_BASE_URL: "https://cdn.example.com/cat",
	});
	assert.equal(env.VITE_BASE, "/my-fork/");
	assert.equal(env.VITE_BUNDLE_BASE_URL, "https://cdn.example.com/cat");
});

test("pagesEnv injects no events or telemetry URL (no user data leaves the device)", () => {
	const keys = Object.keys(pagesEnv({}));
	assert.deepEqual(
		keys.filter((key) => /EVENT|TELEMETRY|ANALYTICS|UPLINK/i.test(key)),
		[],
	);
});

test("CATALOG_DIR points at the committed signed bundle (latest pointer present)", () => {
	assert.ok(
		existsSync(join(CATALOG_DIR, "latest")),
		`expected a signed bundle at ${CATALOG_DIR}`,
	);
});
