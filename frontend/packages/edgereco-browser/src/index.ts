// @edgereco/browser — EdgeReco's in-browser recommendation engine.
//
// The generic signed-bundle sync, OPFS, Worker and integrity substrate comes
// from the standalone @gainratio/browser dependency. This package owns only the
// EdgeReco domain layer: embeddings, hybrid search, ranking and session state.
//
// Primary entry point: EngineRuntime.bootstrap() → SearchEngine.
//
// The node-only fixture loader lives behind
// `@edgereco/browser/testing/fixtures`. Generic test seams are imported
// directly from `@gainratio/browser`.

// --- the engine-owned domain contract (single source of truth) ---
export type {
	BrowseResponse,
	EventType,
	InteractionEvent,
	Product,
	RecommendResponse,
	ScoreComponents,
	SearchResponse,
	SearchResult,
} from "./engine/domain";
// --- the embedder seam (transformers.js in production, stubbable in tests) ---
// EMBEDDING_MODEL stays engine-internal: the model id is wired inside
// createEmbedder; consumers only ever need the dimension.
export { EMBEDDING_DIM, type Embedder } from "./engine/embedder";
// --- the bundle-carried ranking config: strategy map + weights ---
// DEFAULT_RANKING_CONFIG stays engine-internal: the runtime reads the config
// from the signed bundle; only the TYPES are part of the public surface.
export type {
	CandidatePolicy,
	InteractionWeights,
	RankingConfig,
	ScoringWeights,
	Strategy,
} from "./engine/rankingConfig";
export type { RankingProof, RankingProofEvidence } from "./engine/rankingProof";
// --- runtime: bootstrap the engine over the synced bundle ---
export {
	type BootStage,
	configFromEnv,
	createEmbedder,
	defaultRuntimeDeps,
	type EnginePort,
	EngineRuntime,
	type OnStage,
	type RuntimeConfig,
	type RuntimeDeps,
	spawnEngineClient,
} from "./engine/runtime";
// --- the search surface + its option/return contracts ---
export {
	type BrowseOptions,
	createSearchEngine,
	type RecommendOptions,
	type SearchEngine,
	type SearchOptions,
	type SimilarOptions,
} from "./engine/searchEngine";
// --- the in-tab session profile, folded forward by interaction events ---
export {
	applyInteraction,
	buildProfile,
	emptyProfile,
	type SessionProfile,
} from "./engine/session";
// --- the SyncResult shape leaks through BootStage; expose its type only ---
export type { SyncResult } from "./gainratio";
