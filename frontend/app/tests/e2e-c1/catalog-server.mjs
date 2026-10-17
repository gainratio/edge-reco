// Minimal CORS-enabled static server for the C1 e2e: serves the REAL signed
// bundle (backend/examples/catalog) + the pinned pubkey (backend/examples/keys) so the browser
// Worker syncs over HTTP exactly as in production. Also serves a `/patched/`
// variant whose catalog_meta chunk is swapped, to prove a re-sync fetches only
// the changed chunk. Started by Playwright's `webServer`.

import { readdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// HERE = frontend/app/tests/e2e-c1 → up 4 to the repo root, then backend/examples
// (the signed catalog + pinned keys moved under backend/ in the 2026-05 restructure).
const EXAMPLES = join(HERE, "..", "..", "..", "..", "backend", "examples");
const CATALOG = join(EXAMPLES, "catalog");
const CATALOG_DELTA = join(EXAMPLES, "catalog-delta");
const KEYS = join(EXAMPLES, "keys");
const PORT = Number(process.env.CATALOG_PORT ?? "8910");

function send(res, status, body, type = "application/octet-stream") {
	res.writeHead(status, {
		"Content-Type": type,
		"Access-Control-Allow-Origin": "*",
		"Cache-Control": "no-store",
	});
	res.end(body);
}

async function tamperedLatest() {
	const raw = JSON.parse(await readFile(join(CATALOG, "latest"), "utf-8"));
	// flip one base64 char so the signature no longer verifies (fail-closed test)
	const sig = raw.signature;
	raw.signature = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
	return JSON.stringify(raw);
}

async function readOverlayFile(...segments) {
	try {
		return await readFile(join(CATALOG_DELTA, ...segments));
	} catch {
		return await readFile(join(CATALOG, ...segments));
	}
}

async function serveCatalogFile(rel, res, tampered, delta = false) {
	if (rel === "latest") {
		if (tampered) {
			return send(res, 200, await tamperedLatest(), "application/json");
		}
		const latestBytes = delta
			? await readOverlayFile("latest")
			: await readFile(join(CATALOG, "latest"));
		return send(res, 200, latestBytes, "application/json");
	}
	const manifest = rel.match(/^manifest\/([0-9a-f]+)$/);
	if (manifest) {
		const manifestBytes = delta
			? await readOverlayFile("manifest", manifest[1])
			: await readFile(join(CATALOG, "manifest", manifest[1]));
		return send(res, 200, manifestBytes);
	}
	const chunk = rel.match(/^chunk\/([0-9a-f]+)$/);
	if (chunk) {
		const chunkBytes = delta
			? await readOverlayFile("chunk", chunk[1])
			: await readFile(join(CATALOG, "chunk", chunk[1]));
		return send(res, 200, chunkBytes);
	}
	return send(res, 404, "not found", "text/plain");
}

const server = createServer((req, res) => {
	const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
	const path = decodeURIComponent(url.pathname);
	const handle = async () => {
		if (path === "/public.key") {
			return send(res, 200, await readFile(join(KEYS, "public.key")));
		}
		if (path.startsWith("/catalog-tampered/")) {
			return serveCatalogFile(
				path.slice("/catalog-tampered/".length),
				res,
				true,
			);
		}
		if (path.startsWith("/catalog-delta/")) {
			return serveCatalogFile(
				path.slice("/catalog-delta/".length),
				res,
				false,
				true,
			);
		}
		if (path.startsWith("/catalog/")) {
			return serveCatalogFile(path.slice("/catalog/".length), res, false);
		}
		return send(res, 404, "not found", "text/plain");
	};
	handle().catch((error) => send(res, 500, String(error), "text/plain"));
});

server.listen(PORT, () => {
	// readdir touch keeps the import used + verifies the catalog is present early.
	readdir(join(CATALOG, "chunk")).then((files) => {
		process.stdout.write(
			`catalog-server: ${files.length} chunks on :${PORT}\n`,
		);
	});
});
