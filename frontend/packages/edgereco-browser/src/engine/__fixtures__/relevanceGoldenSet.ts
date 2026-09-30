// The relevance golden set: 50 queries with hand-written intents and ground-truth
// relevant sets that are derived WITHOUT consulting the ranker.
//
// WHY THIS EXISTS
// The engine has parity tests (does the browser reproduce the server?) but no
// relevance test (does either one return the right products?). Parity can be
// perfect while both tiers are wrong. This file is the missing half: an
// independent statement of what SHOULD come back, so precision/recall/nDCG/MRR
// can be measured and a later ranking fix can be shown to have improved them.
//
// THE LABEL RULE (one rule, applied to every query)
//   relevant(q) = { p : some node of p's breadcrumb path is a named node }
// where a product's breadcrumb path is `[category, ...subcategories]` — the tuple
// `catalog/preprocessor.py::_split_breadcrumbs` splits out of the source CSV's
// `breadcrumbs` column, long before any tokenizer, embedder or scorer runs.
//
// WHY THE LABELS ARE INDEPENDENT OF WHAT THEY MEASURE
//   1. The labels are authored upstream (the category path the catalog generator,
//      backend/scripts/generate_catalog.py, assigns each product), not by the engine. Building them reads products.jsonl and nothing else — no
//      embedding, no BM25 score, no engine call. A golden set derived from the
//      embeddings would always pass; this one cannot be satisfied by construction.
//   2. Query wording is drawn from `description` and `title`, never from the
//      taxonomy. `description` is in NEITHER retrieval representation — not the
//      BM25 corpus (`keyword.ts::productTokens` = title + category + tags + brand)
//      and not the embedded text (`embeddings/encoder.py::_product_text`, the same
//      four fields). Every `natural` query carries a "held-out anchor": a word that
//      is common in the relevant products' descriptions and absent from their
//      taxonomy fields, so the query has a hook the retriever literally cannot see.
//   3. The leak is measured, not assumed away. `category` and `tags` ARE inside both
//      retrieval representations, so a query made of taxonomy words matches the
//      label field directly. Those queries are segmented as `taxonomy-word` and
//      reported separately; mixing them with `natural` would hide the leak.
//
// THE RESIDUAL LEAK, STATED HONESTLY
// `tags` are slugified `subcategories` ("Garden Hoses" -> "garden-hoses"), so they
// are a restatement of the label, not a second signal. BM25 tokenizes on whitespace
// (`keyword.ts::tokenize`), so a multi-word tag is ONE token and a natural query
// cannot hit it — that is the property `taxonomyCorpusTokens` guards. The sentence
// -transformer tokenizer does split on hyphens, so subcategory words do reach the
// VECTOR side even for `natural` queries. The natural segment's scores are
// therefore an upper bound on true generalization, not a clean measurement.
//
// PROVENANCE OF THE QUERIES
// The 50 queries and their label nodes were written against an earlier catalog (a
// third-party dataset since replaced by the synthetic one). The synthetic catalog
// keeps every label node, so the labels still apply, but the natural wording was
// picked from the OLD descriptions. Some anchors ("iphone", "apple", "android") name
// real products the synthetic catalog deliberately never mentions. The rationale
// counts below are recomputed from the current catalog; a 0% anchor is stated, not
// hidden. Treat natural-segment scores as a comparison with that earlier baseline,
// not as an absolute measure.
//
// SEGMENTS
//   natural       — a shopping phrase a person would type; no query word is a BM25
//                   token of any relevant product's category/tags.
//   taxonomy-word — the query IS a breadcrumb label; every relevant product shares
//                   a BM25 taxonomy token with it. The leaky control group.
//   negative      — no product in the catalog answers the query, so the correct
//                   relevant set is EMPTY. Half gibberish, half plausible-but-absent
//                   product types. These are what expose a missing score floor: an
//                   engine with no notion of "no good match" still returns k results.

import type { Product } from "../domain";
import { tokenize } from "../keyword";

/** The bundle these labels were authored against. */
export const CATALOG_ID = "amazon-demo";

/** Machine-readable tag for the labelling method (see the header). */
export const LABEL_METHOD = "breadcrumb-node-membership";

/** Results requested per query — the demo storefront's grid page size. */
export const RELEVANCE_K = 24;

/** Which measurement a query belongs to. Never mix these in one average. */
export type QuerySegment = "natural" | "taxonomy-word" | "negative";

/** One golden-set entry: the query, its segment, and the breadcrumb nodes that
 * define its ground truth (empty for `negative`, where nothing is relevant). */
export interface GoldenQuery {
	readonly query: string;
	readonly segment: QuerySegment;
	readonly labelNodes: ReadonlyArray<string>;
	/** One line a human can check against the catalog without running anything. */
	readonly rationale: string;
}

/** Grammatical filler that carries no product intent; excluded from the
 * segmentation guards so "for"/"the" cannot flip a query into the leaky segment. */
export const QUERY_STOPWORDS: ReadonlySet<string> = new Set([
	"a",
	"an",
	"and",
	"at",
	"for",
	"from",
	"in",
	"is",
	"it",
	"my",
	"of",
	"on",
	"that",
	"the",
	"to",
	"up",
	"with",
]);

/** A product's breadcrumb path: the category plus every subcategory level. */
export function breadcrumbNodes(product: Product): ReadonlyArray<string> {
	return [product.category, ...product.subcategories];
}

/**
 * The label rule. A product is relevant when any node of its breadcrumb
 * path is one of the query's named nodes. Order follows products.jsonl, so the
 * exported ids are stable across runs.
 */
export function relevantIds(
	products: ReadonlyArray<Product>,
	labelNodes: ReadonlyArray<string>,
): ReadonlyArray<string> {
	return products
		.filter((p) => breadcrumbNodes(p).some((n) => labelNodes.includes(n)))
		.map((p) => p.id);
}

/**
 * The BM25 tokens a product contributes from its LABEL fields alone — category and
 * tags, run through the engine's own `tokenize` so the guard measures the real
 * lexical surface rather than a re-implementation of it. Title and brand are
 * excluded on purpose: matching a product's NAME is what search is supposed to do;
 * matching the field the label was cut from is the leak.
 */
export function taxonomyCorpusTokens(product: Product): ReadonlySet<string> {
	return new Set(tokenize(`${product.category} ${product.tags.join(" ")}`));
}

/** The query's content words — what the guards reason about. */
export function queryTerms(query: string): ReadonlyArray<string> {
	return tokenize(query).filter((t) => !QUERY_STOPWORDS.has(t));
}

const NATURAL: ReadonlyArray<GoldenQuery> = [
	{
		query: "laptop for schoolwork",
		segment: "natural",
		labelNodes: ["Traditional Laptops", "Laptops"],
		rationale:
			"breadcrumbs 'Traditional Laptops' + 'Laptops' = 3 products; anchor 'laptop' is in 67% of their descriptions and in no relevant category/tags",
	},
	{
		query: "tempered glass that keeps my phone from cracking",
		segment: "natural",
		labelNodes: ["Screen Protectors"],
		rationale:
			"breadcrumb 'Screen Protectors' = 12 products; anchor 'glass' is in 100% of their descriptions and in no relevant category/tags",
	},
	{
		query: "stop the neighbors dog from barking",
		segment: "natural",
		labelNodes: ["Sonic Bark Deterrents"],
		rationale:
			"breadcrumb 'Sonic Bark Deterrents' = 8 products; anchor 'dog' is in 100% of their descriptions and in no relevant category/tags",
	},
	{
		query: "clear shockproof cover for iphone 14",
		segment: "natural",
		labelNodes: ["Basic Cases"],
		rationale:
			"breadcrumb 'Basic Cases' = 10 products; anchor 'iphone' is in 0% of their descriptions and in no relevant category/tags",
	},
	{
		query: "wireless earbuds with long playtime",
		segment: "natural",
		labelNodes: ["Earbud Headphones", "Over-Ear Headphones"],
		rationale:
			"breadcrumbs 'Earbud Headphones' + 'Over-Ear Headphones' = 15 products; anchor 'earbuds' is in 67% of their descriptions and in no relevant category/tags",
	},
	{
		query: "replacement band for my apple watch",
		segment: "natural",
		labelNodes: ["Smartwatch Bands"],
		rationale:
			"breadcrumb 'Smartwatch Bands' = 8 products; anchor 'band' is in 88% of their descriptions and in no relevant category/tags",
	},
	{
		query: "50 ft expandable hose that will not kink",
		segment: "natural",
		labelNodes: ["Garden Hoses"],
		rationale:
			"breadcrumb 'Garden Hoses' = 8 products; anchor 'hose' is in 75% of their descriptions and in no relevant category/tags",
	},
	{
		query: "plug in ultrasonic mouse and rodent repeller",
		segment: "natural",
		labelNodes: ["Ultrasonic Repellers"],
		rationale:
			"breadcrumb 'Ultrasonic Repellers' = 10 products; anchor 'ultrasonic' is in 50% of their descriptions and in no relevant category/tags",
	},
	{
		query: "diamond art kit for adults",
		segment: "natural",
		labelNodes: ["Adults' Paint-By-Number Kits"],
		rationale:
			"breadcrumb 'Adults' Paint-By-Number Kits' = 7 products; anchor 'diamond' is in 100% of their descriptions and in no relevant category/tags",
	},
	{
		query: "unlocked dual sim android smartphone",
		segment: "natural",
		labelNodes: ["Cell Phones"],
		rationale:
			"breadcrumb 'Cell Phones' = 5 products; anchor 'unlocked' is in 100% of their descriptions and in no relevant category/tags",
	},
	{
		query: "mens crew neck cotton tee multipack",
		segment: "natural",
		labelNodes: ["T-Shirts"],
		rationale:
			"breadcrumb 'T-Shirts' = 14 products; anchor 'cotton' is in 93% of their descriptions and in no relevant category/tags",
	},
	{
		query: "long sleeve onesie 5 pack",
		segment: "natural",
		labelNodes: ["Bodysuits"],
		rationale:
			"breadcrumb 'Bodysuits' = 8 products; anchor 'sleeve' is in 0% of their descriptions and in no relevant category/tags",
	},
	{
		query: "extra large desk mat for gaming",
		segment: "natural",
		labelNodes: ["Mouse Pads"],
		rationale:
			"breadcrumb 'Mouse Pads' = 7 products; anchor 'desk' is in 100% of their descriptions and in no relevant category/tags",
	},
	{
		query: "2024 weekly agenda organizer",
		segment: "natural",
		labelNodes: ["Planners"],
		rationale:
			"breadcrumb 'Planners' = 7 products; anchor '2024' is in 0% of their descriptions and in no relevant category/tags",
	},
	{
		query: "musical pop up birthday card",
		segment: "natural",
		labelNodes: ["Greeting Cards"],
		rationale:
			"breadcrumb 'Greeting Cards' = 6 products; anchor 'card' is in 100% of their descriptions and in no relevant category/tags",
	},
	{
		query: "purple color corrector for stained teeth",
		segment: "natural",
		labelNodes: ["Toothpaste"],
		rationale:
			"breadcrumb 'Toothpaste' = 9 products; anchor 'teeth' is in 44% of their descriptions and in no relevant category/tags",
	},
	{
		query: "blue light blocking readers",
		segment: "natural",
		labelNodes: ["Reading Glasses"],
		rationale:
			"breadcrumb 'Reading Glasses' = 6 products; anchor 'blue' is in 83% of their descriptions and in no relevant category/tags",
	},
	{
		query: "zipper freezer bags for leftovers",
		segment: "natural",
		labelNodes: ["Food Storage Bags"],
		rationale:
			"breadcrumb 'Food Storage Bags' = 6 products; anchor 'zipper' is in 67% of their descriptions and in no relevant category/tags",
	},
	{
		query: "anti snoring nose device for sleep",
		segment: "natural",
		labelNodes: ["Snore Reducing Aids"],
		rationale:
			"breadcrumb 'Snore Reducing Aids' = 5 products; anchor 'anti' is in 0% of their descriptions and in no relevant category/tags",
	},
	{
		query: "disposable face mask individually wrapped",
		segment: "natural",
		labelNodes: ["Disposable Cup Dust Safety Masks"],
		rationale:
			"breadcrumb 'Disposable Cup Dust Safety Masks' = 5 products; anchor 'mask' is in 20% of their descriptions and in no relevant category/tags",
	},
	{
		query: "umbrella that shades the deck",
		segment: "natural",
		labelNodes: ["Umbrellas"],
		rationale:
			"breadcrumb 'Umbrellas' = 6 products; anchor 'umbrella' is in 50% of their descriptions and in no relevant category/tags",
	},
	{
		query: "fleece pullover sweatshirt",
		segment: "natural",
		labelNodes: ["Active Sweatshirts"],
		rationale:
			"breadcrumb 'Active Sweatshirts' = 6 products; anchor 'sweatshirt' is in 0% of their descriptions and in no relevant category/tags",
	},
	{
		query: "key fob cover with ring",
		segment: "natural",
		labelNodes: ["Keychains"],
		rationale:
			"breadcrumb 'Keychains' = 6 products; anchor 'key' is in 83% of their descriptions and in no relevant category/tags",
	},
	{
		query: "bluetooth portable speaker",
		segment: "natural",
		labelNodes: ["Portable Bluetooth Speakers"],
		rationale:
			"breadcrumb 'Portable Bluetooth Speakers' = 6 products; anchor 'bluetooth' is in 0% of their descriptions and in no relevant category/tags",
	},
	{
		query: "surveillance camera for the front door",
		segment: "natural",
		labelNodes: ["Surveillance Cameras", "Dome Cameras"],
		rationale:
			"breadcrumbs 'Surveillance Cameras' + 'Dome Cameras' = 7 products; anchor 'camera' is in 57% of their descriptions and in no relevant category/tags",
	},
	{
		query: "instant film camera",
		segment: "natural",
		labelNodes: ["Instant Cameras", "Film Cameras"],
		rationale:
			"breadcrumbs 'Instant Cameras' + 'Film Cameras' = 3 products; anchor 'instant' is in 33% of their descriptions and in no relevant category/tags",
	},
	{
		query: "sneakers for everyday walking",
		segment: "natural",
		labelNodes: ["Fashion Sneakers"],
		rationale:
			"breadcrumb 'Fashion Sneakers' = 7 products; anchor 'walking' is in 57% of their descriptions and in no relevant category/tags",
	},
	{
		query: "drip tubing kit for the vegetable bed",
		segment: "natural",
		labelNodes: ["Drip Irrigation Kits"],
		rationale:
			"breadcrumb 'Drip Irrigation Kits' = 5 products; anchor 'drip' is in 40% of their descriptions and in no relevant category/tags",
	},
	{
		query: "fast charging brick for the wall",
		segment: "natural",
		labelNodes: ["Wall Chargers"],
		rationale:
			"breadcrumb 'Wall Chargers' = 7 products; anchor 'fast' is in 100% of their descriptions and in no relevant category/tags",
	},
	{
		query: "powder for hair skin and nails",
		segment: "natural",
		labelNodes: ["Collagen"],
		rationale:
			"breadcrumb 'Collagen' = 5 products; anchor 'hair' is in 80% of their descriptions and in no relevant category/tags",
	},
];

/** The 12 top-level breadcrumb categories, typed verbatim as queries. These match
 * the label field directly — that is the point of the segment. */
const TAXONOMY_CATEGORIES: ReadonlyArray<string> = [
	"Arts, Crafts & Sewing",
	"Automotive",
	"Cell Phones & Accessories",
	"Clothing, Shoes & Jewelry",
	"Electronics",
	"Health & Household",
	"Home & Kitchen",
	"Office Products",
	"Patio, Lawn & Garden",
	"Pet Supplies",
	"Sports & Outdoors",
	"Tools & Home Improvement",
];

const TAXONOMY: ReadonlyArray<GoldenQuery> = TAXONOMY_CATEGORIES.map(
	(category) => ({
		query: category.toLowerCase(),
		segment: "taxonomy-word" as const,
		labelNodes: [category],
		rationale: `the query IS the breadcrumb node '${category}'; every relevant product carries it in its path, and its words are in the BM25 corpus verbatim`,
	}),
);

const NEGATIVE: ReadonlyArray<GoldenQuery> = [
	{
		query: "zzqxwv plerbnak",
		segment: "negative",
		labelNodes: [],
		rationale:
			"gibberish; neither word occurs in any title, breadcrumb or description, so nothing is relevant",
	},
	{
		query: "frobnicate quux zibble",
		segment: "negative",
		labelNodes: [],
		rationale:
			"gibberish; none of the three words occurs in any title, breadcrumb or description",
	},
	{
		query: "asdfghjkl qwertyuiop",
		segment: "negative",
		labelNodes: [],
		rationale:
			"keyboard mash; neither word occurs in any title, breadcrumb or description",
	},
	{
		query: "xylophonic wumpus",
		segment: "negative",
		labelNodes: [],
		rationale:
			"invented words; neither occurs in any title, breadcrumb or description",
	},
	{
		query: "treadmill",
		segment: "negative",
		labelNodes: [],
		rationale:
			"a real product type this 720-item catalog does not stock; 'treadmill' occurs in zero titles, breadcrumbs and descriptions",
	},
	{
		query: "ukulele",
		segment: "negative",
		labelNodes: [],
		rationale:
			"a real product type this catalog does not stock; 'ukulele' occurs in zero titles, breadcrumbs and descriptions",
	},
	{
		query: "trampoline",
		segment: "negative",
		labelNodes: [],
		rationale:
			"a real product type this catalog does not stock; 'trampoline' occurs in zero titles, breadcrumbs and descriptions",
	},
	{
		query: "toboggan",
		segment: "negative",
		labelNodes: [],
		rationale:
			"a real product type this catalog does not stock; 'toboggan' occurs in zero titles, breadcrumbs and descriptions",
	},
];

/** The whole golden set: 30 natural + 12 taxonomy-word + 8 negative = 50 queries. */
export const GOLDEN_QUERIES: ReadonlyArray<GoldenQuery> = [
	...NATURAL,
	...TAXONOMY,
	...NEGATIVE,
];
