#!/usr/bin/env node
/**
 * i18n live-drive — REAL browser (headless Chromium via Playwright) against a
 * production build + preview. Proves the offline bundled catalogs and the mounted
 * I18nextProvider actually render translated screens — not just that unit tests
 * pass. It drives the pre-boot Landing (no engine, no bundle server needed), so it
 * is a fast, self-contained gate.
 *
 * Usage:  node scripts/verify-i18n.mjs [baseURL]   (default http://localhost:4173)
 *   Expects a build already previewed at baseURL (vite build && vite preview).
 *
 * Ported from AlmaMesh's scripts/verify-i18n.mjs, adapted to EdgeReco's single
 * (English) baseline, namespaces (common/landing/storefront/errors), and the
 * Landing surface that renders at `/` before the engine boots.
 */
import { chromium } from "@playwright/test";

const BASE_URL = process.argv[2] ?? "http://localhost:4173";

// Known translated copy that MUST render on the Landing — one string per source
// namespace path we touched, so a raw-key leak (i18n not mounted / bad key) fails
// loudly. These are the exact en catalog values, proving t() resolved them.
const CASES = [
	{
		lang: "en",
		strings: [
			"▶ Launch the live demo",
			"brings their own device",
			"measured on edge-reco.com",
			"How it works",
			"JS heap (Chromium)",
		],
	},
];

// If any of these dotted key fragments reach the screen, i18n silently failed and
// leaked raw keys instead of copy.
const RAW_KEY_FRAGMENTS = ["hero.titleLead", "cta.launch", "whys.", "metrics."];

let failed = false;
function fail(message) {
	failed = true;
	console.error(`❌ ${message}`);
}

const browser = await chromium.launch();
try {
	for (const { lang, strings } of CASES) {
		const context = await browser.newContext();
		const page = await context.newPage();
		const consoleErrors = [];
		page.on("console", (message) => {
			if (message.type() === "error") consoleErrors.push(message.text());
		});

		await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
		await page
			.waitForSelector("text=Launch the live demo", { timeout: 15000 })
			.catch(() => {});

		const bodyText = await page.evaluate(() => document.body.innerText);
		const htmlLang = await page.evaluate(() => document.documentElement.lang);
		// innerText reflects CSS text-transform (e.g. the "How it works" heading
		// renders uppercase), so match case-insensitively — we assert the copy is
		// on screen, not its casing.
		const haystack = bodyText.toLowerCase();

		for (const string of strings) {
			if (!haystack.includes(string.toLowerCase())) {
				fail(`[${lang}] expected translated copy "${string}" — not on screen`);
			}
		}
		for (const fragment of RAW_KEY_FRAGMENTS) {
			if (haystack.includes(fragment.toLowerCase())) {
				fail(`[${lang}] raw i18n key fragment "${fragment}" is visible`);
			}
		}
		if (htmlLang !== lang) {
			fail(`[${lang}] expected <html lang>="${lang}" but got "${htmlLang}"`);
		}
		if (consoleErrors.length) {
			// Ignore benign preview noise unrelated to i18n: PWA/service-worker
			// registration and external asset loads (Google Fonts, favicon). A real
			// i18n failure surfaces as a missing-key warning or a render throw, not
			// one of these.
			const real = consoleErrors.filter(
				(error) =>
					!/service worker|workbox|manifest|favicon|googleapis|gstatic|failed to load resource/i.test(
						error,
					),
			);
			if (real.length) {
				fail(`[${lang}] console errors: ${real.join(" | ")}`);
			}
		}

		if (!failed) {
			console.log(
				`✅ [${lang}] Landing renders translated copy  <html lang>=${htmlLang}  clean console`,
			);
		}
		await context.close();
	}
} finally {
	await browser.close();
}

if (failed) {
	console.error("\ni18n live-drive FAILED");
	process.exit(1);
}
console.log(
	"\n✅ i18n live-drive PASSED — offline bundled catalogs render translated screens (en)",
);
