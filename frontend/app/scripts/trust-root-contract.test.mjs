import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { parseTrustRoot } from "@gainratio/browser";

/**
 * ONE trust root, read ONE way.
 *
 * The pinned trust root ships in three committed copies: the one the SPA serves
 * (`frontend/app/public/public.key`), the publisher's (`backend/examples/keys/`),
 * and the browser package's self-contained test fixture. The sync Worker reads
 * the served copy with `@gainratio/browser`'s `loadTrustRoot` → `parseTrustRoot`
 * (a raw 32-byte Ed25519 key OR an `edgeproc.keyring/v1` JSON keyring), and the
 * ranking-proof check reads it with the same `parseTrustRoot`.
 *
 * So a key change can't leave the copies disagreeing (the app would pin one key
 * while the publisher signs with another) or leave a trust root that the
 * shared parser rejects (every visitor's sync would refuse). Rotate by editing
 * all three together — ideally to a keyring, never by silently swapping bytes.
 */
const REPO = resolve(import.meta.dirname, "..", "..", "..");
const COPIES = [
	join(REPO, "frontend", "app", "public", "public.key"),
	join(REPO, "backend", "examples", "keys", "public.key"),
	join(
		REPO,
		"frontend",
		"packages",
		"edgereco-browser",
		"src",
		"engine",
		"__fixtures__",
		"bundle",
		"keys",
		"public.key",
	),
];

test("every committed copy of the pinned trust root is byte-identical", async () => {
	const [served, ...others] = await Promise.all(
		COPIES.map((path) => readFile(path)),
	);
	for (const [index, copy] of others.entries()) {
		assert.ok(
			served.equals(copy),
			`${COPIES[index + 1]} differs from the served ${COPIES[0]}`,
		);
	}
});

test("the served trust root parses with the sync Worker's own parser", async () => {
	const keyring = await parseTrustRoot(
		new Uint8Array(await readFile(COPIES[0])),
	);
	assert.ok(keyring.keys.length >= 1, "the trust root pins at least one key");
	const revoked = new Set(keyring.revoked);
	assert.ok(
		keyring.keys.some((key) => !revoked.has(key.keyId)),
		"at least one pinned key is unrevoked",
	);
});
