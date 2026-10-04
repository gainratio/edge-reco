// No user data leaves the device. This guard reads the BUILT app (dist/) and
// fails if it could talk to any host besides its own origin, where the signed
// catalog bundle (/bundle), the embedding model (/models) and the wasm runtime
// (/ort) are all served.
//
// Three checks, each able to fail on its own:
//   1. The CSP pins connect-src and img-src to 'self' (data: images only), so
//      the browser itself refuses fetch/XHR/beacon/pixel traffic elsewhere.
//   2. The built JS opens no beacon, WebSocket or EventSource channel.
//   3. Every http(s) host named in the built JS is on the allow-list below,
//      with the reason it is there. A new uplink, analytics SDK or CDN shows up
//      as a new host and fails here until someone justifies it in review.
//
// Run by `pnpm -F frontend run test:artifacts` after `build:pages`.

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const APP_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST_DIR = process.env.PRODUCTION_ARTIFACT_DIR
	? resolve(APP_DIR, process.env.PRODUCTION_ARTIFACT_DIR)
	: undefined;

/** Hosts the built JS may NAME. None of them is contacted at runtime. */
const ALLOWED_URL_HOSTS = new Map([
	["www.w3.org", "XML/SVG namespace identifiers, not requests"],
	["github.com", "source and docs links in copy and library error text"],
	["gist.github.com", "a library's error-text link"],
	[
		"huggingface.co",
		"transformers.js default hub; the app sets /models/ and CSP blocks it",
	],
	[
		"cdn.jsdelivr.net",
		"onnxruntime default wasm path; the app sets /ort/ and CSP blocks it",
	],
	["sqlite.org", "SQLite error-text links"],
	["emscripten.org", "SQLite wasm error-text links"],
	["web.dev", "library docs links"],
	["react.dev", "React error-decoder links"],
	["react.i18next.com", "i18next docs link"],
	["developer.mozilla.org", "library docs links"],
	["developer.chrome.com", "library docs links"],
	["rolldown.rs", "bundler runtime error-text link"],
	["bit.ly", "a library's error-text short link"],
	["edge-reco.com", "this site's canonical URL"],
	["edge-reco.invalid", "a reserved placeholder origin for URL parsing"],
	["aml-filter.com", "sibling-site link"],
	["almamesh.com", "sibling-site link"],
]);

const URL_HOST = /https?:\/\/([A-Za-z0-9.-]+)/gu;
const CHANNELS = /\b(?:sendBeacon|new\s+WebSocket|new\s+EventSource)\b/u;

/** Hosts named in one file's text that are not on the allow-list. */
function unexpectedHosts(text) {
	const hosts = new Set();
	for (const match of text.matchAll(URL_HOST)) {
		const host = match[1].toLowerCase().replace(/\.$/u, "");
		if (!ALLOWED_URL_HOSTS.has(host)) {
			hosts.add(host);
		}
	}
	return [...hosts];
}

/** The CSP directive value, or undefined. */
function directive(csp, name) {
	const part = csp
		.split(";")
		.map((p) => p.trim())
		.find((p) => p === name || p.startsWith(`${name} `));
	return part?.slice(name.length).trim();
}

async function builtScripts(dir) {
	const out = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		const rel = relative(DIST_DIR, path);
		// models/ and ort/ are mirrored third-party binaries/runtime, pinned by
		// their own preflight hashes; the catalog bundle is signed data.
		if (entry.isDirectory()) {
			if (!["models", "ort", "bundle"].includes(rel)) {
				out.push(...(await builtScripts(path)));
			}
		} else if (/\.m?js$/u.test(entry.name)) {
			out.push(path);
		}
	}
	return out;
}

test("the allow-list helpers catch a new host and a beacon", () => {
	assert.deepEqual(
		unexpectedHosts('fetch("https://events.example.com/events")'),
		["events.example.com"],
	);
	assert.deepEqual(unexpectedHosts('"https://github.com/x"'), []);
	assert.equal(CHANNELS.test("navigator.sendBeacon(u, b)"), true);
	assert.equal(
		directive("default-src 'self'; connect-src 'self'", "connect-src"),
		"'self'",
	);
});

test("built app names no network host outside the allow-list", async (t) => {
	if (DIST_DIR === undefined) {
		t.skip("runs against the generated production dist");
		return;
	}
	const files = await builtScripts(DIST_DIR);
	assert.ok(files.length > 3, `expected built scripts in ${DIST_DIR}`);
	const found = [];
	for (const file of files) {
		for (const host of unexpectedHosts(await readFile(file, "utf8"))) {
			found.push(`${relative(DIST_DIR, file)}: ${host}`);
		}
	}
	assert.deepEqual(found, []);
});

test("built app opens no beacon, WebSocket or EventSource channel", async (t) => {
	if (DIST_DIR === undefined) {
		t.skip("runs against the generated production dist");
		return;
	}
	const offenders = [];
	for (const file of await builtScripts(DIST_DIR)) {
		if (CHANNELS.test(await readFile(file, "utf8"))) {
			offenders.push(relative(DIST_DIR, file));
		}
	}
	assert.deepEqual(offenders, []);
});

test("the CSP lets the page connect and load images only from itself", async (t) => {
	if (DIST_DIR === undefined) {
		t.skip("runs against the generated production dist");
		return;
	}
	const headers = await readFile(join(DIST_DIR, "_headers"), "utf8");
	const policies = [
		...headers.matchAll(/Content-Security-Policy:\s*(.+)/gu),
	].map((m) => m[1]);
	assert.ok(policies.length > 0, "no CSP in _headers");
	for (const csp of policies) {
		assert.equal(directive(csp, "connect-src"), "'self'");
		assert.equal(directive(csp, "img-src"), "'self' data:");
		assert.equal(directive(csp, "default-src"), "'self'");
	}
});
