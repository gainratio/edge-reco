// @vitest-environment node

import { describe, expect, it } from "vitest";
import { NetworkError, type SyncResult } from "../gainratio";
import { CatalogueDb, type ShardedSqliteInput } from "./catalogueDb";
import { openCatalogueSql } from "./catalogueSql";
import { DEFAULT_RANKING_CONFIG } from "./rankingConfig";
import { EngineRuntime, type RuntimeConfig } from "./runtime";
import { emptyProfile } from "./session";
import {
	openShardedCatalogueStore,
	ShardedCatalogueDb,
} from "./shardedCatalogueDb";

const DIM = 8;

async function buildShardImage(
	shardIdx: number,
	rowsPerShard: number,
	globalTotal?: number,
): Promise<{ readonly bytes: Uint8Array; readonly centroid: Float32Array }> {
	const sql = await openCatalogueSql();
	const db = await CatalogueDb.open(sql, DIM);
	const centroid = new Float32Array(DIM);
	centroid[shardIdx % DIM] = 1;
	for (let i = 0; i < rowsPerShard; i++) {
		const vec = new Float32Array(DIM);
		vec[shardIdx % DIM] = 1;
		vec[(shardIdx + 1) % DIM] = 0.05 * (i + 1);
		const norm = Math.hypot(...vec);
		for (let d = 0; d < DIM; d++) vec[d] = (vec[d] ?? 0) / norm;
		const pid =
			shardIdx === 0 && i === 0
				? "NB-0001-01"
				: `S${String(shardIdx).padStart(2, "0")}-P${i}`;
		const title =
			shardIdx === 2 && i === 0
				? "Merino Trail Cardigan"
				: `Shard ${shardIdx} Item ${i}`;
		const cat = i % 2 === 0 ? "Apparel" : "Shoes";
		await sql.query(
			"INSERT INTO products VALUES (?, ?, ?, 'desc', ?, 'hiking', '[\"hiking\"]', 'Peak', 42, 0.8, 0.9, '/images/x.jpg', ?)",
			[
				i,
				pid,
				title,
				cat,
				new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength),
			],
		);
	}
	await sql.exec("INSERT INTO products_fts(products_fts) VALUES ('rebuild');");
	await sql.query(
		`SELECT vector_init('products', 'embedding', 'dimension=${DIM},type=FLOAT32,distance=COSINE')`,
	);
	if (globalTotal !== undefined) {
		await sql.exec(
			"CREATE TABLE _edgereco_global_counts (category TEXT PRIMARY KEY, total INTEGER NOT NULL);",
		);
		await sql.query("INSERT INTO _edgereco_global_counts VALUES ('', ?)", [
			globalTotal,
		]);
		await sql.query(
			"INSERT INTO _edgereco_global_counts VALUES ('Apparel', ?)",
			[Math.ceil(globalTotal / 2)],
		);
	}
	const bytes = await sql.exportDatabase?.();
	await db.dispose();
	if (bytes === undefined) throw new Error("expected exportDatabase");
	return { bytes, centroid };
}

describe("ShardedCatalogueDb", () => {
	it("imports shard 0 on boot, routes queries across shards, fuses RRF, and caps extra open shards via LRU", async () => {
		const shardCount = 8;
		const rowsPerShard = 4;
		const globalTotal = shardCount * rowsPerShard;
		const built = await Promise.all(
			Array.from({ length: shardCount }, (_, s) =>
				buildShardImage(s, rowsPerShard, s === 0 ? globalTotal : undefined),
			),
		);
		const centroids = new Float32Array(shardCount * DIM);
		built.forEach((b, s) => {
			centroids.set(b.centroid, s * DIM);
		});
		const sharded: ShardedSqliteInput = {
			shardCount,
			centroids,
			shardChunks: (s) =>
				(async function* () {
					const bytes = built[s]?.bytes ?? new Uint8Array(0);
					if (s === 1) {
						const mid = Math.floor(bytes.byteLength / 2);
						yield bytes.subarray(0, mid);
						yield bytes.subarray(mid);
						return;
					}
					yield bytes;
				})(),
		};

		const store = await openShardedCatalogueStore({ dimension: DIM });
		await expect(
			store.importShardedSqlite?.(
				{ ...sharded, centroids: new Float32Array(3) },
				{ revisionKey: "rev-bad" },
			),
		).rejects.toThrow(RangeError);

		await store.importShardedSqlite?.(sharded, { revisionKey: "rev-v1" });

		// Global browse counts come from _edgereco_global_counts on shard 0
		const allBrowse = await store.browseSql?.({ limit: 10 });
		expect(allBrowse?.total).toBe(globalTotal);
		const catBrowse = await store.browseSql?.({
			category: "Apparel",
			limit: 10,
		});
		expect(catBrowse?.total).toBe(Math.ceil(globalTotal / 2));

		const pool = await store.candidatePoolSql?.(
			"popularity",
			3,
			emptyProfile(),
			DEFAULT_RANKING_CONFIG.scoring_weights,
		);
		expect(pool?.length).toBeGreaterThanOrEqual(3);

		// Hybrid query pointing at shard 2 probes shard 0 + top centroids (shard 2)
		const q2 = new Float32Array(DIM);
		q2[2] = 1;
		const hybridHits = await store.hybrid("merino cardigan", q2, 5);
		expect(hybridHits[0]?.id).toBe("S02-P0");
		const multiLexHits = await store.hybrid("Item", q2, 10);
		expect(multiLexHits.length).toBeGreaterThan(2);
		const zeroHybrid = await store.hybrid("Item", new Float32Array(DIM), 3);
		expect(zeroHybrid.length).toBeGreaterThan(0);

		// Vector search & zero-vector fallback
		const vHits = await store.vectorSearch(q2, 4);
		expect(vHits.some((h) => h.id.startsWith("S02-"))).toBe(true);
		const zeroHits = await store.vectorSearch(new Float32Array(DIM), 2);
		expect(zeroHits.length).toBeLessThanOrEqual(2);

		// Sequential + concurrent opens exercise multi-chunk assembly, cached hit, LRU reuse, and overflow cap (>6 extra shards)
		await Promise.all([store.nearest("S01-P0", 2), store.nearest("S01-P1", 2)]);
		await store.nearest("S02-P0", 2);
		await store.nearest("S03-P0", 2);
		await store.nearest("S04-P0", 2);
		await store.nearest("S05-P0", 2);
		await store.nearest("S06-P0", 2);
		const nearS7 = await store.nearest("S07-P0", 2);
		expect(nearS7.every((n) => n.id.startsWith("S07-"))).toBe(true);
		const hydrated = await store.productsByIds?.([
			"NB-0001-01",
			"S01-P0",
			"S02-P0",
			"S03-P0",
			"S04-P0",
			"S05-P0",
			"S06-P0",
			"S07-P0",
		]);
		expect(hydrated?.size).toBe(8);
		expect(hydrated?.get("S02-P0")?.title).toBe("Merino Trail Cardigan");

		// Warm revision activation checks shard 0 revision + global count
		expect(
			await store.activateShardedRevision?.("rev-v1", globalTotal, sharded),
		).toBe(true);
		expect(await store.activateShardedRevision?.("rev-v1", 999, sharded)).toBe(
			false,
		);
		expect(
			await store.activateShardedRevision?.("rev-other", globalTotal, sharded),
		).toBe(false);

		await store.dispose();

		// Unsharded fallback / replace / missing _edgereco_global_counts
		const plain = await ShardedCatalogueDb.open(DIM);
		await expect(plain.nearest("NB-0001-01", 1)).rejects.toThrow(
			/unknown product id/,
		);
		expect((await plain.productsByIds(["NB-0001-01"])).size).toBe(0);
		expect(await plain.activateShardedRevision("r", 1, sharded)).toBe(false);
		await plain.importShardedSqlite({
			shardCount: 1,
			centroids: built[0]?.centroid ?? new Float32Array(DIM),
			shardChunks: () =>
				(async function* () {
					yield built[1]?.bytes ?? new Uint8Array(0);
				})(),
		});
		const plainBrowse = await plain.browseSql({ category: "Shoes", limit: 5 });
		expect(plainBrowse.total).toBe(2);
		await plain.replace({ products: [], vectors: new Float32Array(0) });

		// Offline extra-shard NetworkError degrades cleanly to shard 0 while non-network errors rethrow
		await plain.importShardedSqlite({
			shardCount: 2,
			centroids: centroids.subarray(0, 2 * DIM),
			shardChunks: (s) =>
				(async function* () {
					if (s === 0) {
						yield built[0]?.bytes ?? new Uint8Array(0);
						return;
					}
					throw s === 1 ? new NetworkError("offline") : new Error("corrupt");
				})(),
		});
		const q1 = new Float32Array(DIM);
		q1[1] = 1;
		const offlineHits = await plain.hybrid("Item", q1, 3);
		expect(offlineHits.length).toBeGreaterThan(0);

		// Corrupt extra-shard SQLite bytes clean up the acquired slot and rethrow
		await plain.importShardedSqlite({
			shardCount: 2,
			centroids: centroids.subarray(0, 2 * DIM),
			shardChunks: (s) =>
				(async function* () {
					if (s === 0) {
						yield built[0]?.bytes ?? new Uint8Array(0);
						return;
					}
					yield new Uint8Array([1, 2, 3, 4]);
				})(),
		});
		await expect(plain.hybrid("Item", q1, 3)).rejects.toThrow();
		await plain.dispose();
	});

	it("boots EngineRuntime and hot-swaps syncUpdate over a sharded ivf_shards bundle", async () => {
		const built0 = await buildShardImage(0, 3, 6);
		const built1 = await buildShardImage(1, 3);
		const centroids = new Float32Array(2 * DIM);
		centroids.set(built0.centroid, 0);
		centroids.set(built1.centroid, DIM);
		const centroidsBytes = new Uint8Array(
			centroids.buffer,
			centroids.byteOffset,
			centroids.byteLength,
		);

		const makeMeta = (version: string) =>
			new TextEncoder().encode(
				JSON.stringify({
					schema_version: 2,
					catalog_id: "sharded-demo",
					version,
					created_at: "2026-04-01T00:00:00Z",
					product_count: 6,
					embedding_dim: DIM,
					embedding_count: 6,
					embedding_model: "test-model",
					ivf_shards: 2,
				}),
			);

		let currentVersion = "v1";
		const syncResult = (hashChar: string, version: string): SyncResult => ({
			version,
			manifestHash: hashChar.repeat(64),
			chunksFetched: 2,
			chunksReused: 0,
			bytesFetched: 1024,
		});

		const config: RuntimeConfig = {
			bundleBaseUrl: "http://example.test/bundle",
			pubkeyUrl: "http://example.test/public.key",
		};

		const runtime = new EngineRuntime({
			spawnEngine: () => ({
				sync: async () =>
					syncResult(currentVersion === "v1" ? "a" : "b", currentVersion),
				readFile: async (path: string) => {
					if (path === "catalog_meta.json") return makeMeta(currentVersion);
					if (path === "ivf_centroids.f32") return centroidsBytes;
					if (path === "shards/shard_00.sqlite") return built0.bytes;
					if (path === "shards/shard_01.sqlite") return built1.bytes;
					throw new Error(`file ${path} not in manifest`);
				},
			}),
			makeEmbedder: () => ({
				embed: async () => {
					const q = new Float32Array(DIM);
					q[1] = 1;
					return q;
				},
			}),
			makeCatalogue: () => ShardedCatalogueDb.open(DIM),
		});

		const engine = await runtime.bootstrap(config);
		expect(engine.ntotal).toBe(6);
		const browse = await engine.browseSql?.({ limit: 10 });
		expect(browse?.total).toBe(6);
		const hits = await engine.search("Shard 1", { limit: 4 });
		expect(hits.results.some((r) => r.product.id.startsWith("S01-"))).toBe(
			true,
		);

		currentVersion = "v2";
		const updated = await runtime.syncUpdate({
			...config,
			bundleBaseUrl: "http://example.test/bundle-delta",
		});
		expect(updated?.version).toBe("v2");
		expect(engine.ntotal).toBe(6);
		await runtime.dispose();
	});

	it("fails closed when ivf_centroids.f32 byte length does not match ivf_shards * dim * 4", async () => {
		const runtime = new EngineRuntime({
			spawnEngine: () => ({
				sync: async () => ({
					version: "v1",
					manifestHash: "c".repeat(64),
					chunksFetched: 1,
					chunksReused: 0,
					bytesFetched: 100,
				}),
				readFile: async (path: string) => {
					if (path === "catalog_meta.json") {
						return new TextEncoder().encode(
							JSON.stringify({
								schema_version: 2,
								catalog_id: "bad-centroids",
								version: "v1",
								created_at: "2026-04-01T00:00:00Z",
								product_count: 4,
								embedding_dim: DIM,
								embedding_count: 4,
								embedding_model: "test-model",
								ivf_shards: 2,
							}),
						);
					}
					if (path === "ivf_centroids.f32") return new Uint8Array(12);
					throw new Error(`file ${path} not in manifest`);
				},
			}),
			makeEmbedder: () => ({ embed: async () => new Float32Array(DIM) }),
		});

		await expect(
			runtime.bootstrap({
				bundleBaseUrl: "http://example.test/bundle",
				pubkeyUrl: "http://example.test/public.key",
			}),
		).rejects.toThrow(/ivf_centroids\.f32 expected/);
	});
});
