# Python library, CLI and configuration

The browser demo needs no Python. This page is for the optional Python side: the same
search engine as a library, the `edgereco` command line tool, the API server, the
optional learning loop, and the settings both halves read.

Everything here runs from `backend/` after the setup in
[GETTING_STARTED.md](GETTING_STARTED.md) (Python 3.13, uv, then
`uv sync --group dev --reinstall-package assay-engine`).

## Why meaning matters: one search, two ways

An ordinary search box matches words. Search the 720-product demo catalog for
"something for my aching back" by words alone and you only get products whose titles
say "back". EdgeReco runs the word match and a meaning match, then merges them, so a
heating pad (whose title never says "back") joins the results.

This script runs both, on the committed signed catalog, in plain Python:

```python
# Save as backend/demo.py, then:
#   cd backend && EDGEPROC_ALLOW_MODEL_DOWNLOAD=1 uv run python demo.py
from pathlib import Path
from edgeproc.bundles.signing import Ed25519Verifier
from edgereco.api.deps import ServiceContainer
from edgereco.search.hybrid import reciprocal_rank_fusion

# Sync the committed signed catalog, verify it, and load the engine locally.
engine = ServiceContainer.from_synced(
    base_url=str(Path("examples/catalog").resolve()),
    cache_root=Path("/tmp/edgereco-cache"),
    verifier=Ed25519Verifier.from_public_bytes(
        Path("examples/keys/public.key").read_bytes()
    ),
)

query = "something for my aching back"
keyword = engine.keyword.search(query, k=30)                             # word matching
vector = engine.vector.search(engine.encoder.encode_query(query), k=30)  # meaning matching

print("keyword only:")
for pid, _ in keyword[:3]:
    print("   ", engine.by_id[pid].title[:60])

print("keyword + meaning, fused:")
for pid, _ in reciprocal_rank_fusion(keyword, vector)[:3]:
    print("   ", engine.by_id[pid].title[:60])
```

Real output (synthetic catalog, 26 Sep 2026):

```
keyword only:
    Kestrow Stadium Seat with Back Support | Extra Wide | Armres
    Vitalune Neck and Back Massager | 4 Heads | 20 Speeds | Quie
    Vitalune Neck and Back Massager | 6 Heads | 20 Speeds | Carr
keyword + meaning, fused:
    Kestrow Stadium Seat with Back Support | Extra Wide | Armres
    Calmora Electric Heating Pad | Extra Large | Auto Shut-Off |
    Vitalune Neck and Back Massager | 4 Heads | 20 Speeds | Quie
```

`EDGEPROC_ALLOW_MODEL_DOWNLOAD=1` lets edge-proc download the 23 MB language model once.
Without it, edge-proc refuses to touch the network and stops with `ModelNotLocalError`.
To use a model you already have, set `EDGEPROC_MODEL_PATH` to its folder instead.

## Hybrid search

Two retrieval methods run side by side and get merged.

**BM25** is the classic keyword score: it ranks products by how well their words match
the query's words. It is why "Bose QuietComfort Earbuds" comes back for "earbuds".

**Vector search** catches meaning. Each product title is turned into an **embedding**, a
list of numbers that places similar meanings close together. The query gets the same
treatment. The Python runtime searches with **FAISS**. The browser imports the verified
embedding matrix into **SQLite + sqlite-vector**, running in a dedicated Worker with its
database kept in OPFS (the browser's private per-site file storage). Both use exact
search (FAISS `IndexFlatIP` / a sqlite-vector full scan). That is fine for 720 products;
there is no approximate index yet.

The two lists are merged with **Reciprocal Rank Fusion** (RRF), which combines lists by
position rather than by score, so neither method's scale can drown out the other:

```
rrf_score = Σ 1/(k + rank_i)   summed over each method's rank for an item
```

## Session-aware re-ranking

After search, results are re-ordered for this shopper. Every interaction raises a
per-session affinity for the product's category, tags and brand, by a weight that grows
with intent:

| event | category | tag | brand |
|---|---|---|---|
| view | +0.02 | +0.01 | +0.02 |
| click | +0.10 | +0.05 | +0.08 |
| favorite | +0.20 | +0.10 | +0.15 |
| cart | +0.25 | +0.12 | +0.20 |

Affinities stop at 1.0. The last 50 viewed products carry a repetition penalty so the
row keeps showing new things. Each candidate is then scored:

```
score = retrieval
      + popularity_weight·popularity
      + category_weight·category_aff
      + tag_weight·tag_aff
      + brand_weight·brand_aff
      + freshness_weight·freshness
      + similarity_weight·similarity
      + cooccurrence_weight·cooccurrence
      − repetition_penalty_weight·was_recently_viewed
```

Assay (the scoring library) runs those nine terms in exactly that left-to-right order in
64-bit floats. The seven positive signals are weighted per strategy, retrieval has
weight 1, and repetition is the only subtraction. None of this touches the network: a
click updates the profile in the browser and the row re-orders on the spot. The activity
log stays in this browser until **Reset taste** clears it.

## Ranking is data, not code

The weights are not compiled in. They travel inside the signed catalog as
`ranking_config.json`, next to the "customers also bought" map (`cooccurrence.json`).
Retuning ranking means republishing data, with no code change, and both the Python and
browser halves pick it up on their next sync.

`RankingConfig` and `DEFAULT_RANKING_CONFIG` are not re-exported from any
`__init__.py`, so import them from their module:

```python
from edgereco.reco.ranking_config import RankingConfig, DEFAULT_RANKING_CONFIG

w = DEFAULT_RANKING_CONFIG.scoring_weights
print("popularity", w.popularity, "| category", w.category, "| tag", w.tag)
print("brand", w.brand, "| freshness", w.freshness, "| repetition", w.repetition_penalty)
print("strategies:", ", ".join(sorted(DEFAULT_RANKING_CONFIG.strategies)))

# Retune: a store that wants brand loyalty over raw popularity.
tuned = DEFAULT_RANKING_CONFIG.model_copy(
    update={"scoring_weights": w.model_copy(update={"brand": 0.30, "popularity": 0.20})}
)
print("tuned brand:", tuned.scoring_weights.brand)
print("valid config:", isinstance(tuned, RankingConfig))
```

Real output:

```
popularity 0.4 | category 0.2 | tag 0.15
brand 0.1 | freshness 0.1 | repetition 0.25
strategies: also_bought, because_viewed, for_you, frequently_bought_together, new_arrivals, similar_items, trending
tuned brand: 0.3
valid config: True
```

`RankingConfig` has four fields: `scoring_weights: ScoringWeights`,
`interaction_weights: InteractionWeights`, `schema_version: int` (currently 3), and
`strategies: dict[str, Strategy]`, the seven named strategies above, one per row on the
storefront.

`ScoringWeights` requires `popularity`, `category`, `tag`, `brand`, `freshness` and
`repetition_penalty`, and defaults `similarity` and `cooccurrence` to `0.0`, so an older
catalog reduces to the original formula exactly. Every weight must be `>= 0`, so a bad
weight in a signed config fails validation instead of quietly ranking badly:

```
ValidationError: Input should be greater than or equal to 0
  [type=greater_than_equal, input_value=-1.0, input_type=float]
```

## The learning loop (optional)

`make demo` makes zero backend calls. That is the default. Two more commands show the
optional loop that lets a store improve its ranking:

1. **Send activity up.** `poe demo-flywheel` adds a pretend cloud collector. Clicks are
   captured in the tab and sent in batches, without waiting for an answer. Signals are
   weighted by intent: a cart-add counts 4 times, a favorite 3 times, a click once, and a
   lingering view 0.2. Search and ranking still run entirely in the tab. Watch the
   `POST /events` requests and the "N interactions synced to cloud" badge.
2. **Learn and republish.** `poe demo-retrain` recomputes each product's popularity from
   the collected events, and the "customers also bought" map from the session log, then
   republishes a freshly signed catalog. Refresh the page and the rows re-rank toward
   what you clicked. The scoring formula and the language model do not change.

Re-signing needs the maintainer's private key, so step 2 works only for repo owners. The
published demo ships the result.

To preview what a retrain would change without doing it, run
`edgereco audit ORIGIN VERIFY_KEY --sessions LOG`. It prints event counts, the biggest
popularity movers and the changed "also bought" links. It never signs or publishes.

## Server-side variant: publish, sync, serve

The optional API server (FastAPI) is the same engine run on a server. The browser demo
does not use it. To reproduce the whole delivery loop with the CLI:

```bash
cd backend
uv sync --group dev --reinstall-package assay-engine

# 1. build a products.jsonl from a catalog CSV (same columns as examples/source/catalog.csv)
uv run edgereco build-catalog products.csv /tmp/staging/products.jsonl

# 2. build the vector index into the staging dir (the build machine may fetch the
#    embedding model; edge-proc refuses to unless told, or use EDGEPROC_MODEL_PATH)
EDGEPROC_ALLOW_MODEL_DOWNLOAD=1 uv run edgereco index /tmp/staging /tmp/staging

# 3. sign and publish a content-addressed catalog origin
uv run edgereco bundle /tmp/staging /tmp/origin examples/keys/private.key \
    --catalog-id amazon-demo --version v1 --product-count 720

# 4. serve by syncing that origin (a filesystem path works too) and verifying the key
EDGERECO_BUNDLE_BASE_URL=/tmp/origin \
EDGERECO_VERIFY_KEY_PATH=examples/keys/public.key \
EDGERECO_BUNDLE_CACHE_DIR=/tmp/bundle-cache \
EDGEPROC_ALLOW_MODEL_DOWNLOAD=1 \
    uv run edgereco serve /tmp/staging /tmp/staging --port 8000
```

The committed `backend/examples/catalog/` is already such an origin, so step 4 alone,
pointed at it, serves the demo data. The demo's private key is not committed; generate
your own key pair as shown in [QUICKSTART.md](QUICKSTART.md#5-index-a-fresh-catalog).

## CLI

```
edgereco build-catalog INPUT.csv OUTPUT.jsonl           # catalog CSV -> products.jsonl
edgereco preprocess INPUT.csv OUTPUT_DIR [--limit N]    # CSV with imgUrl/productURL/stars/reviews columns -> jsonl + manifest
edgereco index STAGING_DIR INDEX_DIR                    # build the vector/ index
edgereco bundle STAGING_DIR ORIGIN_DIR PRIVATE_KEY [--sequence N]  # sign + publish; N defaults to latest+1
edgereco serve CACHE_DIR INDEX_DIR [--host HOST] [--port PORT]
    # with EDGERECO_BUNDLE_BASE_URL + EDGERECO_VERIFY_KEY_PATH set, syncs + verifies a
    # signed bundle from that origin instead of reading the flat CACHE_DIR/INDEX_DIR.
edgereco search QUERY CACHE_DIR INDEX_DIR [--limit N] [--category CAT] [--json]
    # reads a flat preprocess-style dir (products.jsonl + manifest.json + vector/).
    # To search a signed bundle, sync it first, as in the Python example above.
edgereco retrain BUNDLE_BASE_URL ORIGIN_DIR PRIVATE_KEY VERIFY_KEY
    # the cloud half of the loop: sync, recompute popularity (from the collector's
    # --events-url) + co-occurrence (from a --sessions JSONL log), re-sign, republish.
    # Pure data transform; the scoring formula never changes.
    [--events-url URL] [--sessions LOG.jsonl] [--alpha 0.5] [--version V]
edgereco audit BUNDLE_BASE_URL VERIFY_KEY [--sessions LOG.jsonl] [--alpha 0.5]
    # read-only preview of what a retrain would change. Never signs or publishes.
```

`uv run edgereco --help` lists the same commands.

## Configuration

Both halves run on safe defaults, so configuration is opt-in. To see every setting, copy
the example files (nothing in them is a secret):

```bash
cp backend/.env.example backend/.env     # EDGERECO_* recommender + DEMO_* API vars
cp frontend/.env.example frontend/.env   # VITE_BUNDLE_BASE_URL + test tooling
```

Vite loads `frontend/.env` automatically. The backend reads `EDGERECO_*` from the
process environment, so export them first (`set -a && source .env && set +a`) or pass
them inline as in the steps above.

The settings that change what a shopper's browser does (read at build time):

| Variable | Default | What it changes |
| --- | --- | --- |
| `VITE_BUNDLE_BASE_URL` | `bundle` in the static build (same origin) | Where the signed catalog is fetched from. The public key is always read from the app's own origin, never from here. |
| `VITE_BUNDLE_ID` / `VITE_BUNDLE_CHANNEL` | `amazon-demo` / `stable` | The catalog identity the browser expects. Keep them stable, or returning shoppers refuse the new release. |
| `VITE_EVENTS_URL` | unset (learning loop off) | Where the optional learning loop sends batched clicks. Unset means nothing is sent. |
| `VITE_BASE` | `/` | The path the app is served under (for example `/<repo>/` on a GitHub Pages project site). |

Server-side secrets never go in the committed copies: the signing key
(`backend/examples/keys/private.key`) is gitignored, and the collector token is set with
`EDGERECO_EVENTS_TOKEN` in the environment. The recommender's `EDGERECO_*` settings
(model, `EDGERECO_RRF_K`, search limit, bundle URL and verify key) are listed in
[`backend/.env.example`](../backend/.env.example).

## Data and attribution

The repo ships two different catalogs:

| Catalog | Path | What it is |
| --- | --- | --- |
| Demo data | `backend/examples/catalog/` | A committed, signed bundle of 720 synthetic products (invented brands), 60 in each of 12 categories, so re-ranking visibly personalizes. Nimbus and the offline demo use this. |
| Synthetic API fixture | `backend/demo_server/catalog/products.jsonl` | 300 made-up products with made-up brands, used only by the optional FastAPI server. |

Synthetic demo catalog generated by backend/scripts/generate_catalog.py (MIT). Every brand and product in it is invented.
The generator assembles titles, feature bullets, prices and ratings from the committed
vocabulary in `src/edgereco/catalog/synthetic_vocab.json`; the same seed always gives
the same file. `scripts/rebuild_example_bundle.py --from-source` then runs
`edgereco build-catalog` and `edgereco index` and signs the bundle. See
[NOTICE](../NOTICE).
