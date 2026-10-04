/// <reference types="node" />
// Inject, don't entangle: edge-reco reaches SQLite only through
// @gainratio/browser/sql, imported only by the package seam (gainratio.ts) and
// used only by ONE module (engine/catalogueSql.ts).
// Nothing may load the sqlite3 build by file path. The single exception is the
// test-only in-process Worker (engine/__fixtures__/nodeSqlWorker.ts), because
// the library ships no Node entry for its SQL Worker; it may also import the
// published @gainratio/browser/sqlite entry for resolveMemoryProfile.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const PACKAGE = process.cwd();
const APP_SRC = join(PACKAGE, "../../app/src");
const SEAM = "src/gainratio.ts";
const SQL_USER = "src/engine/catalogueSql.ts";
const NODE_FIXTURE = "src/engine/__fixtures__/nodeSqlWorker.ts";
const SELF = "src/sqlBoundary.test.ts";

/** A quoted string that loads the SQLite build or reaches into a package dist. */
const RAW_SQLITE =
	/["'`][^"'`\n]*(?:sqlite3\.(?:mjs|wasm|js)|@sqlite\.org\/|node_modules\/@gainratio\/)[^"'`\n]*["'`]/u;
/** Opening or deleting a SQL database: the SQL surface catalogueSql.ts owns. */
const SQL_ENTRY =
	/\b(?:openSqlDatabase|removeOpfsPool|sqliteVectorPoolName)\b/u;
/** An import of the library's SQL / SQLite / vector-SQLite subpaths. */
const SQL_SUBPATH =
	/["']@gainratio\/browser\/(?:sql|sqlite|vector\/sqlite)(?:\/[^"']*)?["']/u;

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
	if (file !== SEAM && file !== NODE_FIXTURE && SQL_SUBPATH.test(text)) {
		found.push(`${file}: imports @gainratio/browser SQL outside ${SEAM}`);
	}
	const exempt = [SEAM, SQL_USER, NODE_FIXTURE];
	if (
		!exempt.includes(file) &&
		!/\.test\.ts$/u.test(file) &&
		SQL_ENTRY.test(text)
	) {
		found.push(`${file}: opens SQL outside ${SQL_USER}`);
	}
	return found;
}

describe("SQLite boundary", () => {
	it("flags a direct sqlite3 import and a second SQL importer", () => {
		expect(
			violations(
				"src/engine/vectorIndex.ts",
				'import init from "../../node_modules/@gainratio/browser/dist/vector/sqlite/assets/sqlite3.mjs";',
			),
		).toHaveLength(1);
		expect(
			violations(
				"src/engine/searchEngine.ts",
				'import { openSqlDatabase } from "@gainratio/browser/sql";',
			),
		).toHaveLength(2);
		expect(
			violations(
				"src/engine/searchEngine.ts",
				'import { openSqlDatabase } from "../gainratio";',
			),
		).toEqual([
			"src/engine/searchEngine.ts: opens SQL outside src/engine/catalogueSql.ts",
		]);
		expect(
			violations(SQL_USER, 'import { openSqlDatabase } from "../gainratio";'),
		).toEqual([]);
		expect(
			violations(SEAM, 'import { x } from "@gainratio/browser/sql";'),
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

	it("keeps the seam the one importer of @gainratio/browser/sql", () => {
		const seam = readFileSync(join(PACKAGE, SEAM), "utf8");
		expect(seam).toContain('from "@gainratio/browser/sql"');
	});
});
