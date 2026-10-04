// Node-only test helpers (Vitest): load the REAL committed signed bundle that
// ships INSIDE this package (__fixtures__/bundle/, a verbatim copy of edge-reco's
// examples/catalog + the pinned public key) so the unit tests prove byte-parity
// with the Python producer against a self-contained fixture — the package's
// Vitest suite needs no repo-root files. The node reference scopes Node types to
// this test-only file without leaking them into runtime code.

/// <reference types="node" />

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IndexManifest, VersionPointer } from "../gainratio";

const HERE = dirname(fileURLToPath(import.meta.url));
const DECODER = new TextDecoder();
// src/engine -> __fixtures__/bundle: the package-local copy of the signed bundle.
const BUNDLE = join(HERE, "__fixtures__", "bundle");
const EXAMPLES = BUNDLE;
const CATALOG = join(BUNDLE, "catalog");

export function pubkeyRaw(): Uint8Array {
	return new Uint8Array(readFileSync(join(EXAMPLES, "keys", "public.key")));
}

export function latestBytes(): Uint8Array {
	return new Uint8Array(readFileSync(join(CATALOG, "latest")));
}

export function manifestBytes(hash: string): Uint8Array {
	return new Uint8Array(readFileSync(join(CATALOG, "manifest", hash)));
}

export function chunkBytes(hash: string): Uint8Array {
	return new Uint8Array(readFileSync(join(CATALOG, "chunk", hash)));
}

/** The active manifest of the committed bundle (latest pointer -> manifest). */
function activeManifest(): IndexManifest {
	const pointer = JSON.parse(DECODER.decode(latestBytes())) as VersionPointer;
	return JSON.parse(
		DECODER.decode(manifestBytes(pointer.manifest_hash)),
	) as IndexManifest;
}

/**
 * The chunk hash backing catalog_meta.json in the committed bundle — derived from
 * the manifest, never hardcoded, so it survives every catalog rebuild. Used by the
 * content-addressing tests that need one known-good real chunk.
 */
export function catalogMetaChunkHash(): string {
	const meta = activeManifest().files.find(
		(file) => file.path === "catalog_meta.json",
	);
	const hash = meta?.chunks[0]?.hash;
	if (hash === undefined) {
		throw new Error("catalog_meta.json chunk missing from the bundle manifest");
	}
	return hash;
}

/**
 * Every (hash, signed uncompressed size) pair in the committed bundle manifest,
 * so a test can assert a property across the WHOLE bundle rather than one chunk.
 */
export function signedChunkRefs(): ReadonlyArray<{
	readonly hash: string;
	readonly size: number;
}> {
	return activeManifest().files.flatMap((file) => file.chunks);
}

/** Signed uncompressed byte length for {@link catalogMetaChunkHash}. */
export function catalogMetaChunkSize(): number {
	const meta = activeManifest().files.find(
		(file) => file.path === "catalog_meta.json",
	);
	const size = meta?.chunks[0]?.size;
	if (size === undefined) {
		throw new Error("catalog_meta.json chunk size missing from the manifest");
	}
	return size;
}

/**
 * A `FetchBytes` adapter backed by the real catalog files, so the sync state
 * machine runs end-to-end without a network. Counts requests for assertions.
 */
export function catalogFetch(): {
	readonly fetchBytes: (url: string) => Promise<Uint8Array>;
	chunkRequests: () => ReadonlyArray<string>;
} {
	const chunkUrls: string[] = [];
	const fetchBytes = (url: string): Promise<Uint8Array> => {
		if (url.endsWith("/latest")) {
			return Promise.resolve(latestBytes());
		}
		const manifestMatch = url.match(/\/manifest\/([0-9a-f]+)$/);
		if (manifestMatch?.[1] !== undefined) {
			return Promise.resolve(manifestBytes(manifestMatch[1]));
		}
		const chunkMatch = url.match(/\/chunk\/([0-9a-f]+)$/);
		if (chunkMatch?.[1] !== undefined) {
			chunkUrls.push(chunkMatch[1]);
			return Promise.resolve(chunkBytes(chunkMatch[1]));
		}
		return Promise.reject(new Error(`unexpected url ${url}`));
	};
	return { fetchBytes, chunkRequests: () => chunkUrls };
}
