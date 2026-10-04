/// <reference types="node" />
// Inject, don't entangle: edge-reco reaches SQLite only through
// @edgeproc/browser/sql, and only from ONE seam file (engine/catalogueSql.ts).
// Nothing may load the sqlite3 build by file path. The single exception is the
// test-only in-process Worker (engine/__fixtures__/nodeSqlWorker.ts), because
// the library ships no Node entry for its SQL Worker.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const PACKAGE = process.cwd();
const APP_SRC = join(PACKAGE, "../../app/src");
const SEAM = "src/engine/catalogueSql.ts";
const NODE_FIXTURE = "src/engine/__fixtures__/nodeSqlWorker.ts";
const SELF = "src/sqlBoundary.test.ts";

/** A quoted string that loads the SQLite build or reaches into a package dist. */
const RAW_SQLITE =
	/["'`][^"'`\n]*(?:sqlite3\.(?:mjs|wasm|js)|@sqlite\.org\/|node_modules\/@edgeproc\/)[^"'`\n]*["'`]/u;
/** An import of the library's SQL / SQLite / vector-SQLite subpaths. */
const SQL_SUBPATH =
	/["']@edgeproc\/browser\/(?:sql|sqlite|vector\/sqlite)(?:\/[^"']*)?["']/u;

function sources(directory: string): string[] {
	return readdirSync(directory).flatMap((name) => {
		const path = join(directory, name);
		if (statSync(path).isDirectory()) {
			return name === "node_modules" ? [] : sources(path);
		}
		return /\.tsx?$/u.test(name) ? [path] : [];
	});
}

/** Rule violations in one file's text, given its package-relative path. */
function violations(file: string, text: string): string[] {
	const found: string[] = [];
	if (file !== NODE_FIXTURE && RAW_SQLITE.test(text)) {
		found.push(`${file}: loads SQLite by file path`);
	}
	if (file !== SEAM && SQL_SUBPATH.test(text)) {
		found.push(`${file}: imports @edgeproc/browser SQL outside ${SEAM}`);
	}
	return found;
}

describe("SQLite boundary", () => {
	it("flags a direct sqlite3 import and a second SQL importer", () => {
		expect(
			violations(
				"src/engine/vectorIndex.ts",
				'import init from "../../node_modules/@edgeproc/browser/dist/vector/sqlite/assets/sqlite3.mjs";',
			),
		).toHaveLength(1);
		expect(
			violations(
				"src/engine/searchEngine.ts",
				'import { openSqlDatabase } from "@edgeproc/browser/sql";',
			),
		).toHaveLength(1);
		expect(
			violations(SEAM, 'import { x } from "@edgeproc/browser/sql";'),
		).toEqual([]);
	});

	it("holds across edge-reco's browser package and app sources", () => {
		const files = [...sources(join(PACKAGE, "src")), ...sources(APP_SRC)];
		expect(files.length).toBeGreaterThan(20);
		const found = files.flatMap((path) => {
			const file = relative(PACKAGE, path);
			return file === SELF ? [] : violations(file, readFileSync(path, "utf8"));
		});
		expect(found).toEqual([]);
	});

	it("keeps the seam the one importer of @edgeproc/browser/sql", () => {
		const seam = readFileSync(join(PACKAGE, SEAM), "utf8");
		expect(seam).toContain('from "@edgeproc/browser/sql"');
	});
});
