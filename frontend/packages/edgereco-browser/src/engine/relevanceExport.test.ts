// @vitest-environment node
//
// The relevance harness: run the golden set (__fixtures__/relevanceGoldenSet.ts)
// through the real in-browser pipeline and export the ranked ids, so search
// QUALITY can be scored — the one thing the engine's parity suite cannot tell you.
//
// Measuring comes before fixing. Nothing here asserts a quality threshold and
// nothing here touches the ranker; the numbers are computed downstream, in Python
// (`assay.ranking`), because one metric written in two languages will diverge.
// What this file DOES assert is that the golden set is honest: that the labels
// were not cut from the field the retriever reads (the three segmentation guards
// below), and that the committed export still matches labels re-derived from the
// catalog. Those guards can fail — change a `natural` query to a taxonomy word,
// or point a label at the wrong breadcrumb, and the suite goes red.
//
// Runs in the node environment for the same reason as hybridParity.test.ts: the
// real transformers.js pipeline uses the onnxruntime-node backend, which rejects
// jsdom's patched Float32Array. The model (~25 MB) loads on first use, so the
// export gets a long timeout and is skippable via EDGE_RECO_SKIP_EMBEDDING_PARITY=1
// — with the model skipped the guards and the committed-artifact check still run.
//
// The export is written tab-indented; let Biome settle the JSON formatting after
// regenerating it, the same contract backend/scripts/gen_search_fixture.py follows::
//
//     pnpm -F @edgereco/browser exec vitest run src/engine/relevanceExport.test.ts
//     pnpm exec biome check --write \
//         packages/edgereco-browser/src/engine/__fixtures__/relevance_export.json

/// <reference types="node" />

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IndexManifest, Verify } from "@edgeproc/browser";
import {
	MemoryCacheStore,
	materializeFile,
	syncIndex,
} from "@edgeproc/browser";
import { describe, expect, it } from "vitest";
import {
	CATALOG_ID,
	GOLDEN_QUERIES,
	type GoldenQuery,
	LABEL_METHOD,
	queryTerms,
	RELEVANCE_K,
	relevantIds,
	taxonomyCorpusTokens,
} from "./__fixtures__/relevanceGoldenSet";
import type { Product } from "./domain";
import { createEmbedder, type Embedder } from "./embedder";
import { catalogFetch } from "./fixtures";
import { createSearchEngine, type SearchEngine } from "./searchEngine";
import type { VectorIndexFiles } from "./vectorIndex";

const SKIP = process.env.EDGE_RECO_SKIP_EMBEDDING_PARITY === "1";
const TIMEOUT_MS = 300_000;
const DECODER = new TextDecoder();
const acceptVerify: Verify = () => Promise.resolve();

/** The embedder is unused on the catalog-only paths, so the guards need no model. */
const stubEmbedder: Embedder = {
	embed: () => Promise.reject(new Error("embedder unused on this path")),
};

const EXPORT_PATH = join(
	dirname(fileURLToPath(import.meta.url)),
	"__fixtures__",
	"relevance_export.json",
);

const EXPORT_DESCRIPTION =
	"EdgeReco relevance baseline over the committed amazon-demo bundle (720 synthetic products). " +
	"relevant_ids are ground truth derived from each product's generated breadcrumb path " +
	"(catalog/preprocessor.py::_split_breadcrumbs) — upstream of BM25, the embeddings and " +
	"the reranker, so the labels cannot be satisfied by the ranker's own scores. ranked_ids " +
	"is the engine's output in rank order at k. Queries are segmented: `natural` wording is " +
	"drawn from `description` (held out of both retrieval representations), `taxonomy-word` " +
	"queries are the breadcrumb labels themselves (the leaky control group), and `negative` " +
	"queries have no answer in the catalog at all. Never average across segments.";

/** One exported query — the contract the Python scorer consumes. */
interface ExportedQuery {
	readonly query: string;
	readonly relevant_ids: ReadonlyArray<string>;
	readonly ranked_ids: ReadonlyArray<string>;
	readonly segment: string;
	readonly label_rationale: string;
}

interface RelevanceExport {
	readonly description: string;
	readonly catalog_id: string;
	readonly label_method: string;
	readonly embedder: string;
	readonly k: number;
	readonly queries: ReadonlyArray<ExportedQuery>;
}

async function syncedFiles(): Promise<VectorIndexFiles> {
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
	const read = (path: string): Promise<Uint8Array> =>
		materializeFile(store, manifest, path);
	const [meta, state, embeddings, products] = await Promise.all([
		read("catalog_meta.json"),
		read("vector/state.json"),
		read("vector/embeddings.f32"),
		read("products.jsonl"),
	]);
	return { meta, state, embeddings, products };
}

/** The catalog, read off the verified sync path with no model in the loop. */
async function catalogProducts(): Promise<ReadonlyArray<Product>> {
	const engine = await createSearchEngine(await syncedFiles(), stubEmbedder);
	return engine.catalog();
}

/** The full pipeline: real transformers.js embedder -> BM25 + vector -> RRF -> rerank. */
async function realEngine(): Promise<SearchEngine> {
	return createSearchEngine(await syncedFiles(), createEmbedder());
}

function bySegment(segment: string): ReadonlyArray<GoldenQuery> {
	return GOLDEN_QUERIES.filter((q) => q.segment === segment);
}

function readCommittedExport(): RelevanceExport {
	return JSON.parse(readFileSync(EXPORT_PATH, "utf8")) as RelevanceExport;
}

/** True when the committed export already carries this payload, whitespace aside. */
function matchesCommitted(payload: RelevanceExport): boolean {
	if (!existsSync(EXPORT_PATH)) {
		return false;
	}
	const committed = readCommittedExport();
	return (
		committed.embedder === payload.embedder &&
		committed.k === payload.k &&
		JSON.stringify(committed.queries) === JSON.stringify(payload.queries)
	);
}

describe("relevance golden set: the labels are independent of the ranker", () => {
	it("gives every natural query a relevant set and no hit on the label field", async () => {
		const products = await catalogProducts();
		const byId = new Map(products.map((p) => [p.id, p]));
		const leaks: string[] = [];
		for (const entry of bySegment("natural")) {
			const ids = relevantIds(products, entry.labelNodes);
			expect(
				ids.length,
				`no relevant products for "${entry.query}"`,
			).toBeGreaterThan(0);
			for (const term of queryTerms(entry.query)) {
				for (const id of ids) {
					const product = byId.get(id);
					if (
						product !== undefined &&
						taxonomyCorpusTokens(product).has(term)
					) {
						leaks.push(
							`"${entry.query}": "${term}" is a category/tag token of ${id}`,
						);
					}
				}
			}
		}
		// A natural query that shares a BM25 token with the field its label was cut
		// from measures the label, not the ranker. Such a query belongs in the
		// taxonomy-word segment.
		expect(leaks).toEqual([]);
	});

	it("makes every taxonomy-word query hit the label field, on purpose", async () => {
		const products = await catalogProducts();
		const byId = new Map(products.map((p) => [p.id, p]));
		const missed: string[] = [];
		for (const entry of bySegment("taxonomy-word")) {
			const terms = queryTerms(entry.query);
			const ids = relevantIds(products, entry.labelNodes);
			expect(
				ids.length,
				`no relevant products for "${entry.query}"`,
			).toBeGreaterThan(0);
			for (const id of ids) {
				const product = byId.get(id);
				const tokens =
					product === undefined
						? new Set<string>()
						: taxonomyCorpusTokens(product);
				if (!terms.some((term) => tokens.has(term))) {
					missed.push(`"${entry.query}": ${id} shares no taxonomy token`);
				}
			}
		}
		// This segment exists to quantify the leak, so it must actually leak.
		expect(missed).toEqual([]);
	});

	it("proves every negative query has no answer anywhere in the catalog", async () => {
		const products = await catalogProducts();
		const found: string[] = [];
		for (const entry of bySegment("negative")) {
			expect(
				entry.labelNodes,
				`"${entry.query}" must name no label node`,
			).toEqual([]);
			expect(relevantIds(products, entry.labelNodes)).toEqual([]);
			for (const term of queryTerms(entry.query)) {
				for (const product of products) {
					const haystack =
						`${product.title} ${product.category} ${product.subcategories.join(" ")} ${product.description}`.toLowerCase();
					if (haystack.includes(term)) {
						found.push(`"${entry.query}": "${term}" occurs in ${product.id}`);
					}
				}
			}
		}
		// "Empty is correct" is only ground truth if the catalog really has nothing.
		expect(found).toEqual([]);
	});
});

describe.skipIf(SKIP)("relevance export", () => {
	it(
		"ranks the golden set through the real engine and writes the export",
		async () => {
			const engine = await realEngine();
			const products = engine.catalog();
			const queries: ExportedQuery[] = [];
			for (const entry of GOLDEN_QUERIES) {
				const response = await engine.search(entry.query, {
					limit: RELEVANCE_K,
				});
				queries.push({
					query: entry.query,
					relevant_ids: relevantIds(products, entry.labelNodes),
					ranked_ids: response.results.map((r) => r.product.id),
					segment: entry.segment,
					label_rationale: entry.rationale,
				});
			}
			const payload: RelevanceExport = {
				description: EXPORT_DESCRIPTION,
				catalog_id: CATALOG_ID,
				label_method: LABEL_METHOD,
				embedder: "real",
				k: RELEVANCE_K,
				queries,
			};
			// Only rewrite when the ranking actually moved. The committed artifact is
			// Biome-formatted (short arrays collapsed) while JSON.stringify always
			// expands them, so an unconditional write would un-format the file on
			// every run and leave the package's own lint red. Skipping the no-op
			// write keeps `pnpm test` idempotent AND makes a rewrite meaningful: a
			// dirty relevance_export.json means the engine's output changed.
			if (!matchesCommitted(payload)) {
				writeFileSync(EXPORT_PATH, `${JSON.stringify(payload, null, "\t")}\n`);
			}
			expect(queries).toHaveLength(GOLDEN_QUERIES.length);
		},
		TIMEOUT_MS,
	);
});

describe("the committed relevance export", () => {
	it("carries every golden query, in order, with the declared contract", () => {
		const exported = readCommittedExport();
		expect(exported.catalog_id).toBe(CATALOG_ID);
		expect(exported.label_method).toBe(LABEL_METHOD);
		expect(exported.k).toBe(RELEVANCE_K);
		expect(exported.embedder).toBe("real");
		expect(exported.queries.map((q) => q.query)).toEqual(
			GOLDEN_QUERIES.map((q) => q.query),
		);
		expect(exported.queries.map((q) => q.segment)).toEqual(
			GOLDEN_QUERIES.map((q) => q.segment),
		);
	});

	it("still matches ground truth re-derived from the catalog", async () => {
		const products = await catalogProducts();
		const catalogIds = new Set(products.map((p) => p.id));
		const exported = readCommittedExport();
		for (const [index, entry] of GOLDEN_QUERIES.entries()) {
			const row = exported.queries[index];
			expect(row, `missing export row for "${entry.query}"`).toBeDefined();
			if (row === undefined) {
				continue;
			}
			expect(row.relevant_ids, `stale labels for "${entry.query}"`).toEqual(
				relevantIds(products, entry.labelNodes),
			);
			expect(row.ranked_ids.length).toBeLessThanOrEqual(RELEVANCE_K);
			for (const id of row.ranked_ids) {
				expect(catalogIds.has(id), `${id} is not in the catalog`).toBe(true);
			}
		}
	});
});
