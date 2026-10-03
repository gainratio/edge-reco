import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";

/**
 * `@gainratio/errors` (formerly `@edgeproc/errors`) — the portfolio's canonical-errors library — is a SHARED
 * library consumed from npm, not a copy living in this repo.
 *
 * This repo used to carry a fork of it at `frontend/packages/edgeproc-errors/`.
 * A fork cannot be upgraded, so it silently rots: by the time it was removed it
 * was pinned at `0.1.0-dev` against a published `0.1.1`, sat 408 source lines
 * behind upstream, and was missing 8 exports the library had since grown
 * (`corePack`, `aiPack`, `bundlePack`, `defineErrorsWith`, `DEFAULT_FALLBACK_CODE`,
 * `UnregisteredFallbackError`, `KnownCategory`, `RegistryOptions`). Nothing was
 * red the whole time, because nothing was measuring it.
 *
 * These are the three ways that regression can come back, each checked directly:
 *
 *   1. the declared dependency reverts to a local protocol (`workspace:`, `link:`, ...)
 *   2. a fork of the library reappears under `frontend/packages/`
 *   3. the RESOLVED package is not the published artifact
 *
 * (3) is the one that matters most, and it is why this test reads
 * `node_modules` rather than stopping at `package.json`. A manifest declaring
 * `^0.1.1` proves only what we asked for; an override, a stale link, or a
 * re-introduced fork can still put something else on disk. The property is
 * "the published package is what the app actually loads", so that is what gets
 * asserted.
 *
 * `@edgereco/browser` is deliberately NOT covered here: it is a first-party
 * package that belongs to this repo and is meant to live under
 * `frontend/packages/`. Only the shared, separately-published library is
 * constrained.
 */

const PACKAGE_NAME = "@gainratio/errors";
const APP_MANIFEST = resolve(import.meta.dirname, "../package.json");
const PACKAGES_DIR = resolve(import.meta.dirname, "../../packages");
const INSTALLED_MANIFEST = resolve(
	import.meta.dirname,
	"../node_modules/@gainratio/errors/package.json",
);

/** pnpm specifiers that resolve to something inside this checkout rather than the registry. */
const LOCAL_PROTOCOLS = ["workspace:", "link:", "file:", "portal:"];

/** True when the specifier asks the registry for the package. */
function isRegistrySpecifier(spec) {
	return (
		typeof spec === "string" &&
		spec.length > 0 &&
		!LOCAL_PROTOCOLS.some((protocol) => spec.startsWith(protocol))
	);
}

/**
 * True when a manifest describes a real published release. A vendored fork is
 * caught by either half: it marks itself `private` so it can never be published,
 * and it carries a non-release version like `0.1.0-dev`.
 */
function isPublishedManifest(manifest) {
	return (
		manifest?.private !== true &&
		/^\d+\.\d+\.\d+$/u.test(manifest?.version ?? "")
	);
}

/** Numeric floor comparison for a `^x.y.z` / `~x.y.z` / bare `x.y.z` range. */
function satisfiesFloor(version, spec) {
	const parse = (value) => {
		const match = /(\d+)\.(\d+)\.(\d+)/u.exec(value ?? "");
		return match ? match.slice(1, 4).map(Number) : null;
	};
	const [actual, floor] = [parse(version), parse(spec)];
	if (!actual || !floor) return false;
	for (let i = 0; i < 3; i += 1) {
		if (actual[i] !== floor[i]) return actual[i] > floor[i];
	}
	return true;
}

async function readJson(path) {
	return JSON.parse(await readFile(path, "utf8"));
}

async function declaredSpecifier() {
	const manifest = await readJson(APP_MANIFEST);
	return manifest.dependencies?.[PACKAGE_NAME];
}

/** Every package name declared by a workspace package under `frontend/packages/`. */
async function vendoredPackageNames(packagesDir) {
	if (!existsSync(packagesDir)) return [];
	const entries = await readdir(packagesDir, { withFileTypes: true });
	const names = await Promise.all(
		entries
			.filter((entry) => entry.isDirectory())
			.map(async (entry) => {
				const manifest = join(packagesDir, entry.name, "package.json");
				if (!existsSync(manifest)) return null;
				return (await readJson(manifest)).name ?? null;
			}),
	);
	return names.filter((name) => name !== null);
}

test(`${PACKAGE_NAME} is declared as a registry dependency, not a local path`, async () => {
	const spec = await declaredSpecifier();
	assert.ok(
		spec !== undefined,
		`${PACKAGE_NAME} is missing from app/package.json dependencies.`,
	);
	assert.ok(
		isRegistrySpecifier(spec),
		`${PACKAGE_NAME} is declared as "${spec}", which resolves inside this checkout. ` +
			"It is a published library — depend on a registry version so upgrades and " +
			"provenance apply. Re-vendoring it is how it rotted 408 lines behind before.",
	);
});

test(`no fork of ${PACKAGE_NAME} exists under frontend/packages/`, async () => {
	const names = await vendoredPackageNames(PACKAGES_DIR);
	assert.ok(
		!names.includes(PACKAGE_NAME),
		`A workspace package under frontend/packages/ declares itself "${PACKAGE_NAME}". ` +
			"That is a fork of a published library and cannot be upgraded — delete it and " +
			"depend on the npm release instead.",
	);
});

test(`the installed ${PACKAGE_NAME} is the published artifact`, async () => {
	assert.ok(
		existsSync(INSTALLED_MANIFEST),
		`${PACKAGE_NAME} is not installed. Run \`pnpm install\` in frontend/ first.`,
	);
	const [installed, spec] = await Promise.all([
		readJson(INSTALLED_MANIFEST),
		declaredSpecifier(),
	]);
	assert.equal(installed.name, PACKAGE_NAME);
	assert.ok(
		isPublishedManifest(installed),
		`The resolved ${PACKAGE_NAME} is version "${installed.version}"` +
			`${installed.private === true ? " and is marked private" : ""} — that is not a ` +
			"published release. Something in this checkout is shadowing the npm package.",
	);
	assert.ok(
		satisfiesFloor(installed.version, spec),
		`Resolved ${PACKAGE_NAME}@${installed.version} is below the declared floor "${spec}".`,
	);
});

// --- the guards above are only evidence if they can fail; these prove each one fires ---

test("the specifier guard rejects every local protocol", () => {
	for (const spec of [
		"workspace:*",
		"workspace:^0.1.1",
		"link:../packages/edgeproc-errors",
		"file:../packages/edgeproc-errors",
		"portal:../packages/edgeproc-errors",
	]) {
		assert.equal(isRegistrySpecifier(spec), false, spec);
	}
	for (const spec of ["^0.1.1", "0.1.1", "~0.1.1", ">=0.1.1 <0.2.0"]) {
		assert.equal(isRegistrySpecifier(spec), true, spec);
	}
});

test("the published-artifact guard rejects a vendored fork's manifest", () => {
	// Verbatim shape of the manifest this repo used to carry.
	assert.equal(
		isPublishedManifest({ private: true, version: "0.1.0-dev" }),
		false,
	);
	assert.equal(isPublishedManifest({ version: "0.1.0-dev" }), false);
	assert.equal(isPublishedManifest({ private: true, version: "0.1.1" }), false);
	assert.equal(isPublishedManifest({ version: "0.1.1" }), true);
});

test("the floor guard rejects a resolution below the declared range", () => {
	assert.equal(satisfiesFloor("0.1.0", "^0.1.1"), false);
	assert.equal(satisfiesFloor("0.0.9", "^0.1.1"), false);
	assert.equal(satisfiesFloor("0.1.1", "^0.1.1"), true);
	assert.equal(satisfiesFloor("0.2.0", "^0.1.1"), true);
	assert.equal(satisfiesFloor("1.0.0", "^0.1.1"), true);
	assert.equal(satisfiesFloor(undefined, "^0.1.1"), false);
});

test("the fork guard reads declared package names, not directory names", async () => {
	// A rename of the directory must not launder a fork past the guard, so the
	// guard reads each workspace package's declared `name`.
	const names = await vendoredPackageNames(PACKAGES_DIR);
	assert.ok(
		names.every((name) => typeof name === "string" && name.startsWith("@")),
		`unexpected workspace package names: ${JSON.stringify(names)}`,
	);
	assert.deepEqual(await vendoredPackageNames("/nonexistent-packages-dir"), []);
});
