# @edgereco/browser

**EdgeReco's browser product engine.** It composes the standalone
[`@gainratio/browser`](https://github.com/hseshadr/edgeproc-browser) Lego for
signed sync, integrity, OPFS, Worker transport, and vector contracts, then adds
only EdgeReco's embedding, hybrid search, ranking, and session logic. No
application backend sits in the request path.

This is the engine the [Nimbus storefront demo](../../README.md) runs on. It
publishes the same wire format and the same scoring formula as the Python core
in [`src/edgereco/`](../../../backend/src/edgereco) — the two are top-k parity-tested
against the same committed bundle (see `src/engine/hybridParity.test.ts`).

> **Status:** private EdgeReco workspace package, not a general-purpose Lego and
> not published to npm. The reusable substrate is `@gainratio/browser`.

## TL;DR

```ts
import { EngineRuntime, configFromEnv } from "@edgereco/browser";

// In your SPA: spin up the sync + embedder Workers, pull and verify the signed
// bundle into OPFS, load the embedding model. Resolves with a SearchEngine.
const runtime = new EngineRuntime();
const engine = await runtime.bootstrap(configFromEnv(), (stage) => {
	console.log("boot stage:", stage.kind); // syncing | reassembling | loading-model | ready
});

const results = await engine.search("wireless headphones", { limit: 10 });
const recs = await engine.recommend({ limit: 10 }); // session-aware (folds in clicks)
```

`configFromEnv()` reads `VITE_BUNDLE_BASE_URL` (the Caddy edge serving the
signed bundle) and pins the public key to `<your-app-origin>/public.key` — the
key is **never** fetched from the bundle origin (that would defeat pinning).

## Parity with the Python core

The browser embedder is `Xenova/all-MiniLM-L6-v2` via
[`@huggingface/transformers`](https://huggingface.co/docs/transformers.js) with
`{ pooling: "mean", normalize: true }` — the byte-for-byte equivalent of the
Python core's `sentence-transformers` recipe. The browser imports the signed
products and `vector/embeddings.f32` matrix into ONE SQLite database
(`catalogueDb.ts`). The database comes from `@gainratio/browser/sql`, which runs
SQLite + FTS5 + sqlite-vector in its own Worker and persists it in OPFS;
`catalogueSql.ts` is the only file that imports it. On boot it also deletes
the old vector pool earlier builds left in OPFS. Keyword search is SQLite FTS5's
built-in `bm25()`, similarity is sqlite-vector's exact cosine scan, and the RRF
fusion (`k=60`) is one SQL query that returns both ranks and raw scores. No
hand-written BM25 or fusion code remains in the browser. The Python runtime uses
FAISS + rank_bm25 over the same producer rows, so keyword ranking now differs
slightly between tiers (FTS5 fixes k1=1.2, b=0.75); the parity tests pin how far
(`hybridParity.test.ts`). The rerank scoring formula
(`0.40·pop + 0.20·cat + 0.15·tag + 0.10·brand + 0.10·fresh − 0.25·rep`) still
matches `src/edgereco/` line for line.

## Architecture (three Workers, off the UI thread)

```
SPA tab
├── EngineRuntime.bootstrap(config)
│     ├── sync Worker   (@gainratio/browser)
│     │     └── pull /latest -> verify ed25519 -> fetch chunks ->
│     │         verify sha256 -> reassemble files into OPFS
│     ├── SQL Worker    (@gainratio/browser/sql, via catalogueSql.ts)
│     │     └── products + FTS5 + sqlite-vector -> one SQLite database in OPFS
│     └── embedder Worker (embedderWorker.ts)
│           └── load Xenova/all-MiniLM-L6-v2 (~25 MB) -> ONNX session
└── SearchEngine
      ├── search(q)       embed(q) -> one SQL query (FTS5 bm25 ⊕ cosine, RRF) -> session rerank
      ├── recommend()     popularity pool -> session rerank
      └── browse()        catalog listing
```

All Workers are lazy: the model is fetched only on the first `embed()`; the
bundle is fetched only on the first `bootstrap()`. After the first run the
bundle lives in OPFS and the model lives in the HTTP cache, so reloads are
near-instant and offline-capable.

## Package layout

- `EngineRuntime` / `RuntimeConfig` / `RuntimeDeps` — the bootstrap front door.
- `SearchEngine` / `createSearchEngine` — the search surface (`search`,
  `recommend`, `browse`). Built once over the synced bundle.
- `@gainratio/browser` supplies `EngineClient`, the sync Worker, OPFS storage,
  integrity verification, and the SQLite + sqlite-vector Worker adapter.
- `Product` / `SearchResult` / `ScoreComponents` / `InteractionEvent` — the
  domain types the engine produces. Same shapes as the Python core's wire
  contract.
- `applyInteraction` / `buildProfile` / `emptyProfile` / `SessionProfile` —
  the in-tab session profile, folded forward by each interaction event.
- `createEmbedder` — the default transformers.js-backed embedder, exposed so
  call sites that only want the embedder (e.g. server-side parity tests) can
  build one without a Worker.

The `./testing/fixtures` subpath exposes only EdgeReco's product parity fixtures.
Tests that need generic sync, storage, integrity, or vector seams import them
from `@gainratio/browser`; this package does not re-export or copy that substrate.

## Implementation notes

- **`pipeline as unknown as LoadFeatureExtraction` double cast in
  `src/engine/embedder.ts`.** transformers.js' `pipeline()` is overloaded over
  every task; the union explodes the TypeScript compiler (TS2590,
  "type instantiation is excessively deep"). The double cast collapses it to
  the one feature-extraction signature this module uses. Not a smell — keep it
  unless you upgrade to a transformers.js release that ships narrower types.

- **Embedder seam.** `RuntimeDeps.makeEmbedder` is the production seam for
  swapping the transformers.js embedder out — e.g. a stub for end-to-end
  tests that should not wait on the ~25 MB model download. Production
  passes the real Worker-backed embedder.
