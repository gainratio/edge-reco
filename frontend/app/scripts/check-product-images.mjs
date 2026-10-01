// Build guard: refuse to build if any product in the signed catalog lacks its picture.
//
// Every product's `image_url` is `/images/<id>.svg`. That card must be (1) signed
// into the committed bundle and (2) present in public/images, which is what the
// static origin serves. Lose either and a shopper sees a broken tile while every
// other check stays green. This reads the product list straight out of the signed
// bundle (latest -> manifest -> zstd chunks, sha256-checked), so it checks the
// products that actually ship, not a list someone keeps by hand.
//
// Runs as part of `prebuild`, so every production build (Pages, CI, the offline
// e2e lane) fails here first. Paths are env-overridable for tests:
//   PRODUCT_IMAGES_CATALOG_DIR  the bundle origin dir (default: the committed one)
//   PRODUCT_IMAGES_DIR          the static images dir (default: public/images)
// EDGERECO_IMAGE_MODE=remote skips the check: that bundle has no local cards.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zstdDecompressSync } from "node:zlib";

const APP_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

export const DEFAULT_CATALOG_DIR = resolve(
	APP_DIR,
	"..",
	"..",
	"backend",
	"examples",
	"catalog",
);
export const PUBLIC_IMAGES_DIR = join(APP_DIR, "public", "images");

/** Only a plain file name under /images/ counts as a local card. */
const LOCAL_IMAGE = /^\/images\/([A-Za-z0-9._-]+)$/u;

function readManifest(catalogDir) {
	const latest = JSON.parse(readFileSync(join(catalogDir, "latest"), "utf8"));
	const raw = readFileSync(join(catalogDir, "manifest", latest.manifest_hash));
	return new Map(
		JSON.parse(raw.toString("utf8")).files.map((f) => [f.path, f]),
	);
}

function materialize(catalogDir, entry) {
	const parts = entry.chunks.map((c) =>
		zstdDecompressSync(readFileSync(join(catalogDir, "chunk", c.hash))),
	);
	const blob = Buffer.concat(parts);
	const digest = createHash("sha256").update(blob).digest("hex");
	if (digest !== entry.file_sha256) {
		throw new Error(`${entry.path} failed its sha256 check`);
	}
	return blob;
}

function readProducts(catalogDir, manifest) {
	const text = materialize(catalogDir, manifest.get("products.jsonl")).toString(
		"utf8",
	);
	return text
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line));
}

function problemFor(product, manifest, imagesDir) {
	const url = product.image_url ?? "";
	const match = LOCAL_IMAGE.exec(url);
	if (match === null) {
		return `${product.id}: image_url ${JSON.stringify(url)} is not a local /images/ path`;
	}
	const name = match[1];
	// Raster photos are an origin asset, never signed (see publish.py); cards are.
	if (name.endsWith(".svg") && !manifest.has(`images/${name}`)) {
		return `${product.id}: images/${name} is not signed into the bundle`;
	}
	if (!existsSync(join(imagesDir, name))) {
		return `${product.id}: ${url} is not in the static images dir`;
	}
	return null;
}

/** Every reason a shipped product would show a broken picture; empty means none. */
export function findProductImageProblems({ catalogDir, imagesDir }) {
	const manifest = readManifest(catalogDir);
	const products = readProducts(catalogDir, manifest);
	if (products.length === 0) {
		return { productCount: 0, problems: ["the bundle lists no products"] };
	}
	const problems = products
		.map((p) => problemFor(p, manifest, imagesDir))
		.filter((p) => p !== null);
	return { productCount: products.length, problems };
}

function main() {
	if ((process.env.EDGERECO_IMAGE_MODE ?? "local") === "remote") {
		// REMOTE bundles keep the catalog's own CDN urls; there are no local cards.
		process.stdout.write(
			">> product images: remote mode, no local cards to check\n",
		);
		return;
	}
	const { productCount, problems } = findProductImageProblems({
		catalogDir: process.env.PRODUCT_IMAGES_CATALOG_DIR ?? DEFAULT_CATALOG_DIR,
		imagesDir: process.env.PRODUCT_IMAGES_DIR ?? PUBLIC_IMAGES_DIR,
	});
	if (problems.length > 0) {
		process.stderr.write(
			`!! ${problems.length} of ${productCount} products have no servable picture:\n` +
				`${problems.map((p) => `   ${p}`).join("\n")}\n` +
				"!! regenerate with backend/scripts/rebuild_example_bundle.py\n",
		);
		process.exit(1);
	}
	process.stdout.write(
		`>> product images: ${productCount}/${productCount} present\n`,
	);
}

// Import-safe for tests: only run when executed directly.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main();
}
