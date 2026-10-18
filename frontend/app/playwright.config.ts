import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright e2e for the Nimbus storefront — BACKEND-FREE.
 *
 * Two webServers, both started by Playwright, NO application backend:
 *   - the Vite dev server (the static SPA), with VITE_BUNDLE_BASE_URL pointed at
 *     the static catalog origin below so the browser syncs the signed bundle;
 *   - the static catalog origin (catalog-server.mjs) serving the REAL signed
 *     bundle from examples/catalog over `/catalog/*` — a dumb file server, the
 *     stand-in for the Caddy edge.
 *
 * `http://localhost` is a secure context, so OPFS (the Worker's
 * createSyncAccessHandle) works with no COOP/COEP — the static-hostable path.
 * The ed25519 verify key is pinned same-origin (public/public.key on the SPA).
 */
const CATALOG_PORT = 8920;
const BUNDLE_BASE_URL = `http://localhost:${CATALOG_PORT}/catalog`;

export default defineConfig({
	testDir: "tests/e2e",
	fullyParallel: false,
	forbidOnly: !!process.env.CI,
	retries: 0,
	workers: 1,
	reporter: [["list"]],
	timeout: 180_000,
	expect: { timeout: 30_000 },
	use: {
		baseURL: "http://localhost:5174",
		headless: true,
		actionTimeout: 15_000,
		navigationTimeout: 30_000,
		trace: "retain-on-failure",
	},
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
	],
	webServer: [
		{
			command: "npx vite --port 5174 --strictPort",
			url: "http://localhost:5174/public.key",
			reuseExistingServer: !process.env.CI,
			timeout: 60_000,
			env: { VITE_BUNDLE_BASE_URL: BUNDLE_BASE_URL },
		},
		{
			command: "node tests/e2e-c1/catalog-server.mjs",
			url: `http://localhost:${CATALOG_PORT}/public.key`,
			reuseExistingServer: !process.env.CI,
			timeout: 30_000,
			env: { CATALOG_PORT: String(CATALOG_PORT) },
		},
	],
});
