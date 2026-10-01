// Tests for the build guard that refuses to ship a product without its picture.
//
// The storefront shows `/images/<id>.svg` for every product. The card is signed
// into the committed bundle AND served from public/images. If a product loses
// either copy, the shopper sees a broken tile, and nothing else in the build
// notices. These tests build tiny bundles in a temp dir to prove each failure is
// reported, and run the guard against the real committed bundle to prove it passes.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { zstdCompressSync } from "node:zlib";
import { CATALOG_DIR } from "./build-pages.mjs";
import {
	findProductImageProblems,
	PUBLIC_IMAGES_DIR,
} from "./check-product-images.mjs";

const SCRIPT = join(
	dirname(fileURLToPath(import.meta.url)),
	"check-product-images.mjs",
);

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** A minimal signed-bundle layout: latest -> manifest -> zstd chunk(s). */
function makeBundle(products, { signed = [], tamper = false } = {}) {
	const root = mkdtempSync(join(tmpdir(), "pimg-"));
	const catalogDir = join(root, "catalog");
	const imagesDir = join(root, "images");
	mkdirSync(join(catalogDir, "chunk"), { recursive: true });
	mkdirSync(join(catalogDir, "manifest"));
	mkdirSync(imagesDir);
	const jsonl = Buffer.from(
		products.map((p) => `${JSON.stringify(p)}\n`).join(""),
		"utf8",
	);
	const chunk = zstdCompressSync(jsonl);
	const chunkHash = sha(chunk);
	writeFileSync(
		join(catalogDir, "chunk", chunkHash),
		tamper ? zstdCompressSync(Buffer.from("{}\n")) : chunk,
	);
	const files = [
		{
			path: "products.jsonl",
			file_sha256: sha(jsonl),
			chunks: [{ hash: chunkHash, size: chunk.length }],
		},
		...signed.map((name) => ({
			path: `images/${name}`,
			file_sha256: "0".repeat(64),
			chunks: [],
		})),
	];
	const manifest = Buffer.from(JSON.stringify({ files }));
	const manifestHash = sha(manifest);
	writeFileSync(join(catalogDir, "manifest", manifestHash), manifest);
	writeFileSync(
		join(catalogDir, "latest"),
		JSON.stringify({ manifest_hash: manifestHash }),
	);
	return { root, catalogDir, imagesDir };
}

const product = (id) => ({ id, image_url: `/images/${id}.svg` });

test("the committed bundle and public/images pass: every product has its card", () => {
	const result = findProductImageProblems({
		catalogDir: CATALOG_DIR,
		imagesDir: PUBLIC_IMAGES_DIR,
	});
	assert.deepEqual(result.problems, []);
	assert.equal(result.productCount, 720);
});

test("a product whose card is missing from the static origin is reported", () => {
	const b = makeBundle([product("A-1"), product("A-2")], {
		signed: ["A-1.svg", "A-2.svg"],
	});
	try {
		writeFileSync(join(b.imagesDir, "A-1.svg"), "<svg/>");
		const { problems } = findProductImageProblems(b);
		assert.deepEqual(problems, [
			"A-2: /images/A-2.svg is not in the static images dir",
		]);
	} finally {
		rmSync(b.root, { recursive: true, force: true });
	}
});

test("a product whose card is not signed into the bundle is reported", () => {
	const b = makeBundle([product("A-1")]);
	try {
		writeFileSync(join(b.imagesDir, "A-1.svg"), "<svg/>");
		const { problems } = findProductImageProblems(b);
		assert.deepEqual(problems, [
			"A-1: images/A-1.svg is not signed into the bundle",
		]);
	} finally {
		rmSync(b.root, { recursive: true, force: true });
	}
});

test("a product pointing off-origin or at no image is reported", () => {
	const b = makeBundle([
		{ id: "A-1", image_url: "https://cdn.example.com/a.jpg" },
		{ id: "A-2", image_url: "" },
	]);
	try {
		const { problems } = findProductImageProblems(b);
		assert.deepEqual(problems, [
			'A-1: image_url "https://cdn.example.com/a.jpg" is not a local /images/ path',
			'A-2: image_url "" is not a local /images/ path',
		]);
	} finally {
		rmSync(b.root, { recursive: true, force: true });
	}
});

test("a tampered products.jsonl fails closed instead of checking the wrong list", () => {
	const b = makeBundle([product("A-1")], { tamper: true });
	try {
		assert.throws(() => findProductImageProblems(b), /failed its sha256 check/);
	} finally {
		rmSync(b.root, { recursive: true, force: true });
	}
});

test("an empty catalog fails: zero products is not 'all present'", () => {
	const b = makeBundle([]);
	try {
		const { problems } = findProductImageProblems(b);
		assert.deepEqual(problems, ["the bundle lists no products"]);
	} finally {
		rmSync(b.root, { recursive: true, force: true });
	}
});

test("the CLI exits non-zero and names the product when a card is missing", () => {
	const b = makeBundle([product("A-1")], { signed: ["A-1.svg"] });
	try {
		const run = spawnSync(process.execPath, [SCRIPT], {
			env: {
				...process.env,
				PRODUCT_IMAGES_CATALOG_DIR: b.catalogDir,
				PRODUCT_IMAGES_DIR: b.imagesDir,
			},
			encoding: "utf8",
		});
		assert.equal(run.status, 1);
		assert.match(
			run.stderr,
			/A-1: \/images\/A-1\.svg is not in the static images dir/,
		);
	} finally {
		rmSync(b.root, { recursive: true, force: true });
	}
});

test("the CLI exits zero on the committed bundle", () => {
	const run = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
	assert.equal(run.status, 0, run.stderr);
	assert.match(run.stdout, /product images: 720\/720 present/);
});

test("the CLI skips in remote image mode, where no local cards exist", () => {
	const b = makeBundle([
		{ id: "A-1", image_url: "https://cdn.example.com/a.jpg" },
	]);
	try {
		const run = spawnSync(process.execPath, [SCRIPT], {
			env: {
				...process.env,
				EDGERECO_IMAGE_MODE: "remote",
				PRODUCT_IMAGES_CATALOG_DIR: b.catalogDir,
				PRODUCT_IMAGES_DIR: b.imagesDir,
			},
			encoding: "utf8",
		});
		assert.equal(run.status, 0, run.stderr);
		assert.match(run.stdout, /remote mode/);
	} finally {
		rmSync(b.root, { recursive: true, force: true });
	}
});
