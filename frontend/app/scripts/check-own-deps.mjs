#!/usr/bin/env node
// Our own libraries come from npm, under @gainratio/*, with a semver range that
// tracks the latest release. This check FAILS the gate if any package.json in
// the frontend workspace still names the retired @edgeproc/ scope, or pulls one
// of our libraries from GitHub (a git-sha alias like
// "github:gainratio/edgeproc-browser#<sha>") instead of the registry.
//
//   node app/scripts/check-own-deps.mjs   (run from frontend/; exit 1 on a hit)

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEPENDENCY_FIELDS = [
	"dependencies",
	"devDependencies",
	"peerDependencies",
	"optionalDependencies",
];
const RETIRED_SCOPE = "@edgeproc/";
const OWN_SCOPE = "@gainratio/";
/** A git / GitHub source rather than a registry version. */
const GIT_SPEC =
	/^(?:github:|git\+|git:|git@|https?:\/\/(?:www\.)?github\.com\/)/u;
/**
 * Our GitHub owners, in any spec form ("gainratio/x", "github:gainratio/x", URLs).
 * gainratio is canonical; hseshadr stays until every library has moved to the org.
 */
const OWN_REPO = /(?:^|[:/])(?:gainratio|hseshadr)\//u;

/** Every rule a single dependency entry breaks, as human-readable strings. */
export function entryViolations(name, spec) {
	const found = [];
	if (name.startsWith(RETIRED_SCOPE) || spec.includes(RETIRED_SCOPE)) {
		found.push(`${name}: uses the retired ${RETIRED_SCOPE} scope`);
	}
	if (OWN_REPO.test(spec)) {
		found.push(`${name}: installs our library from GitHub (${spec})`);
	} else if (name.startsWith(OWN_SCOPE) && GIT_SPEC.test(spec)) {
		found.push(`${name}: installs our library from git (${spec})`);
	}
	return found;
}

/** Violations in one parsed package.json, prefixed with its path. */
export function manifestViolations(path, manifest) {
	return DEPENDENCY_FIELDS.flatMap((field) =>
		Object.entries(manifest[field] ?? {}).flatMap(([name, spec]) =>
			entryViolations(name, String(spec)).map((v) => `${path} ${field} ${v}`),
		),
	);
}

/** Every package.json under root, skipping node_modules and build output. */
export function findManifests(root) {
	return readdirSync(root).flatMap((name) => {
		const path = join(root, name);
		if (["node_modules", "dist", ".git"].includes(name)) return [];
		if (statSync(path).isDirectory()) return findManifests(path);
		return name === "package.json" ? [path] : [];
	});
}

export function checkTree(root) {
	return findManifests(root).flatMap((path) =>
		manifestViolations(
			relative(root, path),
			JSON.parse(readFileSync(path, "utf8")),
		),
	);
}

function main() {
	const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
	const found = checkTree(root);
	if (found.length > 0) {
		console.error(
			`check-own-deps: ${found.length} problem(s). Depend on @gainratio/* from npm with a caret range:`,
		);
		for (const line of found) console.error(`  ${line}`);
		process.exit(1);
	}
	console.log(
		`check-own-deps: ok (${findManifests(root).length} package.json files)`,
	);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
