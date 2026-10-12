import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	checkTree,
	entryViolations,
	manifestViolations,
} from "./check-own-deps.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FRONTEND = resolve(HERE, "../..");

test("accepts our library from npm with a caret range", () => {
	assert.deepEqual(entryViolations("@gainratio/browser", "^0.2.0"), []);
	assert.deepEqual(entryViolations("@edgereco/browser", "workspace:*"), []);
	assert.deepEqual(entryViolations("react", "^19.3.0"), []);
});

test("REJECTS the git-sha alias this repo used before (#148)", () => {
	const found = entryViolations(
		"@edgeproc/browser",
		"github:hseshadr/edgeproc-browser#25cdad0356d879799faaed57dd006582313084e6",
	);
	assert.equal(found.length, 2);
	assert.match(found[0], /retired @edgeproc\/ scope/);
	assert.match(found[1], /from GitHub/);
});

test("REJECTS a @gainratio package pulled from GitHub in any spec form", () => {
	for (const spec of [
		"github:hseshadr/edgeproc-browser#abc123",
		"hseshadr/edgeproc-browser#abc123",
		"git+https://github.com/hseshadr/edgeproc-browser.git#abc123",
		"https://github.com/hseshadr/edgeproc-browser/tarball/abc123",
		"git+https://github.com/someone-else/fork.git",
	]) {
		assert.equal(
			entryViolations("@gainratio/browser", spec).length,
			1,
			`${spec} must be rejected`,
		);
	}
});

test("REJECTS our library from GitHub under either owner, whatever its name", () => {
	for (const spec of [
		"github:gainratio/edgeproc-browser#abc123",
		"gainratio/edgeproc-browser#abc123",
		"git+https://github.com/gainratio/edgeproc-browser.git#abc123",
		"github:hseshadr/edgeproc-browser#abc123",
	]) {
		const found = entryViolations("edgeproc-browser", spec);
		assert.equal(found.length, 1, `${spec} must be rejected`);
		assert.match(found[0], /from GitHub/);
	}
	assert.deepEqual(
		entryViolations("x", "github:gainratio-evil/edgeproc-browser"),
		[],
	);
});

test("REJECTS an npm alias onto the retired scope", () => {
	assert.equal(
		entryViolations("browser", "npm:@edgeproc/browser@0.5.0").length,
		1,
	);
});

test("checks every dependency field and names the file", () => {
	const found = manifestViolations("packages/x/package.json", {
		devDependencies: { "@edgeproc/avow": "^0.5.1" },
		peerDependencies: { "@gainratio/errors": "github:hseshadr/errors" },
	});
	assert.equal(found.length, 2);
	assert.match(found[0], /devDependencies @edgeproc\/avow/);
	assert.match(found[1], /peerDependencies @gainratio\/errors/);
	assert.ok(found.every((line) => line.startsWith("packages/x/package.json ")));
});

test("this workspace's package.json files are clean", () => {
	assert.deepEqual(checkTree(FRONTEND), []);
});

test("the CLI exits 0 on this workspace", () => {
	const run = spawnSync(process.execPath, [join(HERE, "check-own-deps.mjs")], {
		encoding: "utf8",
	});
	assert.equal(run.status, 0, run.stderr);
});
