// The cross-browser lanes are part of the PR gate, not an optional extra.
//
// Harish's bar is Chrome, Edge, Firefox and Safari. Chromium runs in test:e2e,
// WebKit in test:e2e:webkit, and Firefox + Edge in test:e2e:browsers. These
// checks fail if a lane drops out of gate:e2e, runs against a missing build, or
// CI stops installing the browser it needs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const APP = dirname(dirname(fileURLToPath(import.meta.url)));
const FRONTEND = dirname(APP);
const REPO = dirname(FRONTEND);

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const appScripts = readJson(join(APP, "package.json")).scripts;
const gateE2e = readJson(join(FRONTEND, "package.json")).scripts["gate:e2e"];
const lanes = gateE2e.split("&&").map((step) => step.trim());
const laneIndex = (script) => lanes.indexOf(`pnpm -F frontend run ${script}`);

test("gate:e2e runs the Firefox + Edge lane on the fresh production build", () => {
	const browsers = laneIndex("test:e2e:browsers:built");
	const webkit = laneIndex("test:e2e:webkit");
	const offline = laneIndex("test:e2e:offline");
	assert.ok(browsers >= 0, `gate:e2e lacks the browsers lane: ${gateE2e}`);
	// :built reuses dist/; webkit's build:pages must run right before it, and
	// the offline lane (which rebuilds dist with other env) must come after.
	assert.equal(
		webkit,
		browsers - 1,
		"browsers lane must follow the webkit build",
	);
	assert.ok(offline > browsers, "offline rebuilds dist; it must run last");
	assert.match(appScripts["test:e2e:webkit"], /^pnpm run build:pages && /);
	assert.equal(
		appScripts["test:e2e:browsers:built"],
		"playwright test -c playwright.browsers.config.ts",
	);
	assert.match(appScripts["test:e2e:browsers"], /^pnpm run build:pages && /);
});

test("the browsers config drives Firefox and the real Edge channel", () => {
	const config = readFileSync(
		join(APP, "playwright.browsers.config.ts"),
		"utf8",
	);
	assert.match(
		config,
		/name: "firefox",\s*use: \{ \.\.\.devices\["Desktop Firefox"\] \}/,
	);
	assert.match(config, /channel: "msedge"/);
	// CI on linux/x64 must REQUIRE Edge, never silently swap in Chromium.
	assert.match(
		config,
		/edgeRequired =\s*!!process\.env\.CI && process\.platform === "linux" && process\.arch === "x64"/,
	);
});

test("CI installs every browser the e2e gate drives", () => {
	const dagger = readFileSync(
		join(REPO, ".dagger/src/edge_reco/main.py"),
		"utf8",
	);
	const install =
		dagger.match(/^PLAYWRIGHT_INSTALL: Final = \(([\s\S]*?)^\)$/m)?.[1] ?? "";
	assert.match(
		install,
		/playwright install --with-deps chromium webkit firefox/,
	);
	// Microsoft ships Edge for linux/x64 only; install it wherever it exists.
	assert.match(install, /x86_64.*playwright install --with-deps msedge/);
});
