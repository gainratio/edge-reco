import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string): string =>
	readFileSync(resolve(process.cwd(), "src/engine", file), "utf8");

const VECTOR_INDEX = read("vectorIndex.ts");
const CATALOGUE_DB = read("catalogueDb.ts");

describe("browser vector runtime contract", () => {
	// CONTRACT CHANGE (2026-10-04, INVERTED, not deleted). This used to require
	// vectorIndex.ts to open @edgeproc/browser's SQLite-vector Worker
	// (createSqliteVectorIndex). Vectors now live in edge-reco's catalogue
	// database beside the products and the FTS5 index, on the SAME pinned SQLite +
	// sqlite-vector build (catalogueSqlite.ts), so one SQL query can fuse keyword
	// and vector ranks. The property this test exists for is unchanged: similarity
	// runs in sqlite-vector, never in a JS fallback.
	it("runs similarity in sqlite-vector inside the catalogue database, with no JS fallback", () => {
		expect(VECTOR_INDEX).not.toContain("createSqliteVectorIndex");
		expect(CATALOGUE_DB).toContain("vector_full_scan('products', 'embedding'");
		for (const source of [VECTOR_INDEX, CATALOGUE_DB]) {
			expect(source).not.toContain("PackedVectorIndex");
			expect(source).not.toContain("FlatVectorIndex");
			expect(source).not.toContain("cosineSimilarity");
		}
	});
});
