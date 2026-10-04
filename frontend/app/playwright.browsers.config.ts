import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

/**
 * Cross-browser journey lane — the production build on Firefox (Gecko) and
 * Microsoft Edge.
 *
 * edge-reco runs its whole engine in the shopper's browser (OPFS, wasm,
 * workers), so "works in Chrome" proves nothing about Firefox or Edge. This
 * lane loads the REAL `dist/` (built by `build:pages`) through pages-server.mjs
 * on an ephemeral port (no fixed port to collide with) and drives the full
 * journey: boot, search, open a product page.
 *
 * Edge: Playwright drives the real Microsoft Edge build through
 * `channel: "msedge"`. Microsoft ships Edge for Linux on x64 only, and
 * installing it needs root (apt on Linux, `sudo installer` on macOS). So:
 *   - CI on linux/x64 (the Dagger container installs `msedge`): Edge is
 *     REQUIRED — a missing binary fails the run instead of quietly testing
 *     something else;
 *   - anywhere else with Edge installed: the real Edge runs;
 *   - anywhere else without it (e.g. an arm64 Mac dev box): the project runs
 *     stock Chromium, Edge's engine, and the spec annotates the substitution so
 *     the report never claims an Edge run that did not happen.
 */
const EDGE_BINARIES: Readonly<Record<string, string>> = {
	linux: "/opt/microsoft/msedge/msedge",
	darwin: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
	win32: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
};

const edgeRequired =
	!!process.env.CI && process.platform === "linux" && process.arch === "x64";
const edgeBinary = EDGE_BINARIES[process.platform];
const edgeInstalled = edgeBinary !== undefined && existsSync(edgeBinary);
const useEdgeChannel = edgeRequired || edgeInstalled;

export default defineConfig({
	testDir: "tests/e2e-browsers",
	fullyParallel: false,
	forbidOnly: !!process.env.CI,
	retries: 0,
	workers: 1,
	reporter: [["list"]],
	timeout: 180_000,
	expect: { timeout: 90_000 },
	use: { headless: true, trace: "retain-on-failure" },
	projects: [
		{
			name: "firefox",
			use: { ...devices["Desktop Firefox"] },
		},
		{
			name: "edge",
			use: useEdgeChannel
				? { ...devices["Desktop Edge"], channel: "msedge" }
				: { ...devices["Desktop Chrome"] },
			metadata: { edgeChannel: useEdgeChannel },
		},
	],
});
