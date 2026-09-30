// The browser mirror of edge-reco's reco/cooccurrence.py CooccurrenceMatrix:
// the signed bundle's cooccurrence.json is read through the SAME verified sync
// path as ranking_config.json. Parse the committed bundle's file (round-trip) and
// confirm an absent file degrades to an empty matrix (older bundles).

import type { IndexManifest, Verify } from "@edgeproc/browser";
import {
	MemoryCacheStore,
	materializeFile,
	syncIndex,
} from "@edgeproc/browser";
import { describe, expect, it } from "vitest";
import {
	type CooccurrenceMatrix,
	EMPTY_COOCCURRENCE,
	parseCooccurrence,
} from "./cooccurrence";
import { catalogFetch } from "./fixtures";

const acceptVerify: Verify = () => Promise.resolve();
const DECODER = new TextDecoder();

/** Read cooccurrence.json out of the committed bundle via the verified path. */
async function syncedCooccurrenceBytes(): Promise<Uint8Array> {
	const store = new MemoryCacheStore();
	const { fetchBytes } = catalogFetch();
	const result = await syncIndex({
		baseUrl: "/cat",
		store,
		fetchBytes,
		verify: acceptVerify,
	});
	const manifest = JSON.parse(
		DECODER.decode(await store.getManifest(result.manifestHash)),
	) as IndexManifest;
	return materializeFile(store, manifest, "cooccurrence.json");
}

describe("parseCooccurrence", () => {
	it("parses the committed bundle's cooccurrence.json (round-trip)", async () => {
		const bytes = await syncedCooccurrenceBytes();
		const matrix = parseCooccurrence(bytes);
		// The signed file carries a schema_version + a per-product neighbour map.
		expect(matrix.schema_version).toBe(1);
		expect(Object.keys(matrix.neighbors).length).toBeGreaterThan(0);
		// The fixed parity seed has a top-N neighbour list of {id, score} pairs.
		const seed = matrix.neighbors["NB-00593"];
		expect(seed).toBeDefined();
		expect(seed?.length).toBeGreaterThan(0);
		expect(seed?.[0]).toEqual(
			expect.objectContaining({
				id: expect.any(String),
				score: expect.any(Number),
			}),
		);
		// Round-trips byte-for-byte through JSON.
		const reparsed = JSON.parse(DECODER.decode(bytes)) as CooccurrenceMatrix;
		expect(matrix).toEqual(reparsed);
	});

	it("falls back to an empty matrix when the file is absent (older bundle)", () => {
		expect(parseCooccurrence(undefined)).toEqual(EMPTY_COOCCURRENCE);
		expect(parseCooccurrence(undefined).neighbors).toEqual({});
	});
});

/**
 * A corrupt-but-signed cooccurrence.json must fail CLOSED. A neighbour with a
 * missing id, a non-string id, or a non-finite score would feed NaN into the
 * scorer's cooccurrence term and diverge from the Python tier — so it must THROW,
 * never silently degrade (absent ≠ malformed).
 */
describe("parseCooccurrence fail-closed validation", () => {
	function encode(value: unknown): Uint8Array {
		return new TextEncoder().encode(JSON.stringify(value));
	}

	it("throws on non-JSON bytes", () => {
		expect(() => parseCooccurrence(new TextEncoder().encode("}{"))).toThrow();
	});

	it("throws when schema_version is not a number", () => {
		const bad = { schema_version: "1", neighbors: {} };
		expect(() => parseCooccurrence(encode(bad))).toThrow(/schema_version/);
	});

	it("throws when neighbors is not an object", () => {
		const bad = { schema_version: 1, neighbors: [] };
		expect(() => parseCooccurrence(encode(bad))).toThrow(/neighbors/);
	});

	it("throws when a neighbor is missing its id", () => {
		const bad = { schema_version: 1, neighbors: { A: [{ score: 0.5 }] } };
		expect(() => parseCooccurrence(encode(bad))).toThrow(/id/);
	});

	it("throws when a neighbor's id is not a string", () => {
		const bad = {
			schema_version: 1,
			neighbors: { A: [{ id: 7, score: 0.5 }] },
		};
		expect(() => parseCooccurrence(encode(bad))).toThrow();
	});

	it("throws when a neighbor's score is non-finite", () => {
		// A producer bug would serialize a NaN score as JSON null.
		const bad = {
			schema_version: 1,
			neighbors: { A: [{ id: "B", score: null }] },
		};
		expect(() => parseCooccurrence(encode(bad))).toThrow(/score/);
	});

	it("throws when a neighbor list is not an array", () => {
		const bad = {
			schema_version: 1,
			neighbors: { A: { id: "B", score: 0.5 } },
		};
		expect(() => parseCooccurrence(encode(bad))).toThrow();
	});
});
