// Build the static, backend-free demo for host-based deployment. Two steps:
//
//   1. the normal production build (`pnpm run build` = tsc -b && vite build)
//      with the static env: VITE_BASE=/ (the canonical host is the apex domain
//      edge-reco.com on Cloudflare Pages, served at the root) and
//      VITE_BUNDLE_BASE_URL=bundle (app-relative; the SPA absolutizes it at
//      runtime — src/api/bundleUrl.ts — so the same dist works on any host
//      that serves it under VITE_BASE);
//   2. copy the committed signed catalog bundle (backend/examples/catalog)
//      same-origin into dist/bundle — no CORS, no second origin to run.
//
// VITE_EVENTS_URL is deliberately left alone (unset → uplink disabled → the
// hosted demo makes zero backend calls). Defaults are env-overridable: a fork
// hosting under a GitHub Pages project subpath sets VITE_BASE=/<repo>/.
//
// Run: `pnpm -F frontend run build:pages` (locally, or as the Cloudflare Pages
// build command — see docs/DEPLOY.md).

import { execFileSync, spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { findProductImageProblems } from "./check-product-images.mjs";
import { imgSrcForMode, REMOTE_IMAGE_HOSTS } from "./imageCsp.mjs";

const APP_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

/** The committed signed bundle this repo ships (latest + manifest/* + chunk/*). */
export const CATALOG_DIR = resolve(
	APP_DIR,
	"..",
	"..",
	"backend",
	"examples",
	"catalog",
);

const DIST_DIR = join(APP_DIR, "dist");
const DIST_BUNDLE_DIR = join(DIST_DIR, "bundle");

/** Static build env: fill the two host knobs unless the caller already set them. */
export function pagesEnv(env) {
	return {
		...env,
		// Root base: the canonical host (edge-reco.com on Cloudflare Pages) serves
		// at "/". Forks on a GitHub Pages project subpath override VITE_BASE=/<repo>/.
		VITE_BASE: env.VITE_BASE ?? "/",
		VITE_BUNDLE_BASE_URL: env.VITE_BUNDLE_BASE_URL ?? "bundle",
		// REMOTE mode must widen BOTH the deployed img-src and the component's own
		// allowlist. Both are derived from REMOTE_IMAGE_HOSTS so they cannot drift:
		// a CSP that permits the host renders nothing while ProductImage refuses the
		// url, which is precisely how this mode first shipped as 54 placeholders.
		VITE_REMOTE_IMAGE_HOSTS:
			env.EDGERECO_IMAGE_MODE === "remote" ? REMOTE_IMAGE_HOSTS.join(" ") : "",
	};
}

/**
 * Align the SHIPPED `_headers` with the image mode the catalog bundle was published in.
 *
 * `EDGERECO_IMAGE_MODE=remote` means the bundle kept the catalog's own CDN urls, so the
 * deployed `img-src` has to name those hosts or the browser blocks every photo and the
 * storefront silently shows nothing. `local` (the default) ships the committed strict
 * policy untouched, because every photo is served from this origin.
 */
function applyImageModeCsp(env) {
	const mode = env.EDGERECO_IMAGE_MODE ?? "local";
	if (mode !== "local" && mode !== "remote") {
		die(`EDGERECO_IMAGE_MODE must be "local" or "remote", got ${mode}`);
	}
	const headersPath = join(DIST_DIR, "_headers");
	const before = readFileSync(headersPath, "utf8");
	const after = imgSrcForMode(before, mode);
	writeFileSync(headersPath, after, "utf8");
	process.stdout.write(
		`>> image mode: ${mode} (img-src ${after === before ? "unchanged" : "widened"})\n`,
	);
}

/**
 * The same guard `prebuild` runs on public/images, re-run on what actually ships:
 * dist/images, against the bundle just copied. REMOTE mode serves no local cards.
 */
function requireShippedProductImages(env) {
	if ((env.EDGERECO_IMAGE_MODE ?? "local") !== "local") {
		return;
	}
	const { productCount, problems } = findProductImageProblems({
		catalogDir: DIST_BUNDLE_DIR,
		imagesDir: join(DIST_DIR, "images"),
	});
	if (problems.length > 0) {
		die(`dist is missing product images:\n   ${problems.join("\n   ")}`);
	}
	process.stdout.write(
		`>> dist product images: ${productCount}/${productCount}\n`,
	);
}

function die(message) {
	process.stderr.write(`!! ${message}\n`);
	process.exit(1);
}

function sourceCommit(env) {
	const explicit = env.EXPECTED_SHA ?? env.GITHUB_SHA;
	if (explicit !== undefined && /^[0-9a-f]{40}$/u.test(explicit)) {
		return explicit;
	}
	return execFileSync("git", ["rev-parse", "HEAD"], {
		cwd: resolve(APP_DIR, "..", ".."),
		encoding: "utf8",
	}).trim();
}

function writeBuildIdentity(env) {
	const packageJson = JSON.parse(
		readFileSync(join(APP_DIR, "package.json"), "utf8"),
	);
	const latest = JSON.parse(readFileSync(join(CATALOG_DIR, "latest"), "utf8"));
	const identity = {
		commit: sourceCommit(env),
		version: packageJson.version,
		buildTime: new Date().toISOString(),
		bundleId: latest.bundle_id,
		bundleVersion: latest.version,
		bundleManifestHash: latest.manifest_hash,
		channel: latest.channel,
	};
	writeFileSync(
		join(DIST_DIR, "build.json"),
		`${JSON.stringify(identity, null, 2)}\n`,
		"utf8",
	);
}

function main() {
	if (!existsSync(join(CATALOG_DIR, "latest"))) {
		die(`no signed bundle at ${CATALOG_DIR} — expected the committed catalog.`);
	}

	const env = pagesEnv(process.env);
	process.stdout.write(
		`>> Pages build: VITE_BASE=${env.VITE_BASE} VITE_BUNDLE_BASE_URL=${env.VITE_BUNDLE_BASE_URL}\n`,
	);
	const build = spawnSync("pnpm", ["run", "build"], {
		cwd: APP_DIR,
		env,
		stdio: "inherit",
	});
	if (build.status !== 0) {
		die("vite build failed.");
	}

	// Re-copy from scratch so a stale dist/bundle never ships old chunks.
	rmSync(DIST_BUNDLE_DIR, { recursive: true, force: true });
	cpSync(CATALOG_DIR, DIST_BUNDLE_DIR, { recursive: true });
	if (!existsSync(join(DIST_BUNDLE_DIR, "latest"))) {
		die("bundle copy failed — dist/bundle/latest missing.");
	}
	requireShippedProductImages(env);
	writeBuildIdentity(env);
	applyImageModeCsp(env);
	process.stdout.write(
		`>> Pages dist ready: ${DIST_DIR} (signed bundle copied same-origin to dist/bundle)\n`,
	);
}

// Import-safe for tests: only run when executed directly (node scripts/build-pages.mjs).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main();
}
