import { defineConfig, devices } from "@playwright/test";

/**
 * WebKit lane — the production build, on iPhone-13 emulation.
 *
 * edge-reco runs its whole engine in the shopper's browser (OPFS, wasm, workers),
 * and WebKit is the engine behind every iPhone and iPad browser. This lane loads
 * the REAL `dist/` (built by `build:pages`) and drives the storefront to a
 * rendered catalog. It runs in Playwright's default, EPHEMERAL WebKit context,
 * the closest CI stand-in for Safari Private Browsing: no OPFS
 * (`navigator.storage.getDirectory()` throws UnknownError). A device like that
 * must still get the storefront.
 *
 * No webServer block: the spec serves `dist/` through pages-server.mjs, which
 * models Cloudflare Pages' asset resolution and drops the HTTPS-only
 * `upgrade-insecure-requests` CSP directive that WebKit applies to http://localhost.
 */
export default defineConfig({
	testDir: "tests/e2e-webkit",
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
			name: "ios-webkit",
			use: { ...devices["iPhone 13"], browserName: "webkit" },
		},
	],
});
