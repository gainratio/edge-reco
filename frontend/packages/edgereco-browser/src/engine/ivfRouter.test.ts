// @vitest-environment node

import { describe, expect, it } from "vitest";
import { CatalogueDb } from "./catalogueDb";
import { openCatalogueSql } from "./catalogueSql";
import {
	decodeTurboQuantRow,
	rankIvfCentroids,
	shardForProductId,
} from "./ivfRouter";

describe("shardForProductId", () => {
	it("routes S{00..63}-* to its shard and NB-* / unknown IDs to shard 0", () => {
		expect(shardForProductId("NB-0001-01", 64)).toBe(0);
		expect(shardForProductId("S00-B001", 64)).toBe(0);
		expect(shardForProductId("S01-B001", 64)).toBe(1);
		expect(shardForProductId("S63-B999", 64)).toBe(63);
		expect(shardForProductId("S64-B999", 64)).toBe(0);
		expect(shardForProductId("B001", 64)).toBe(0);
		expect(shardForProductId("S05-B001", 1)).toBe(0);
	});
});

describe("rankIvfCentroids", () => {
	it("ranks coarse IVF centroids by cosine similarity with deterministic tie-breaking", () => {
		const centroids = new Float32Array([
			1, 0, 0, 0, 0, 1, 0, 0, 0.7, 0.7, 0, 0, 0, 0, 1, 0,
		]);
		const query = new Float32Array([0.8, 0.6, 0, 0]);
		expect(rankIvfCentroids(query, centroids, 4, 2)).toEqual([2, 0]);
		expect(rankIvfCentroids(query, centroids, 4, 99)).toEqual([2, 0, 1, 3]);
	});

	it("breaks equal-similarity ties by ascending shard index and validates inputs", () => {
		const centroids = new Float32Array([1, 0, 1, 0]);
		const query = new Float32Array([1, 0]);
		expect(rankIvfCentroids(query, centroids, 2, 1)).toEqual([0]);
		expect(() => rankIvfCentroids(query, centroids, 0, 1)).toThrow(RangeError);
		expect(() =>
			rankIvfCentroids(new Float32Array([1]), centroids, 2, 1),
		).toThrow(RangeError);
		expect(() =>
			rankIvfCentroids(query, new Float32Array([1, 2, 3]), 2, 1),
		).toThrow(RangeError);
	});
});

describe("decodeTurboQuantRow and pre-quantized zeroblob(0) CatalogueDb", () => {
	it("returns null for out-of-bounds rowids or invalid dimensions", () => {
		const dummy = new Uint8Array(108);
		expect(decodeTurboQuantRow(dummy, 0, -1, 384)).toBeNull();
		expect(decodeTurboQuantRow(dummy, 0, 2, 384)).toBeNull();
		expect(decodeTurboQuantRow(dummy, 0, 0, 1)).toBeNull();
	});

	it("serves vectorSearch, hybrid, and nearest over a pre-quantized zeroblob(0) SQLite image", async () => {
		const dim = 384;
		const rowCount = 260;
		const builderSql = await openCatalogueSql();
		const builderDb = await CatalogueDb.open(builderSql, dim);

		const vectors = new Float32Array(rowCount * dim);
		for (let i = 0; i < rowCount; i++) {
			const base = i * dim;
			const cluster = i % 16;
			const int8 = new Int8Array(dim);
			for (let d = 0; d < dim; d++) {
				const v = Math.sin((cluster + 1) * (d + 1) * 0.17);
				vectors[base + d] = v;
				int8[d] = Math.round(v * 127);
			}
			await builderSql.query(
				"INSERT INTO products VALUES (?, ?, ?, '', 'Apparel', 'outdoor', '[\"outdoor\"]', 'Peak', 10, 0.5, 0.5, '', ?)",
				[
					i,
					`P${i}`,
					i === 0 ? "Alpine Trail Jacket" : `Item ${i}`,
					new Uint8Array(int8.buffer),
				],
			);
		}
		await builderSql.exec(
			"INSERT INTO products_fts(products_fts) VALUES ('rebuild');",
		);
		await builderSql.query(
			`SELECT vector_init('products', 'embedding', 'dimension=${dim},type=INT8,distance=COSINE,qtype=TURBOQUANT,qbits=2,max_memory=1MB')`,
		);
		await builderSql.query("SELECT vector_quantize('products', 'embedding')");
		await builderSql.exec(
			"UPDATE products SET embedding = zeroblob(0); VACUUM;",
		);

		const exportedRow = await builderSql.query(
			"SELECT rowid1, data FROM vector0_products_embedding ORDER BY rowid1 LIMIT 1",
		);
		const blockBytes = exportedRow[0]?.data as Uint8Array;
		const decoded0 = decodeTurboQuantRow(
			blockBytes,
			Number(exportedRow[0]?.rowid1 ?? 0),
			0,
			dim,
		);
		expect(decoded0).not.toBeNull();
		expect(decoded0?.length).toBe(dim);

		// Verify CatalogueDb activates and serves nearest() + vectorSearch() with length(embedding) == 0
		const activated = await builderDb.activateRevision("rev-zero", rowCount);
		expect(activated).toBe(false);
		await builderSql.query(
			"INSERT OR REPLACE INTO _sqliteai_vector (tblname, colname, key, value) VALUES ('_edgereco', 'bundle', 'revision', 'rev-zero')",
		);
		expect(await builderDb.activateRevision("rev-zero", rowCount)).toBe(true);

		const neighbours = await builderDb.nearest("P0", 5);
		expect(neighbours.length).toBe(5);
		expect(neighbours.some((n) => n.id === "P16")).toBe(true);

		const vHits = await builderDb.vectorSearch(vectors.subarray(0, dim), 5);
		expect(vHits.length).toBe(5);
		expect(vHits[0]?.id).toBe("P0");

		const hHits = await builderDb.hybrid(
			"alpine jacket",
			vectors.subarray(0, dim),
			5,
		);
		expect(hHits.length).toBeGreaterThan(0);
		expect(hHits[0]?.id).toBe("P0");

		if (builderSql.exportDatabase === undefined) {
			throw new Error("expected exportDatabase on NodeSqlDatabase");
		}
		const sqliteBytes = await builderSql.exportDatabase();
		await builderDb.dispose();

		const targetSql = await openCatalogueSql();
		const targetDb = await CatalogueDb.open(targetSql, dim);
		await targetDb.importSqlite(sqliteBytes, { revisionKey: "rev-imported" });
		expect(await targetDb.count()).toBe(rowCount);
		const importedNeighbours = await targetDb.nearest("P0", 5);
		expect(importedNeighbours.some((n) => n.id === "P16")).toBe(true);
		const importedVecHits = await targetDb.vectorSearch(
			vectors.subarray(0, dim),
			5,
		);
		expect(importedVecHits[0]?.id).toBe("P0");
		await targetDb.dispose();
	});
});
