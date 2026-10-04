/// <reference types="node" />
// Inject, don't entangle: each package reaches @gainratio/browser through ONE
// seam file it owns. Upgrading, renaming or swapping the library then touches
// one file per package:
//
//   @edgereco/browser   src/gainratio.ts
//   the Nimbus app      app/src/gainratio.ts
//
// Tests, test setup and __fixtures__ may import the library directly (they
// drive its real Worker handler in-process); production code may not.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const PACKAGE = process.cwd();
const APP_SRC = join(PACKAGE, "../../app/src");
const PACKAGE_SEAM = "src/gainratio.ts";
const APP_SEAM = "../../app/src/gainratio.ts";
/** Spelled once, so this file's own fixtures stay out of sqlBoundary's scan. */
const LIBRARY = "@gainratio/browser";

/** Any static, re-export, side-effect or dynamic import of the library. */
const IMPORTS_LIBRARY =
	/\b(?:from|import)\s*\(?\s*["']@gainratio\/browser(?:\/[^"']*)?["']/u;

/** Test-only files: specs, the two Vitest setup files, and fixtures. */
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

/** The rule for one file, given its package-relative path and text. */
function violates(file: string, text: string): boolean {
	if (file === PACKAGE_SEAM || file === APP_SEAM || isTestOnly(file)) {
		return false;
	}
	return IMPORTS_LIBRARY.test(text);
}

describe("@gainratio/browser seam boundary", () => {
	it("flags every import form outside the seams, and only there", () => {
		const file = "src/engine/runtime.ts";
		expect(violates(file, 'import { x } from "@gainratio/browser";')).toBe(
			true,
		);
		expect(violates(file, 'import "@gainratio/browser/worker";')).toBe(true);
		expect(violates(file, 'export type { X } from "@gainratio/browser";')).toBe(
			true,
		);
		expect(violates(file, `await import("${LIBRARY}/sql");`)).toBe(true);
		expect(
			violates(file, "// composed over @gainratio/browser's SQL Worker"),
		).toBe(false);
		expect(violates(PACKAGE_SEAM, 'from "@gainratio/browser"')).toBe(false);
		expect(violates(APP_SEAM, 'from "@gainratio/browser"')).toBe(false);
		expect(violates("src/engine/x.test.ts", 'from "@gainratio/browser"')).toBe(
			false,
		);
	});

	it("holds across the engine package and the app", () => {
		const files = [...sources(join(PACKAGE, "src")), ...sources(APP_SRC)];
		expect(files.length).toBeGreaterThan(20);
		const offenders = files
			.map((path) => relative(PACKAGE, path))
			.filter((file) =>
				violates(file, readFileSync(join(PACKAGE, file), "utf8")),
			);
		expect(offenders).toEqual([]);
	});

	it("routes both packages through a seam that really imports the library", () => {
		for (const seam of [PACKAGE_SEAM, APP_SEAM]) {
			expect(readFileSync(join(PACKAGE, seam), "utf8")).toMatch(
				IMPORTS_LIBRARY,
			);
		}
	});
});
