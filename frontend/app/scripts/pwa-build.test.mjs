import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const APP = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = join(APP, "dist");

test(
	"build:pages emits an installable, bundle-safe service worker",
	() => {
		const r = spawnSync("pnpm", ["run", "build:pages"], {
			cwd: APP,
			stdio: "inherit",
			env: process.env,
		});
		assert.equal(r.status, 0, "build:pages failed");

		assert.ok(existsSync(join(DIST, "sw.js")), "dist/sw.js missing");
		assert.ok(
			existsSync(join(DIST, "manifest.webmanifest")),
			"dist/manifest.webmanifest missing",
		);

		const manifest = JSON.parse(
			readFileSync(join(DIST, "manifest.webmanifest"), "utf8"),
		);
		assert.ok(
			manifest.icons?.some((i) => i.sizes === "192x192"),
			"no 192 icon",
		);
		assert.ok(
			manifest.icons?.some((i) => i.sizes === "512x512"),
			"no 512 icon",
		);
		assert.ok(
			manifest.icons?.some((i) => i.purpose === "maskable"),
			"no maskable icon",
		);

		// The bundle is copied into dist/bundle AFTER the build; the precache must never list it.
		const sw = readFileSync(join(DIST, "sw.js"), "utf8");
		assert.ok(
			!/bundle\//.test(sw),
			"service worker precache must exclude bundle/**",
		);

		// Vite emits ORT wasm under /assets/, so **/*.wasm matched it. Precaching it
		// forced a ~22 MB install download before the starter could render.
		assert.ok(
			!/url:\s*"[^"]*ort-wasm-/.test(sw),
			"service worker precache must exclude assets/ort-wasm-*",
		);

		// Cloudflare Pages advanced mode consumes these four filenames as platform
		// configuration and 404s them as assets. Workbox's install is atomic, so a
		// single one in the precache means the deployed site gets NO service worker
		// at all — which is exactly how edge-reco.com shipped a false "works
		// offline" claim behind a green preview-driven test lane. This is the fast
		// offline signal; tests/e2e-offline/pages-advanced-mode.spec.ts proves the
		// install survives against a harness with the real origin's semantics.
		for (const reserved of [
			"_worker.js",
			"_headers",
			"_redirects",
			"_routes.json",
		]) {
			assert.ok(
				!new RegExp(`url:\\s*"${reserved}"`).test(sw),
				`service worker precache must exclude ${reserved} — Cloudflare Pages 404s it, which aborts the whole install`,
			);
		}
	},
	{ timeout: 180_000 },
);
