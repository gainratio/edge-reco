import {
	deriveKeyId,
	KEYRING_SCHEMA,
	parseTrustRoot,
} from "@gainratio/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import fixture from "./__fixtures__/ranking_proof_v1.json" with {
	type: "json",
};
import { pubkeyRaw } from "./fixtures";
import { DEFAULT_RANKING_CONFIG } from "./rankingConfig";
import {
	defaultRuntimeDeps,
	type EnginePort,
	type RuntimeDeps,
	readRankingProofEvidence,
} from "./runtime";

const ENCODER = new TextEncoder();
const PUBLIC_KEY_URL = "https://shop.example/public.key";

function hexBytes(hex: string): Uint8Array {
	return Uint8Array.from(hex.match(/.{2}/gu) ?? [], (byte) =>
		Number.parseInt(byte, 16),
	);
}

function port(): EnginePort {
	return {
		sync: () => Promise.reject(new Error("not used")),
		readFile: (path) =>
			path === "ranking_receipt.json"
				? Promise.resolve(ENCODER.encode(JSON.stringify(fixture)))
				: Promise.reject(new Error(`unexpected path ${path}`)),
	};
}

describe("runtime ranking proof", () => {
	it("reads the signed bundle receipt and verifies it under the pinned app key", async () => {
		const loadPublisherKey = vi.fn(() =>
			Promise.resolve(hexBytes(fixture.public_key)),
		);

		const evidence = await readRankingProofEvidence(
			port(),
			DEFAULT_RANKING_CONFIG,
			PUBLIC_KEY_URL,
			loadPublisherKey,
		);

		expect(loadPublisherKey).toHaveBeenCalledWith(PUBLIC_KEY_URL);
		expect(evidence.status).toBe("verified");
	});

	it("keeps bootstrap evidence available when the pinned key cannot load", async () => {
		const loadPublisherKey: NonNullable<RuntimeDeps["loadPublisherKey"]> = () =>
			Promise.reject(new Error("offline"));

		const evidence = await readRankingProofEvidence(
			port(),
			DEFAULT_RANKING_CONFIG,
			PUBLIC_KEY_URL,
			loadPublisherKey,
		);

		expect(evidence).toEqual({
			status: "unavailable",
			publisherSignature: "not_checked",
			configHash: "not_checked",
			reason: "key_unavailable",
		});
	});
});

/** A second, unrelated 32-byte key: parseTrustRoot checks ids, not curve points. */
const OTHER_KEY = new Uint8Array(32).fill(0x11);

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
		"",
	);
}

/** An `edgeproc.keyring/v1` trust-root document, as the sync Worker reads it. */
async function keyringBytes(
	keys: ReadonlyArray<Uint8Array>,
	revoked: ReadonlyArray<Uint8Array> = [],
): Promise<Uint8Array> {
	const entries = await Promise.all(
		keys.map(async (key) => ({
			key_id: await deriveKeyId(key),
			public_key: hex(key),
		})),
	);
	const revokedIds = await Promise.all(revoked.map((key) => deriveKeyId(key)));
	return ENCODER.encode(
		JSON.stringify({
			schema: KEYRING_SCHEMA,
			keys: entries,
			revoked: revokedIds,
		}),
	);
}

function proofUnder(trustRoot: Uint8Array) {
	return readRankingProofEvidence(
		port(),
		DEFAULT_RANKING_CONFIG,
		PUBLIC_KEY_URL,
		() => Promise.resolve(trustRoot),
	);
}

describe("runtime ranking proof — the trust root the sync Worker pins", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("the committed pinned trust root is one the shared parser accepts", async () => {
		// The sync Worker and the ranking proof must read ONE trust-root format:
		// whatever public.key is, upstream parseTrustRoot has to accept it.
		const raw = pubkeyRaw();
		const keyring = await parseTrustRoot(raw);
		expect(keyring.keys.map((key) => hex(key.publicKey))).toEqual([hex(raw)]);
		expect(keyring.revoked).toEqual([]);
	});

	it("verifies the proof under an edgeproc.keyring/v1 trust root that lists the signer", async () => {
		const evidence = await proofUnder(
			await keyringBytes([OTHER_KEY, hexBytes(fixture.public_key)]),
		);
		expect(evidence.status).toBe("verified");
	});

	it("refuses a proof whose signer the keyring has revoked", async () => {
		const signer = hexBytes(fixture.public_key);
		const evidence = await proofUnder(
			await keyringBytes([OTHER_KEY, signer], [signer]),
		);
		expect(evidence).toMatchObject({
			status: "failed",
			reason: "signature_invalid",
		});
	});

	it("refuses a proof signed by a key the keyring does not list", async () => {
		const evidence = await proofUnder(await keyringBytes([OTHER_KEY]));
		expect(evidence).toMatchObject({
			status: "failed",
			reason: "signature_invalid",
		});
	});

	it("reports a malformed trust root as key_unavailable, never as verified", async () => {
		const evidence = await proofUnder(ENCODER.encode('{"schema":"nope"}'));
		expect(evidence).toMatchObject({
			status: "unavailable",
			reason: "key_unavailable",
		});
	});

	it("the default loader reads a keyring-sized trust root, not just 32 bytes", async () => {
		const body = await keyringBytes([hexBytes(fixture.public_key)]);
		expect(body.byteLength).toBeGreaterThan(32);
		vi.stubGlobal(
			"fetch",
			vi.fn(() =>
				Promise.resolve(
					new Response(new TextDecoder().decode(body), { status: 200 }),
				),
			),
		);
		const load = defaultRuntimeDeps().loadPublisherKey;
		if (load === undefined) throw new Error("expected a default loader");

		const loaded = await load(PUBLIC_KEY_URL);
		expect(new TextDecoder().decode(loaded)).toBe(
			new TextDecoder().decode(body),
		);
	});

	it("the default loader bypasses the HTTP cache, so a revoked key stops verifying on the next read", async () => {
		// Upstream `loadTrustRoot` reads the trust root with `cache: "no-store"`.
		// `force-cache` here let a keyring that has since REVOKED a key keep
		// verifying the ranking proof under that key until the cached copy
		// expired — the revocation reached the sync Worker but not the proof panel.
		const body = await keyringBytes([hexBytes(fixture.public_key)]);
		const fetchSpy = vi.fn((_url: string, _init?: RequestInit) =>
			Promise.resolve(
				new Response(new TextDecoder().decode(body), { status: 200 }),
			),
		);
		vi.stubGlobal("fetch", fetchSpy);
		const load = defaultRuntimeDeps().loadPublisherKey;
		if (load === undefined) throw new Error("expected a default loader");

		await load(PUBLIC_KEY_URL);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(fetchSpy.mock.calls[0]?.[1]?.cache).toBe("no-store");
	});
});
