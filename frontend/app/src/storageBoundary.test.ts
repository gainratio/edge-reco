/// <reference types="node" />
// SQLite is the ONLY store for app data. No localStorage, no IndexedDB.
//
// This scans every non-test source file in the app and in @edgereco/browser.
// A file may name localStorage, sessionStorage or indexedDB only if it is on
// the allow-list below, and only with the operations listed for it:
//
//   App.tsx           sessionStorage get/set of the per-tab "launched" flag,
//                     so a reload skips the landing page. A UI flag, not data.
//   legacyStorage.ts  localStorage.removeItem only: retires the keys older
//                     builds wrote (session id, uplink queue).
//   cacheFloor.ts     indexedDB.deleteDatabase only: the explicit "clear saved
//                     catalog" recovery deletes @gainratio/browser's rollback
//                     floor. It deletes; it never writes.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const APP = process.cwd();
const ROOTS = [join(APP, "src"), join(APP, "../packages/edgereco-browser/src")];

const STORAGE_API = /\b(localStorage|sessionStorage|indexedDB)\b/gu;

interface Allowance {
	readonly api: string;
	/** Member calls allowed on that API; anything else is a violation. */
	readonly calls: ReadonlyArray<string>;
}

const ALLOWED: Readonly<Record<string, Allowance>> = {
	"src/App.tsx": { api: "sessionStorage", calls: ["getItem", "setItem"] },
	"src/signals/legacyStorage.ts": {
		api: "localStorage",
		calls: ["removeItem"],
	},
	"../packages/edgereco-browser/src/engine/cacheFloor.ts": {
		api: "indexedDB",
		calls: ["deleteDatabase"],
	},
};

function isTestOnly(file: string): boolean {
	return (
		/\.test\.tsx?$/u.test(file) ||
		/(?:^|\/)(?:testSetup|test-setup)\.ts$/u.test(file) ||
		file.includes("/__fixtures__/")
	);
}

function sources(directory: string): string[] {
	return readdirSync(directory).flatMap((name) => {
		const path = join(directory, name);
		if (statSync(path).isDirectory()) {
			return name === "node_modules" ? [] : sources(path);
		}
		return /\.tsx?$/u.test(name) ? [path] : [];
	});
}

/** Drop comments so prose about storage never trips the scan. */
function code(text: string): string {
	return text
		.replace(/\/\*[\s\S]*?\*\//gu, "")
		.replace(/(^|\s)\/\/.*$/gmu, "$1");
}

/** Every rule violation in one file, given its app-relative path. */
function violations(file: string, text: string): string[] {
	if (isTestOnly(file)) {
		return [];
	}
	const body = code(text);
	const found: string[] = [];
	for (const match of body.matchAll(STORAGE_API)) {
		const api = match[1] ?? "";
		const allowance = ALLOWED[file];
		if (allowance === undefined || allowance.api !== api) {
			found.push(`${file}: uses ${api} (SQLite is the only store)`);
			continue;
		}
		const before = body.slice(0, match.index ?? 0);
		if (/\btypeof\s*$/u.test(before)) {
			continue; // a feature check reads nothing and writes nothing
		}
		const after = body.slice((match.index ?? 0) + api.length);
		const call = /^\s*\??\.\s*([A-Za-z_$][\w$]*)/u.exec(after)?.[1];
		if (call === undefined || !allowance.calls.includes(call)) {
			found.push(`${file}: ${api}.${call ?? "<value>"} is not allowed`);
		}
	}
	return found;
}

describe("storage boundary: SQLite is the only store for app data", () => {
	it("flags localStorage and indexedDB writes outside the allow-list", () => {
		expect(
			violations("src/x.ts", 'localStorage.setItem("k", "v");'),
		).toHaveLength(1);
		expect(
			violations("src/x.ts", 'const db = indexedDB.open("app");'),
		).toHaveLength(1);
		expect(
			violations("src/x.ts", "const s = window.sessionStorage;"),
		).toHaveLength(1);
		// Passing the object around hides its writes: also a violation.
		expect(
			violations("src/x.ts", "createQueue({ storage: window.localStorage });"),
		).toHaveLength(1);
		expect(violations("src/x.ts", 'globalThis["localStorage"]')).toHaveLength(
			1,
		);
	});

	it("allows only the listed operations inside allow-listed files", () => {
		const legacy = "src/signals/legacyStorage.ts";
		expect(
			violations(legacy, "globalThis.localStorage?.removeItem(key);"),
		).toEqual([]);
		expect(violations(legacy, 'localStorage.setItem("k", "v");')).toEqual([
			`${legacy}: localStorage.setItem is not allowed`,
		]);
		expect(violations(legacy, 'indexedDB.open("x");')).toHaveLength(1);
		expect(
			violations("src/App.tsx", 'localStorage.setItem("k", "v");'),
		).toHaveLength(1);
		expect(
			violations("src/App.tsx", 'sessionStorage.setItem(KEY, "1");'),
		).toEqual([]);
		const floor = "../packages/edgereco-browser/src/engine/cacheFloor.ts";
		expect(violations(floor, "indexedDB.deleteDatabase(name)")).toEqual([]);
		expect(violations(floor, 'indexedDB.open("floor")')).toHaveLength(1);
		expect(violations(floor, 'typeof indexedDB === "undefined"')).toEqual([]);
		expect(
			violations(floor, "deleteDatabaseBounded(indexedDB, n)"),
		).toHaveLength(1);
	});

	it("ignores comments and test files", () => {
		expect(violations("src/x.ts", "// never use localStorage here")).toEqual(
			[],
		);
		expect(violations("src/x.ts", "/* indexedDB is banned */")).toEqual([]);
		expect(
			violations("src/x.test.ts", 'localStorage.setItem("k", "v");'),
		).toEqual([]);
	});

	it("holds across the app and the engine package", () => {
		const files = ROOTS.flatMap(sources);
		expect(files.length).toBeGreaterThan(40);
		const found = files.flatMap((path) =>
			violations(relative(APP, path), readFileSync(path, "utf8")),
		);
		expect(found).toEqual([]);
	});

	it("keeps every allow-listed file real (a stale entry hides nothing)", () => {
		for (const file of Object.keys(ALLOWED)) {
			const text = code(readFileSync(join(APP, file), "utf8"));
			expect(text, file).toMatch(STORAGE_API);
		}
	});
});
